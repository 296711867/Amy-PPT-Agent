# 生成链路问题台账（Issue Log）

> 来源：真实运行日志与用户反馈（2026-08-30，《小马宝莉：星光熠熠角色介绍》系列运行）。
> 每条记录：现象 → 根因 → 修复 → 验证。修复后保留记录，便于回溯复发。
> 新问题按编号追加，不要删旧条目。

---

## I-1 整套 6/6 页被判"生成失败"，但页面 HTML 实际已落盘

- **现象**：`rendered page validation timeout (25000ms)` × 6 页 × 2 次尝试，deck 门禁把所有页标记失败，UI 报"部分页面生成失败（6/6）"；跨页一致性审查 `reviewedPages: 0`，标题带/页码/页脚无人统一。
- **根因**：隐藏校验窗口每次超时被销毁，下一页付完整冷启动（新 renderer + 294 个字体子集 + 运行时脚本）→ 恶性循环；且 timeout 被当作页面缺陷而非基础设施故障。
- **修复**（commit `ab9fd73`）：校验窗口跨页保活、`loadURL` 单独 15s 限界并主动 `stop()` 卡住的加载；`deck-render-gate` 把 `render validation timeout` 归为非阻断基础设施失败；跨页质量评估对已渲染页照常执行（不再全有或全无）。
- **验证**：`tests/unit/generation/deck-render-gate.test.ts` 超时降级用例。

## I-2 锁定版式页全部静默回退自由创作（封面/结尾风格跑偏的元凶之一）

- **现象**：`locked layout fill failed: 缺少 .ppt-page-root[data-ppt-guard-root="1"]; 缺少 .ppt-page-content`，每张锁定页都回退 creative。
- **根因**：7 个内置骨架与部分旧版骨架只有裸 `.ppt-page-root`，不满足落盘校验的页面契约；另有 `fillLayoutAsset` 克隆列表项插在 `</body>` 前（root 之外），快照/编辑器/导出都看不到。
- **修复**（commit `ab9fd73`）：骨架补壳 + `BUILTIN_LAYOUTS_VERSION` bump 到 2 重播种；`ensurePageShell()` 幂等兜底旧版/自定义骨架；克隆项改插 root 闭合标签前。
- **验证**：`tests/unit/layout-assets/fill.test.ts`。

## I-3 `data-anim="fade-in"` 非法值导致整页反复重试后失败

- **现象**：P3 三次尝试全死在 `data-anim 仅支持当前公开可编辑动画类型，非法值：fade-in`。
- **根因**：错误信息不含合法取值，重试反馈不可执行，模型重写同一个值。
- **修复**（commit `8433501`）：错误信息列出完整 `DATA_ANIM_SUPPORTED_TYPES` 白名单 + 具体改名提示；动画偏好 prompt 段落前置同一白名单。
- **验证**：`tests/unit/tools/html-utils-animation-sequence.test.ts`。

## I-4 用户要求占位图，但整套一个占位符都没有（第一层根因）

- **现象**：`imagePolicy: 'placeholder'` 正确传入，`page-images completed { durationMs: 1 }`，6 页 `image-placeholder` 数量为 0。
- **根因**：占位图只分配给 `layoutId` 自带图片槽的页面；大纲规划器不知道 deck 要图片，自由选择纯文字布局，`prepareDeckImageAssets` 成为空操作。
- **修复**（commit `8433501`，**不完整**）：`buildPlanningUserPrompt` 接收 `imagePolicy`，注入"必须选带图槽 layoutId"的硬性要求（列全目录图槽布局）。
- **遗留**：sourcePlan 路径绕过规划器，见 I-5。

## I-5 占位图仍然为 0：sourcePlan 路径绕过了规划器（I-4 第二层根因）

- **现象**：修复 I-4 后新一轮运行仍 0 占位符，新告警 `image policy set but no planned layout carries image slots` 触发（说明告警生效、规划仍无图槽）。
- **根因**：`canUseSourcePlanDirectly` 为 true 时 outline 来自 `mapSourcePlanToOutlineItems`（thinking 工作流的 sourcePlan），完全不经过 `planDeckWithLLM`，I-4 的 prompt 引导不生效。
- **修复**（本轮）：新增确定性分配 `ensureImageSlotLayouts`——当 `imagePolicy` 存在且内容页没有任何图槽 layoutId 时，为内容页（排除封面/结尾/目录意图）轮换分配 1/2/3 图槽布局；在 `diversifyUniversalLayoutSequence` 之前应用，生成与模板两条 flow 都接。
- **验证**：`tests/unit/generation/image-slot-assignment.test.ts`。

