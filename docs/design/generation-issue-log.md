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

---

## 已知观测点（未立案，等真实运行数据）

- 单页写入耗时偶发 12s+（疑 `serializedWrite` 与并发渲染验收排队）。
- 模型偶发空响应（final assistant text 为空），疑供应商侧截断；I-7 修复后如仍高频，再立案加重试策略。