## I-6 "没有可用的生图模型，已跳过背景图"在占位模式下误导用户

- **现象**：用户已选"图片占位"（明确不生成图片），日志/状态栏仍报生图模型缺失警告，用户以为占位选择失效。
- **根因**：deck 背景图是独立增强项（`deckBackgroundPolicy`），不看 `imagePolicy`；无生图模型时以 `failed` 状态把告警推到 UI。
- **修复**（本轮）：`imagePolicy !== 'ai'` 时在 deck-flow 调用点直接跳过 AI 背景生成，只打 info 日志，不再向 UI 推送告警。
- **验证**：`tests/unit/generation/deck-background-policy-gate.test.ts`。

## I-7 "页面未写入：模型没有成功调用 update_single_page_file" 反复出现（观测盲区）

- **现象**：日志显示模型**确实调用了**写盘工具（tool_call → "正在写入对应 page 文件"），12 秒后判"页面未写入"，final assistant text 为空；重试反馈却说"模型没有成功调用工具"，误导模型与用户。
- **根因**：`writePageFile` 抛出非 `PageWriteValidationError` 的意外异常时，**没有任何日志**（tool_result 也不记录），`lastWriteValidationFailure` 捕获不到；模型收到工具错误后返回空回复，外层只能给出与事实相反的通用失败信息。
- **修复**（本轮）：page-writer 对意外异常补 `log.error`（含错误信息）并向模型 emit `写入失败` 状态；`extractWriteValidationFailure` 识别该标签，使重试反馈携带真实异常而非"没有调用工具"。
- **验证**：`tests/unit/generation/page-write-failure.test.ts` 追加用例。
- **遗留观测点**：12 秒延迟疑似 `serializedWrite` 与并发页的渲染验收排队，等下一次真实运行日志确认。

## I-8 锁定内置页不遵循 deck 设计契约（蓝色骨架混入手绘橙主题）

- **现象**：封面/结尾走锁定快速通道后仍是内置骨架的硬编码蓝色（#2F6BFF），与整套 design contract（如手绘秋日）严重撞色。
- **根因**：锁定快速通道直接落盘骨架，不做契约调色；`applyPalette` 只存在于版式控件的重填充路径且依赖预设色板。
- **修复**（本轮）：新增 `applyContractPalette`——收集页面 hex 色，按亮度排序映射到 `designContract.palette`（保持明暗次序），确定性替换；deck-flow 锁定快速通道接上。
- **验证**：`tests/unit/layout-assets/palette.test.ts`。

## I-9 `unknown-icon-id` 导致整页重试耗尽（P4 失败的直接死因）

- **现象**：P4《成长之路》三次尝试全死在 `unknown-icon-id: 未知图标 id "graduation"`（lucide 全集里是 `graduation-cap`），页面留 scaffold，1/6 失败。
- **根因**：与 I-3 同模式——校验错误信息只说"未知 id"不给候选，模型重试原样重写同一个简写 id。
- **修复**（本轮）：
  1. `resolveCloseIconId`：唯一前缀命中时在 `replaceDataIcons` 里确定性自动纠正（`graduation` → `graduation-cap`），多候选（如 `arrow`）不猜；
  2. 校验错误信息列出唯一纠正或模糊搜索候选（`可改用：xxx、yyy`），重试反馈可执行。
- **验证**：`tests/unit/presentation/data-icon-replacer.test.ts`、`page-quality-validator.test.ts`。

## I-10 锁定封面/结尾页把骨架示例文案原样发给用户

- **现象**：封面 kicker 显示"行业研究 · 2026"、subtitle 显示"副标题：一句话说明本次演示的核心主张"、footer 显示"汇报人 · 部门 · 日期"——全是内置骨架的示例文案，只有 title 被真正填充。这是"首页效果差"的直接原因（叠加用户关闭副标题设置后更显空洞）。
- **根因**：`fillLayoutAsset` 按 kind 推导填充（title/body/label/metric），kicker/subtitle/footer 被归为 label，而 deck-flow 锁定快速通道只传 title/body/listItems/metrics——label 槽永远拿不到内容，示例文案漏到最终产物。
- **修复**（本轮）：`LayoutFillContent` 新增 `slotText`（按 slotId 定向填文本、按槽位 maxChars 截断）；deck-flow 锁定填充传入 kicker=主题前缀（`小马宝莉：星光熠熠角色介绍` 取 `：` 前段）、subtitle=大纲第一个要点、footer=deck 标题。
- **验证**：`tests/unit/layout-assets/fill.test.ts` directed slot text 用例。

## I-11 锁定版式修复后，封面/结尾质量断崖式下降（"和之前差距很大"的直接原因）

- **现象**：用户反馈生成效果大幅变差。核查 17:44 会话：封面/结尾是 1.7KB/1.4KB 的极简骨架页（对比 LLM 创作页 ~344KB），且骨架示例文案（"行业研究 · 2026"、"副标题：一句话说明…"）原样出货；内容页正常。
- **根因（两层）**：
  1. 会话开启了"锁定版式"开关，但 I-2 修复前锁定填充因缺壳 bug **从未真正生效**（全部静默回退 AI 自由创作）——用户此前看到的封面/结尾一直是 LLM 画的。I-2 修好后锁定真正接管封面/结尾，内置 cover/ending 骨架（示意级结构）撑不起这两页的设计要求，观感骤降。
  2. 该次运行的应用主进程未重启，I-10（定向填 kicker/subtitle/footer）尚未生效，模板示例文案继续出货。
- **修复**（本轮）：封面/结尾从锁定快速通道剔除（`filterCoverEndingLockedAssignments`：intent=cover 或末页 → 不锁定，交还 LLM 创作）；锁定的确定性价值保留给内容页。内置 cover/ending 骨格若要重回快速通道，需要先升级到设计完整的骨架。
- **验证**：`tests/unit/generation/locked-assignment-guard.test.ts`。
- **运维提示**：dev 模式下主进程改动需要重启应用才生效——本轮 15:35 的 I-9/I-10 修复在 17:44 的运行中仍未加载（日志中无 `corrected unknown icon id`、封面仍带示例文案）。

## I-12 页面规划过浅且页数漂移被空白页掩盖

- **现象**：生成内容像“主题卡片集合”，结构化要点的指标和解释被压掉；模型少返回页面时系统用“第 N 页 + 空大纲”补齐，最终页面缺少可执行内容。
- **根因**：规划只强制 title/keyPoints/layout 字段，`visualFormat` 和页面认知目标没有成为有效性条件；大纲总长 260、单点 32 字的过早截断丢失论据；页数不足被静默 padding。
- **修复**（本轮）：deck/page planner 强制 `visualFormat` 与 `audienceMove`，`audienceMove` 统一为 `before → after`；结构化要点进入 Prompt 时保留 claim/metric/detail；大纲上限调整为 720、单点 72；Deck 页数不精确时带反馈重试，不再补空页。
- **验证**：`deck-planner.test.ts`、`page-planner.test.ts`、`outline-normalizer.test.ts`、`structured-content.test.ts`。

## I-13 重试、编辑和美化后页面语义计划丢失

- **现象**：初次规划有明确视觉形式，经过失败重试、整套编辑、风格切换或一键美化后，后续页面只剩标题/HTML，容易退化回通用卡片布局。
- **根因**：`generation_pages` 没有完整保存视觉形式与观众认知目标；多个 completed/failed 回调只传 `contentOutline`/`layoutIntent`，Deck 评审失败回写还会用空值覆盖原计划。
- **修复**（本轮）：`generation_pages` 增加 `visual_format`、`audience_move`；生成、模板、新增页、重试、单页/整套编辑、风格切换、一键美化和 Deck 评审失败路径统一传递完整页面计划包。
- **验证**：`generation-run-repository.test.ts`、`deck-review-events.test.ts`、`edit-deck-allpage-flow.test.ts`、`style-switch-job-flow.test.ts`、`page-beautify-job-guard.test.ts`、`source-grounding.test.ts`。

## I-14 GLM 5 空回合被误判成“没有调用写盘工具”

- **现象**：部分兼容 OpenAI 的 coding 端点随机只返回思考、没有正文和 tool call，页面立即消耗完整重试；错误文案却声称模型没有成功调用工具，无法区分空回合与写入失败。
- **根因**：对 GLM 5+ 发送了供应商不支持的 `thinking.type=disabled`；流处理只保留最终文本，没有保留主图会话和工具调用信号，无法在同一会话继续。
- **修复**（本轮）：GLM 5+ 不发送关闭思考参数；Agent stream 收集主图会话消息与工具调用信号；空回合在同一会话最多续跑 2 次，再进入完整页面重试；最终正文含 HTML 时仍走统一 page-writer 验证后救援落盘。
- **验证**：`openai-model-options.test.ts`、`agent-stream-processor.test.ts`、`page-write-failure.test.ts`。

## I-15 模板会话传入大纲后从未开始生成，直接展示模板原页

- **现象**：用户从模板库"创建并生成"，填入标题/页数/大纲后落地的是模板原版页面；数据库中该会话 0 条消息、0 个 generation run、14 页全部 `completed`（即导入时的模板页原样）。
- **根因（两层）**：
  1. `session:get` 的 `recoverUsableSessionPages` 把"pending + HTML 可校验"的页面恢复为 completed——它面向"生成被中断"的场景，但模板会话在首次生成前就带 pending + 已落盘模板页，属于设计状态；刚创建就被全部"恢复"成 completed。
  2. 生成页 `fullyGenerated`（全部 completed）为真时直接重定向到编辑页，且该守卫不检查 `hasManualStartIntent`——即使路由 state 带着用户大纲也照样跳走，`startRun` 永不执行。
- **修复**：`shouldRecoverSessionPages` 门控——只有存在 generation run/job 历史（真正开始过生成）且当前无活跃 run 才允许恢复；渲染端三处重定向守卫补上 `!hasManualStartIntent`。
- **验证**：`tests/unit/session/page-status-recovery.test.ts`；真实运行复现修复后模板生成正常启动（2026-09-03 运放会话 15 页规划完成、逐页写盘）。

## I-16 模板链路生成选项不可定义且会丢失/误注入

- **现象**：用户反馈"用模板很多东西都不能定义"。核查确认三层缺口：
  1. 大纲只存在路由 state：取消生成或重启应用后 outline 彻底丢失（I-15 会话即无任何消息留存）；
  2. 动画偏好断链：`startTemplateGenerate` payload 不带 `animationPreferences`，模板 runner 调用也不传，run 不持久化、重试不继承；
  3. 配图误注入：`normalizeImagePolicy(undefined) → 'placeholder'`，模板会话默认被 `ensureImageSlotLayouts` 强塞图槽版式并被 `prepareDeckImageAssets` 挂占位图，与"模板页基底即视觉事实"冲突，且用户无法选择不要配图。
- **修复**：
  1. `templates:createSession` 接收 `initialPrompt`/`imagePolicy` 并写入会话元数据（`templateInitialPrompt` 截断 24k）；生成页在路由 state 缺失时用元数据兜底恢复手动开始意图；
  2. `animationPreferences` 贯穿模板链路：对话框 UI（复用 AnimationPreferenceChips）→ startTemplate payload → run 持久化 → 模板重试从最近 run 继承 → runner 传给单页生成；
  3. `ImagePolicy` 增加 `'none'`：不注入配图、不强制图槽版式、不触发"要图不给图"告警；模板链路默认 `'none'`（沿用模板视觉），对话框提供 沿用模板视觉/占位图/AI 配图 三选。
- **验证**：`tests/unit/shared/image-policy.test.ts`、`tests/unit/generation/deck-images.test.ts`（'none' 不注入）、`tests/unit/generation/image-slot-assignment.test.ts`（'none' 不换版式）、`tests/unit/templates/template-generation-options.test.ts`（链路契约）。
- **设计边界**：字体、AI 背景、视觉元素侧重不在模板对话框暴露——模板页基底是视觉事实来源，这些选项在模板链路本就不生效，暴露即撒谎；后续若要支持需先定义"模板视觉 vs 用户覆盖"的优先级契约。

## I-17 模板页整体重写导致“结构分区骤降”整页重试耗尽

- **现象**：真实模板运行（LED 模板 → 运放大纲）中多页连续死在 `模板结构被破坏：结构分区从 N 个骤降到 1 个`，2 次尝试后判失败。检查落盘前页面：PPTX 导入的模板页由 8–17 个绝对定位顶层容器组成（背景 figure、logo、标题块、条目块、1px 装饰线条各算一个分区）。
- **根因（两层）**：
  1. 模型把模板页当“设计参考”整体重写：要么合并成一个包裹 div，要么自带 `<main>` 包裹片段——`normalizeCreativePageFragment` 会把模型自带 main 再包一层，顶层分区恒为 1；
  2. 提示词只说“保留视觉系统”，没教**原位编辑**策略（保留容器树、只换文字、条目不够克隆容器、禁止自带 main），重试反馈也不可执行，模型反复重犯同一写法。
- **修复**：
  1. `TEMPLATE_SYSTEM/ single-page PROMPT_ADDENDUM` 与 `update_template_page_file` 工具描述明确 edit-in-place 策略：顶层容器保持直接平级、只替换容器内文字/数据、条目增减用克隆/删除、禁止自带 `<main>` 包裹；
  2. `page-writer-core` 的 template-skeleton 失败反馈同步给出上述可执行步骤（含“把模板顶层容器作为 content 直接子元素”）。
- **验证**：`tests/unit/templates/template-generation-options.test.ts` edit-in-place 契约用例；真实运行待续跑确认（观测点：模板页结构分区校验通过率）。

## I-18 熔断跳过的模板页被收尾循环误标 completed（"看起来完成、内容没换"）

- **现象**（2026-09-03 23:39 续跑 run `35ba9518`，会话 a4ac3abe）：
  - 收尾报告 partial 2/15（仅第 4、5 页 `MODEL_TIMEOUT` 失败），会话显示 13/15 完成、可进编辑器；
  - 但用 `templateSeedFingerprints` 逐一核对落盘文件：**15 页中只有 1、2、3 页被真正改写**；第 6–15 页 sha1 与种子指纹完全一致（未动过的模板基底），可见文本仍是 LED 原文（如"灵活应用恒流型LED产品 AiP33628"规格表），而侧栏标题用的是运放规划标题——形成"标题已换、正文没换"的假完成；
  - 日志量化：整个 run 只有 6 次写盘动作、4 个 page_generated/failed 事件；23:59:58 第 4 页 `MODEL_TIMEOUT` 触发 `system failure opened page generation circuit`（occurrences: 1 即开闸）。
- **根因（三层）**：
  1. **收尾循环误判（直接死因）**：`src/main/generation/template-deck-flow.ts` 收尾循环的 `if (!persistedGeneratedPagesById.has(pageRef.pageId))` 分支——只要页面 HTML 通过静态校验就直接 upsert `status: 'completed'`。模板会话的种子页 HTML 天然通过校验（`isPlaceholderPageHtml` 也检不出），于是"从未被尝试"的页面被静默判完成。
  2. **熔断跳过页在 runner 账目中消失（上游漏洞）**：`MODEL_TIMEOUT` 打开 page generation circuit 后，剩余排队页面被直接跳过——既不进 `failedPages` 也不进 completed 回调，run 汇总把它当成功页交回收尾循环。每页结局必须二选一（completed/failed），被熔断跳过应记为 failed（如 `生成被熔断跳过`）。
  3. **熔断阈值过敏感（诱因）**：`occurrences: 1` 即开闸，15 页模板 run 遇到一次 GLM 超时就放弃剩余 11 页；对超时/限流类瞬时故障应计数累积（如 2-3 次）或只对同类连续失败开闸。
- **修复方向（给后续实现者）**：
  1. 收尾循环加"真实改写"校验：模板会话读 `templateMetadata.templateSeedFingerprints`（I-15 已持久化，sha1 前 12 位），当前 HTML 指纹 === 种子指纹 → 记 `postValidationFailures`（reason：`页面未被生成改写（仍为模板基底）`），不得 completed。种子指纹缺失的老会话可回退为"HTML 与最近一次 generation_pages 快照无关 + 无 completed 回调 → failed"。
  2. 排查 `runDeepAgentDeckGeneration`/`single-page-generator` 的每页账目：circuit-breaker 跳过、空回合耗尽、写入拒绝重试耗尽都必须落到 `failedPages`，不允许第三种结局。
  3. 评估熔断开闸阈值对超时类故障的敏感性（MODEL_TIMEOUT 一次即断是否合理）。
  4. 修完后把会话 a4ac3abe 的第 4–15 页重置 pending 再续跑验证；`1c3b365e`、`0aa09940` 两个旧会话同样只含种子页，也应重置。
- **验证建议**：定向测试收尾循环（构造：3 页 rewritten + 12 页 seed 指纹不变 + runner 返回 2 failed → 期望 3 completed + 14 failed，断言无 seed 被标 completed）；复跑真实模板 run 后用指纹脚本核对每页 rewritten。
- **修复**（2026-09-04）：
  1. 模板 completed 回调与收尾循环统一使用 `templateSeedFingerprints`；未观测到 completed 回调的页一律失败，种子指纹一致时明确记为“页面未被生成改写（仍为模板基底）”，删除“静态校验通过即补 completed”的分支。
  2. `agent-runner` 将熔断后未派发页全部加入 `failedPages`，发出 `page_failed` 并调用 `onPageFailed`，runner 不再留下无终态页。
  3. 可重试系统故障改为同指纹累计 2 次开闸；不可重试的鉴权、额度和存储故障仍第 1 次立即开闸。
- **验证**：`tests/unit/generation/generation-circuit-breaker.test.ts`、`tests/unit/generation/agent-runner-circuit-outcome.test.ts`、`tests/unit/templates/template-page-outcome.test.ts`、`tests/unit/templates/template-generation-options.test.ts`、`tests/unit/session/page-status-recovery.test.ts`，共 19 个用例通过；Node typecheck 通过。真实会话复跑与指纹脚本核对待应用重启后执行。
- **真实验收**（2026-09-04 至 2026-09-05）：run `3e6062d7` 在熔断时把未派发的 P14/P15 明确记为 failed，没有补成 completed；随后 run `b84e0267` 只调度剩余 P9/P13/P14/P15，最终 `run_completed { completedPageCount: 15, failedPageCount: 0 }`。逐页比较会话元数据中的模板种子 SHA1：**15/15 均已改变**；全套 HTML 对 `AiP33628/LED驱动/数码管驱动` 命中 0；`session_pages` 为 15/15 completed。
- **状态**：已修复并通过真实模板续跑与种子指纹验收。

## I-19 模板生成每页重复读取通用布局技能，渲染验收持续超时仍逐页等待

- **现象**（run `35ba9518`）：3 个成功页分别耗时约 220s、316s、398s；每页写回后隐藏浏览器验收都连续两次 `render validation timeout (25000ms)`，固定额外等待约 51s。模板单页 Agent 还会读取约 23KB 的 `amy-ppt-layout`，尽管目标模板页已经定义版式骨架。
- **根因**：渲染基础设施已经确认持续不可用后没有短期熔断，后续页仍重复支付两次超时；模板模式复用了创意生成提示词中的通用 layout-skill 强制读取规则，与“模板页是视觉事实来源”的契约重复。
- **修复**：
  1. 渲染验收连续两次超时后进入 60 分钟冷却；冷却期间后续页立即返回可观测的 infrastructure-unavailable 结果，继续按既有规则保留静态校验通过的页面；冷却结束后自动探测恢复。
  2. 模板生成的画布、语义结构和碰撞提示不再要求读取通用 layout skill，直接使用已读取的目标模板页；普通生成与编辑路径保持原规则，图表、动画和源文档技能仍按实际能力使用。
- **验证**：`tests/unit/presentation/rendered-page-validator.test.ts`、`tests/unit/agent-runtime/deck-prompt-template.test.ts` 及 I-18 相邻测试，共 6 个文件、22 个用例通过；Node typecheck 与 `git diff --check` 通过。真实续跑需观察 `rendered page validation skipped during timeout cooldown`、模板页不再调用 `amy-ppt-layout`，并记录逐页 `elapsedMs`。
- **真实验收**（2026-09-05，run `b84e0267`）：超时后其余页面与 Deck 评审均立即记录 `rendered page validation skipped during timeout cooldown`，未再逐页支付 51 秒；模板页未读取 `amy-ppt-layout`。P14 从 66KB 可编辑片段生成并落盘耗时约 281 秒，P15 约 107 秒。
- **状态**：已修复并通过真实续跑。

## I-20 模板绝对定位分区被通用页面 gutter 规则误杀

- **现象**（run `a87169eb`）：P5 已调用 `update_template_page_file`，但写盘前一次性报出多个 `padding-below-floor`；命中的都是模板原有顶层绝对定位 `<section>`，其 `padding: 0/36/42px` 被当成整页内容 gutter，页面随即进入重复生成。
- **根因**：padding 门禁把 `main[data-role="content"]` 的每个直接子元素都当作页面内容根容器；PPTX 导入模板恰好以多个绝对定位分区作为直接子元素，其安全区由 `left/right/width` 坐标决定，而不是每个分区各自的 padding。
- **修复**：`validatePageQuality` 增加模板布局上下文；仅在 `preserveTemplateSkeleton` 模式跳过顶层 `position:absolute/fixed` 分区的 gutter 检查。普通生成、模板中的流式根容器以及 emoji/字号等其他门禁保持不变。
- **验证**：`tests/unit/presentation/page-quality-validator.test.ts` 同时断言同一低 padding 绝对定位结构在普通模式被拦截、模板模式放行；相邻 persistence 测试共 49 个用例通过。真实续跑需确认写盘不再因模板原始 padding 重试。
- **真实验收**（2026-09-04 至 2026-09-05）：P4–P15 的模板绝对定位分区均通过写盘质量门禁，没有再出现 `padding-below-floor` 重试。
- **状态**：已修复并通过真实续跑。

## I-21 模板 Agent 读取完整运行时页面，输入体积放大并诱发 10 分钟超时

- **现象**（run `3e6062d7`）：模板页 `read_file` 返回 16KB–73KB；17KB 页约 146 秒完成，69KB 页约 336 秒，复杂页 P9/P12 达到 10 分钟 `MODEL_TIMEOUT`。P13 在读取 31KB 后空回合续跑时又重复读取同一完整文件。
- **根因**：模板 Agent 只需原位编辑创意容器，却读入整份落盘 HTML，包括 `<head>` 资源、page guard CSS、fit/runtime 脚本和外层 scaffold；这些内容既不能作为写盘工具输入，也显著增加模型输入与注意力负担。
- **修复**：`GuardedFilesystemBackend` 仅对当前模板目标页的 `read_file` 返回 `.ppt-page-content main[data-role="content"]` 的内部片段；其他文件、普通生成和编辑读取保持原样，完整磁盘文件仍用于模板骨架校验和最终落盘。渲染超时冷却由 10 分钟延长到 60 分钟，覆盖典型长 deck run，同时保留下一轮自动恢复探测。
- **验证**：`guarded-filesystem-backend.test.ts` 断言返回绝对定位创意容器且排除 runtime/scaffold；真实失败页续跑对比 `tool_result.contentLength` 与 `elapsedMs`。
- **真实验收**（run `b84e0267`）：P9 的 `read_file` 从完整页约 26KB 降至 13KB（-50%），P13 从约 31KB 降至 18.5KB（-41%）；读回内容不含 runtime/scaffold。复杂模板自身的可编辑片段仍可达 66KB，属于后续模型输出成本上限。
- **状态**：已修复并通过真实续跑。

## I-22 写盘成功后的模型超时仍把页面判失败并触发熔断

- **现象**（run `5d698eee` P12）：8:58 时 `update_template_page_file` 已写入页面，渲染验收又等待约 51 秒；工具结果返回后模型尚未来得及发最终回复，整次调用在 10:00 报 `MODEL_TIMEOUT`。该页被标失败，并作为第二个同指纹超时打开熔断。
- **根因**：`single-page-generator` 只在 Agent stream 正常结束后读取页面并计算 `pageCommitted`；stream 抛错分支直接 `break`，没有检查工具是否已经完成磁盘提交，因此“写盘后尾声超时”和“从未写盘超时”被混为一类。
- **修复**：stream catch 中先重新读取目标页并比较提交；只要页面已真实改写，保留成功结果并忽略尾随 stream 错误。未写盘时仍原样抛错、进入重试与熔断统计。
- **验证**：`post-write-timeout.test.ts` 锁定 catch 后重读提交、仅在 `!pageCommitted` 时抛 stream 错误的契约；真实 P12 重试需确认写盘后即 `page_generated`。
- **真实验收**（run `b84e0267`）：P9/P14/P15 均在写盘后进入 `page_generated`；最终 run 为 completed，4/4 重试页完成。未再出现“已落盘却计为 MODEL_TIMEOUT”。
- **状态**：已修复并通过真实续跑。

## I-23 单页写盘工具强制 pageId，模型省略后整页成果被拒

- **现象**（run `b84e0267` P9，08:45:27）：模型已输出完整模板片段并调用 `update_template_page_file`，但参数只有 `content`；Zod 在工具执行前以 `expected string, received undefined → pageId` 拒绝，页面白耗约 9 分钟后整轮重试。
- **根因**：该工具只在锁定单页上下文暴露，目标页已经由 `selectedPageId/allowedPageIds` 唯一确定，却仍把重复的 `pageId` 声明为必填；模型漏填无歧义字段被当成越权错误。
- **修复**：单页写盘工具允许省略 `pageId`，省略时绑定唯一目标页；若显式传入仍必须与锁定页一致，跨页写入保护不变。
- **验证**：`single-page-writer-schema.test.ts`；同一真实 run 的 P14/P15/P9 后续调用均只传 `content`，分别正确写入各自锁定页面。
- **状态**：已修复并通过真实续跑。

## I-24 常见动画别名可确定修正，却仍消耗整页模型重试

- **现象**（run `b84e0267` P9，08:54:03）：第二次完整输出只因 `data-anim="fade-in"` 被门禁拒绝，再次启动单页 Agent；该问题此前 I-3 只改善了错误提示，没有消除可确定的重试。
- **根因**：`fade-in` 是模型/CSS 生态常见写法，与产品公开动画 `fade` 语义等价；写盘预处理未做该无歧义别名归一化。
- **修复**：生成写盘的单次 Cheerio 预处理将 `data-anim="fade-in"` 归一为 `fade`，其余未知动画仍由权威白名单拒绝。
- **验证**：`page-writer-slide-size.test.ts` 定向用例；P9 第三次写盘成功。新修复将在后续 run 避免为该别名单独重试。
- **状态**：已修复并通过单测，真实触发前一轮已完成。

## I-25 文本型 Coding 接口仍执行截图与视觉模型调用

- **现象**（run `b84e0267` 收尾）：应用先等待约 16 秒生成评审截图，随后向 GLM Coding endpoint 发送 `image_url`，接口返回 `400 messages.content.type 参数非法，取值范围 ['text']`，视觉自检只能跳过。
- **根因**：视觉评审在截图前不检查 endpoint 能力，只有实际发送图片后才从 400 降级。
- **修复**：识别 `/api/coding/paas/` 文本型 endpoint，在截图队列和模型调用之前直接跳过并给出准确提示；其它 endpoint 仍沿用原视觉评审路径。
- **验证**：`visual-review.test.ts` 断言已知文本型 Coding endpoint 不调用截图、不调用模型。
- **状态**：已修复，待下一次使用该 endpoint 的生成收尾确认。

## I-26 可编辑 PPTX 导出破坏模板背景层级，并把纯色背景误判为文本残留

- **现象**（2026-09-05，运放 15 页会话）：初次导出的 `.pptx` 中封面和结尾近似空白，第 11 页部分内容块丢失；另有第 5、8、10 页被降级成整页位图，失去可编辑文本。源 HTML 和编辑器预览正常，问题只出现在 PPTX 导出结果。
- **根因（两层）**：
  1. PPTX 导入模板中的全页、贴边 `<img>` 是静态背景，但导出器同时把它留在背景截图中、又作为独立图片覆盖到 PPTX 页面最上层。DOM 中原本位于该图片之上的标题、色块和结束页文字因此被遮住。
  2. 文本残留检测仅按背景截图的非透明像素占比判断。纯色或大面积填充背景的占比接近 1，被误判为“文本仍残留在背景图”，触发整页栅格化降级。
- **修复**：
  1. 复用 `isPptxStaticBackgroundShape` 识别全高、贴边的静态背景图片；这类图片保留在背景合成中以维持 DOM 层级，不再额外导出成顶层独立图片。普通内容图片仍按可编辑图片导出。
  2. 浏览器侧给静态背景图片标记 `data-pptx-static-background-image`，从背景截图的隐藏选择器中排除。
  3. 文本残留检测增加均匀填充上限：只有非透明像素占比位于实际字形残留区间时才判失败；接近整页的均匀底色不再触发栅格降级。
- **验证**：`tests/unit/html-pptx/static-background.test.ts`、`browser-scripts-animation.test.ts`、`text-residue.test.ts`；HTML-PPTX 定向套件 10 个文件共 69 个用例通过（另 9 个按环境跳过），Node typecheck 与 `git diff --check` 通过。重启应用后重新导出并渲染检查 15/15 页：封面、结尾和第 11 页层级恢复；每页均包含可编辑文本节点，第 5/8/10 页不再误降级；仅第 15 页复杂 transform 按既有规则保留在背景合成中。
- **验收产物**：`【Fixed-Editable】PPT_ 运放的种类介绍与参数讲解.pptx`，15 页，SHA256 `B66567ED2BCA7A9D3AA3DAE07DD562F9DD35BB163881D04ACB03A055A5BB246B`。
- **状态**：已修复并通过真实文件导出、结构检查和逐页渲染验收。

---

## 已知观测点（未立案，等真实运行数据）

- 单页写入耗时偶发 12s+（疑 `serializedWrite` 与并发渲染验收排队）。
- 模型偶发空响应（final assistant text 为空、无工具调用，15:18:29 / 15:20:34 两次），重试即恢复；疑供应商侧截断或内容过滤。I-7 的观测日志已就位，若高频再立案。
- 15:21 会话中 P2 的一次"未写入"判罚出现在写盘工具开始执行之前（日志时序 29.589 判罚 → 29.966 工具调用记录），双 worker 并发日志交错下尚未定论，待复现。
- 2026-08-30 15:18 会话验证：I-5 占位图（P2/P3/P5 各 1/2/3 个）、I-8 调色（locked 页紫色主题）、I-6（无背景图误报）均已生效。
