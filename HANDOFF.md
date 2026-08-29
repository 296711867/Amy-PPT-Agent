# Amy-PPT 项目上下文与交接文档

> 更新时间：2026-08-29 · 当前版本 **1.0.4**
> 本文件面向接手开发/协作者：项目全景、近期演进、打包发布 SOP。新 Agent 会话开始时优先读本文件，再按需查阅 `README.md`、`PROJECT_STRUCTURE.md`、`AGENTS.md`。

---

## 1. 项目关键事实

| 项           | 值                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| 产品名       | Amy-PPT（前身 oh-my-ppt）                                                                                |
| 类型         | Electron 桌面应用，AI 生成 PPT                                                                           |
| GitHub 仓库  | `296711867/Amy-PPT-Agent` ⚠️ **已从 `Amy-PPT` 改名**                                                     |
| 最新 Release | [v1.0.4](https://github.com/296711867/Amy-PPT-Agent/releases/tag/v1.0.4)，已发布（非 draft），带更新说明 |
| 安装包       | `amy-ppt-1.0.4-setup.exe`（161.7 MB）已上传，公开下载链接验证 HTTP 200                                   |
| 包管理器     | pnpm 10.10.0（用 Corepack 激活；`node scripts/check-toolchain.mjs` 可诊断环境）                          |
| 测试         | Vitest + happy-dom，`pnpm test`，单文件 `pnpm test -- tests/unit/xxx/foo.test.ts`                        |

## 2. 架构总览

- **主进程** `src/main/`：生成编排、IPC、版式资产、导出
- **渲染进程** `src/renderer/`：React UI，路径别名 `@renderer/*`、`@shared/*`
- **共享类型** `src/shared/`

### 核心链路（改公共规则时三条都要确认）

1. **生成链路**：`src/main/generation/deck-flow.ts`（~1400 行，主编排）→ `agent-runner.ts`（~1800 行，LLM 编排 + 重试；规划类逻辑已拆入 `generation/planning/`：`deck-planner` / `page-planner` / `design-contract-builder` / `model-response`（LLM JSON 解析），流处理拆入 `agent-stream-processor.ts`）
2. **编辑链路**：整页编辑、deck 编辑、selector 编辑（`edit-flow.ts`、`retry-flow.ts`、`page-merge-*`）
3. **运行时资源**：session asset 兼容/刷新机制

### 数据层（2026-08 拆分，门面 + 仓库模式）

- `db/records.ts` — 全部行类型与字符串联合类型（`SessionJobKind` 等），`database.ts` `export *` 兜底旧导入路径
- `db/repositories/` — 9 个仓库类（config / project / html-editor / image-generation-history / session-style-snapshot / thumbnail / user-preference / **generation-run** / **session-page**），按表聚合 CRUD；生成运行/任务/页面与会话页面/源骨架已全部下沉
- `db/services/` — 跨仓库业务（`session-style-snapshot-service`）
- `db/database.ts`（2039 行，原 3758）— `PPTDatabase` 门面：持有仓库实例、委托调用，session 核心/事件/操作历史/消息记忆/样式等仍在门面内
- 迁移仍在 `db/patch/index.ts`（~1650 行，不要动历史 patch）

### 会话详情页组件树（2026-08 拆分）

- `pages/session-detail.tsx`（1270 行，原 1894）只做组装
- `components/session-detail/`（98 个文件，~16k 行）：`hooks/`（14 个：生成事件 `useSessionGenerationEvents`、生命周期、任务恢复、聊天控制器、导出/图片操作等）、`ai-panel/`、`workspace/`、`preview/`、`sidebar/`、`browse/`、`style/`、`speech/`、`toolbar/`、`modal/`、`element-inspector/`、`shared/`
- `components/presentation-webview/` — `PreviewIframe` 与 `HtmlEditorCanvas` 共享的预览 URL/运行时注入工具（`webview-utils.ts`、`usePresentationWebviewRuntime`）
- ⚠️ 源码断言类测试（读源文件文本的）在代码搬家后要同步改读新路径，见 `tests/unit/prompt/source-grounding.test.ts` 等的写法

### 版式资产系统（参考 dashi-ppt-skill 采用）

- `src/main/layout-assets/parametrize.ts` — 插槽参数化引擎，`data-block-id` HTML → 内容 slots；企业过滤（<80px logo、<14px 页眉页脚跳过）
- `src/main/layout-assets/fill.ts` — 确定性填充（零 LLM），`contentPackageToFill()`、`blankMetricSlots()`
- `src/main/layout-assets/library.ts` — 版式库存储 + 版本化播种
- `src/main/layout-assets/builtin.ts` — 7 个内置版式
- 锁定版式模式：结构化内容（OutlineItemData：value/unit/displayValue/priority）确定性填充进模板版式

### 插件化架构（参考 deepseek-harness 采用，纯 TS 模式无框架）

- `src/main/agent-runtime/registry/provider-registry.ts` — 提供者注册表
- `src/main/agent-runtime/registry/providers/` — 7 个自注册提供者：anthropic、openai、openai-responses、google、zhipu、deepseek、kimi
- `src/main/generation/generation-events.ts` — 8 个生命周期事件的类型化事件总线
- `src/main/generation/session-event-log.ts` — 追加式审计日志
- `src/main/generation/workflow-telemetry.ts` — 按阶段计时（12 个阶段）
- `src/main/config/profile.ts` — YAML profile

## 3. 本阶段完成的工作（时间线）

1. **GLM-5.2 兼容**：无角色 ChatMessageChunk 被 `isAssistantMessage` 接受
2. **关闭崩溃**：webContents 销毁后读 `window.webContents.id` → 创建时捕获 id
3. **速率限制弹性**：429/503/502 → `MODEL_RATE_LIMIT`，15/30 秒共享退避 + 并发降级；错误消息显示真实原因（不再是统一的"页面结构检查未通过"）
4. **磁盘写满修复**：`writeLayoutManifest` ↔ `ensureLayoutLibrary` 无限递归写 47 万文件 → 去掉 ensure 调用
5. **UI 主题统一**：5 主题（sage/studio/coral/pastel/midnight），~60 个语义 CSS 变量，含主题奇偶校验测试
6. **版式资产系统**（见上）
7. **DeepSeek + Kimi 提供者接入**
8. **提示词去重**（10 个共享规则只留 system）+ 背景生成与版式分配并行化
9. **插件化架构**（见上）
10. **视觉元素偏好**：会话创建 UI 3 组 × 4 级按钮（图表/图像/表格），`VisualElementPreferences` 注入规划提示词
11. **企业模板工作流**：PPTX 上传自动收割版式、logo/页眉页脚过滤、版式控制面板
12. **版式控制面板 IPC**：模块数滑杆、配色切换、重点切换、布局切换（免 AI 即时调节）
13. **前置规范拦截** `preflight-spec.ts`：标题截断、图像路径存在性检查
14. **资产完整性校验** `asset-integrity.ts`：src/href/poster/srcset + CSS url() 扫描
15. **v1.0.4 发布**（见下）
16. **对话创作大纲卡片视图**（Unreleased）：`ThinkingPageCards` 列表/网格切换，16:9 幻灯片式占位卡（一行 3 个、面板自动 360→640px 加宽），网格模式弹窗编辑（复用同一套 `thinkingUpdatePageOutline` IPC）
17. **生成重试死循环修复**（Unreleased）：写盘被质量校验拒绝（如 `font-below-floor`）且模型未再调用写盘工具时，"页面未写入"错误现在保留最近一次校验拒绝详情（`page-write-failure.ts`），重试提示词与方法级信号补上字号修正指引，不再重试耗尽
18. **标题带 deck 级统一**（Unreleased）：反转三处"标题位置逐页变化"指令（deck-system 提示词 / `amy-ppt-layout` 技能 §6 / 专家文案），标题带（对齐、字号档位、kicker/装饰、标题-内容间距）写入 deck 级硬契约，`deck-title-anchor-drift` 升为 error 级并增加标题字号中位漂移检测；封面/金句/全图页豁免
19. **演示级字号/图标默认值**（Unreleased）：1600×900 画布默认值正文 20→24px、模块标题 24→28px、副标题 26→28px、页标题 40→48px（与运行时 48px 强制值对齐）、重点数字 52→56px、图标底托 52→64px、卡片内边距 24→32px；高度预算超限时必须先删文案/合并模块，禁止缩字号硬塞。设置 → 排版规则中仍可按会话覆盖这些值
20. **可维护性大拆分**（Unreleased，纯结构无行为变化）：`database.ts` 3758→2767（拆出 `records.ts` + 7 个 repositories + services）、`agent-runner.ts` 2595→1800（拆出 `planning/` 4 件套 + `agent-stream-processor`）、`session-detail.tsx` 1894→1270（拆出 `components/session-detail/` 98 文件组件树 + hooks）、`PreviewIframe`/`HtmlEditorCanvas` 共享 `presentation-webview/`。同步修复 7 个因搬家/默认值/仓库名过期而失败的测试；Windows 无符号链接权限时 symlink 测试自跳过。全量 335 测试文件 + typecheck 双绿
21. **数据层下沉收尾**（Unreleased，纯结构无行为变化）：生成运行/会话任务/生成页面下沉到 `generation-run-repository`，会话页面/源页面骨架下沉到 `session-page-repository`，`database.ts` 2767→2039，仓库总数 9 个；补 6 个仓库定向测试（run/job 生命周期、页面快照、软硬删除、排序、骨架替换）。全量 337 测试文件 + typecheck 双绿
22. **单页 Agent 降本**（Unreleased）：普通单页生成与单页重试不再注册 `GENERAL_PURPOSE_SUBAGENT`；主 Agent 仍保留页面写入工具和产品 skills middleware。多页生成、整页/deck/selector 编辑保持原行为。启用状态通过 `generalPurposeSubagentEnabled` 记录到日志。
23. **跨页 system prompt 稳定化**（Unreleased）：单页生成的 `pageId`、目标文件、页标题、页面大纲、layout master 等逐页变量全部留在 user prompt；system prompt 只保留 deck 级稳定规则。源文档政策留在 system，本页是否读取及章节目录豁免由 user prompt 决定。`deck-prompt-template.test.ts` 断言同一 deck 不同页的 system prompt 完全相同，便于 provider prompt cache 命中。
24. **Prompt/token telemetry**（Unreleased）：新增 `agent-runtime/prompt/metrics.ts`，只记录字符数、UTF-8 字节数、中英文感知估算 token 和 12 位 SHA-256 指纹，不记录提示词正文。单页 system/user prompt 都有指标；指纹用于确认跨页稳定性，不能用于还原内容。
25. **单页 user prompt 去重**（Unreleased）：删除与 system/tool schema 重复的 enrichment、HTML fragment、page shell、标签闭合、禁止返回 HTML 等静态复述；user prompt 只保留页面数据、素材、重试原因和动态写入目标。去重时把"事实跨模块不重复"、"显式同级主题列表分组"、"趋势/对比/占比优先图表化"三条护栏补进 deck-system system 模板（跨页稳定，不影响 prompt cache）。安全边界仍由 system prompt、工具 schema、pageId 作用域和落盘校验共同保证。
26. **Token fallback 统一**（Unreleased）：新增 `agent-runtime/token-estimate.ts`；ASCII 约 4 字符/token，中文及其他非 ASCII 约 1 字符/token。Prompt telemetry 和 provider 未返回 usage 时的数据库用量记录共用同一算法，避免中文被统一 `/4` 严重低估。
27. **pnpm/Corepack 工作流修复**（Unreleased）：固定 pnpm 10.10.0，pnpm 配置迁到 `pnpm-workspace.yaml`，`.npmrc` Electron 镜像改为合法 npmrc 语法，嵌套脚本统一使用 `pnpm run`。新增 `node scripts/check-toolchain.mjs` / `pnpm doctor`；README 中英文版已写 Corepack 初始化方式。
28. **依赖瘦身**（Unreleased）：移除源码零引用的 `electron-updater`、`@electron-toolkit/preload`、`@radix-ui/react-progress`、`@radix-ui/react-slot`、`@radix-ui/react-toast`、`@tanstack/react-virtual`、`class-variance-authority`。package 与 lockfile 根 importer 已校验一致；共享传递依赖没有激进删除。
29. **收尾修复与 composer 下沉**（Unreleased）：修复上一轮遗留的 3 个失败测试（`brand.test.ts` 仓库 URL 过期、`source-grounding.test.ts` 两条断言仍指向 user prompt 旧位置）；单页 user prompt 组装从 `agent-runner.ts` 下沉为 `agent-runtime/prompt/composers/single-page-agent-user.ts`（运行级附加说明 + 重试修复 + 模板强制读取 + 模板页角色 + 页面数据 prompt），新增 `single-page-agent-user.test.ts` 定向测试，prompt 组装自此可直接单测。全量 340 测试文件（1807 用例）+ Node/Web typecheck 双绿。
30. **Prompt cache 验证工具**（Unreleased）：`tests/unit/prompt/deck-prompt-cost.test.ts` 用真实 composer 跑一个 10 页逼真 deck 的确定性基准——断言同 deck（含模板模式）system prompt 跨页字节一致、逐页变量零泄漏、不同 style 内容指纹可区分，并量化去重收益（基准数据：system 6782 tokens/deck 一份、user 每 deck 2831 vs 旧版 10741 tokens、user 节省 73.6%、system 可缓存 61038 tokens）。`scripts/check-prompt-cache.mjs` 解析 electron-log 真实日志（单行 JSON 与多行 inspect 两种格式），按会话核对 system 指纹唯一性并汇总 user token，指纹分裂即退出码 1；配套 `tests/unit/config/prompt-cache-report.test.ts`。真实 deck 生成后运行 `node scripts/check-prompt-cache.mjs`（默认读 electron-log 位置，可传日志路径）。全量 342 测试文件（1815 用例）双绿。
31. **pptx-import 分层拆分**（Unreleased，纯结构无行为变化）：`pptx-import/index.ts` 2168→196，按依赖单向分层拆出 `element-model.ts`（几何/层级排序，153）、`sanitize.ts`（HTML/CSS 白名单消毒 + 排版提取缩放，347）、`image-registry.ts`（图片 data-url 落盘去重，50）、`style-css.ts`（填充/边框/阴影/渐变/表格边框/XML 形状文本 CSS，234）、`block-builders.ts`（文本/图片/矢量形状/表格块构建，605）、`slide-render.ts`（元素分发渲染 + 整页 HTML + 标题推断 + 动画匹配，629）；index 只留解析→抽样→逐页渲染→落盘→总览的编排与类型导出。顺带移除零引用的 `__pptxImporterTestUtils` 死导出（它经 template-builder 传递依赖 electron，单测本来就导不进来）。补 `tests/unit/io/pptx-import-split.test.ts` 6 个定向测试（分层单向无环、入口纯编排、消毒行为、画布居中、表格合并单元格、标题打分）并把 7 个新/既有模块补进 io 边界测试 canonical 清单。全量 344 测试文件（1821 用例）+ typecheck 双绿。
32. **标题带锚点：重生成/重试不再换版式**（Unreleased，修用户反馈 bug）：单页生成失败后重新生成，标题带与已写页面不一致的根因是——重试页只看到抽象 design contract + system 规则，模型每次自行具体化对齐/字号/装饰。新增 `generation/title-band-anchor.ts`：生成/重试任何页前，从磁盘已写页面中按"其它常规页页码升序 → 重试页自身旧版"的优先级抽取 `[data-role="title"]`（退化 `[data-block-id="title"]`）带的外层标记（空白归一化、>2000 字符视为无带），以硬契约注入 user prompt（"复刻该版式，只换标题文字，不得新发明对齐/字号/装饰"）；封面/金句/全图页（layoutIntent）与模板导入流程豁免，与 deck-quality-validator 的 isSpecialComposition 口径一致。锚点在 user prompt 侧，system prompt 跨页字节稳定不受影响；`deck-title-anchor-drift` 中位检测保留作兜底。日志记录锚点页与带长度。补 `tests/unit/generation/title-band-anchor.test.ts`（提取/豁免/优先级/容错）与 composer 注入用例。全量 345 测试文件（1830 用例）+ typecheck 双绿。
33. **agent-runner 分层拆分**（Unreleased，纯结构无行为变化）：`agent-runner.ts` 1747→285，只保留编排（PageRef 解析、调度 + 并发闸门 + 熔断器、评审交接、最终汇总）与兼容 re-export；拆出 `runner-shared.ts`（locale/model-control/文件/信号工具，32）、`page-refs.ts`（PageRef + 版式提示词解析，140）、`deck-generation-types.ts`（运行参数/结果契约，89）、`page-progress-tracker.ts`（页级进度聚合与状态发射，105）、`single-page-generator.ts`（单页 worker：重试/限流退避/方法级信号升级/救援落盘，625）、`deck-review-repair.ts`（整套质量 + 叙事评审与定向修复，349）、`deck-edit-runner.ts`（整页/deck/selector 编辑运行，320）。`planNewPage`/`planDeckWithLLM`/`buildDesignContractWithLLM`/`runDeepAgentEdit`/`runDeepAgentDeckAllPageEdit` 全部从 agent-runner re-export，现有导入不变；`ReferenceDocumentRetriever` 改为导出类型；3 个源契约测试（限流接线、编辑错峰、进度文案）跟随代码迁移指向。
34. **PreviewIframe 拆分**（Unreleased，纯结构无行为变化）：`PreviewIframe.tsx` 1423→318 组装层；拆出 `preview/webview-commands.ts`（`PreviewIframeHandle` 契约 + 页面审计脚本 + `createWebviewCommands` 命令工厂，785）、`preview/usePreviewConsoleRouter.ts`（元素锚定 ensureAnchoredAnchor + console 消息路由/串行化 moved 事件，422）、`preview/PreviewIframeHelpers.ts`（纯判定函数，16）。`PreviewIframeHandle` 与 `isCurrentInspectorSelectionRequest` 仍从组件文件 re-export，现有导入不变。UI 结构性改动按仓库规则不补测试，靠 typecheck:web + 全量套件验证。全量 344 测试文件（1830 用例）+ 双 typecheck 绿。
35. **渲染进程 IPC 门面拆分**（Unreleased，纯结构无行为变化）：`renderer/lib/ipc.ts` 1666→28 门面；拆到 `lib/ipc/` 目录——`core.ts`（preload ipcRenderer 获取，11）、`types.ts`（全部载荷/结果接口，448）、`sessions.ts`（会话 CRUD/合并/母版/页面操作 + HTML 编辑器 + 模板，412）、`generation.ts`（生成/整页编辑/美化/deck 编辑/风格切换/重试/历史，175）、`workspace.ts`（素材/参考文档/PPTX 导入/版式库/版式控制/会话事件/导出，173）、`settings.ts`（设置/模型配置/字体/图像生成，140）、`styles.ts`（样式包/预览/元素编辑/图表数据/文件，207）、`system.ts`（全局事件/应用信息/放映/演讲稿/Thinking，175）。块按原文件顺序整段搬迁零重排；`ipc` 对象与全部类型仍从 `lib/ipc.ts` re-export，现有导入不变。**通道白名单安全测试**（`ipc-channel-policy.test.ts`）改为扫描整个 `lib/ipc/` 目录，任何模块新增通道都必须进 preload allowlist。全量 344 测试文件（1830 用例）+ typecheck:web 绿。
36. **文档解析管线拆分**（Unreleased，纯结构无行为变化）：`io/document-parse-handlers.ts` 1471→363，只留三个 IPC handler 注册（参考文档准备、图片参考解析、文档→创建表单计划）；管线拆为五层——`document-source-preparation.ts`（格式校验/docx/csv→markdown/落盘/大纲扫描，245）、`document-plan-quality.ts`（语言匹配/大纲结构断言/轻量计划归一化/骨架 brief 组装，196）、`document-plan-model.ts`（单发计划 prompt + 模型调用，189）、`document-page-summaries.ts`（源行区间抽段 + 分批并发页面摘要，289）、`document-image-plan.ts`（图片→计划与图片→Markdown 两条视觉链路，244）。块整段搬迁；`registerDocumentParseHandlers` 导入路径不变。source-grounding 契约测试改为读六个解析模块的拼接源，prompt-inventory 测试跟随 `buildImageDocumentPlanPrompt` 迁到 image-plan。全量 344 测试文件（1830 用例）+ 双 typecheck 绿。
37. **真实运行反馈修复 ×2**（Unreleased）：① 标题带锚点误把"占位页"当已写页面——生成前的占位模板（`data-placeholder-page`/`scaffold-hint`）也带 `[data-role="title"]`，并行生成时邻居页可能还没被模型覆盖，79 字符占位裸带被"必须复刻"硬指令传播成整套版式，一页残留占位样式；现在 `extractTitleBandHtml` 直接跳过占位页。同时运行时壳层给裸 `h1[data-role="title"]`/`h1[data-block-id="title"]` 补 48px 下限（旧选择器 `[data-role="title"] h1` 只匹配容器内 h1，元素自身带角色时命中不了，标题会缩到正文级）。② 渲染验收超时误判整套失败——隐藏校验窗口每次超时即销毁，后续每页都要付冷启动，高负载机器 10s 全套超时（实测 6/6 页 `render validation timeout`，页面文件其实全部有效）；超时抬到 25s 并换新窗口重试一次，非超时错误仍快速失败。补占位跳过/占位邻居选页/超时契约测试。全量 344 测试文件（1834 用例）+ 双 typecheck 绿。
38. **Prompt cache 真实日志对账完成**（Unreleased）：dev 模式日志在**项目目录** `logs/main.log`（不是 userData！`configureLogging` 里 `is.dev` 分支）。用真实生成日志跑 `node scripts/check-prompt-cache.mjs logs/main.log`：session 8ae1a600 的 10 次 agent 调用 **system 指纹唯一**（跨页字节稳定 ✓），system 11390 tokens/份，user 每页 1607-2302 tokens——离线基准的"跨页稳定"结论在线上成立，优先级 1 闭环。
39. **依赖审计闭环：零候选**（Unreleased）：对全部 61 个运行时依赖 + 27 个 devDependencies 做逐个确认（引用形态覆盖 ESM import / `import()` / `require()` / postcss 插件键 / tsconfig extends / 环境类型），结论——**全部在用，无可删除项**；上一轮的 7 个删除已把死依赖清干净。10 个 Radix 直接依赖各有 wrapper 组件且 wrapper 有 2-25 个真实 importer；`react-slot` 等仅作为 Radix 内部传递依赖存在（正常，勿动）；lockfile 根 importer 与 package.json 双向完全一致（无孤儿）。**方法论陷阱（下轮审计必读）**：① 引用统计必须匹配不带路径前缀的相对导入（`../ui/X`），只搜 `components/ui/X'` 会把 ColorPicker/RichTextBox/ToggleGroup 误判成零引用（实际各有 2-4 个 importer）；② postcss 插件在 `postcss.config.js`（.js 不是 .mjs）里以键名引用；③ `@types/mdast` 以 `from 'mdast'` 消费；④ resources/ 内 vendored bundle 里的字符串（如 tailwind 的 slate 色名）是假阳性。
40. **可观测三件套**（Unreleased）：① dev 日志轮转——`app/dev-log-rotation.ts` 按日期分文件（`logs/main-YYYY-MM-DD.log`）+ 启动剪枝保留 7 天，替换无上限的单文件 `main.log`（已删旧文件；prod 原本就按日期+版本分文件不变）。② deck 评审持久化——`deck-review-repair` 把质量/叙事评审结果写入 `session_events`（`deck-quality/reviewed`、`deck-narrative/reviewed`，actor=system），载荷含 available/skipped、按严重度计数、去重违规码、修复成功与失败页、语义评审可用性；`appendSessionEvent` 回调由五个持有 db 的生成入口（deck/retry/template/add-page/retry-single-page flow）注入，落盘失败不阻断生成。③ `check-prompt-cache.mjs` 升级为生成健康检查——默认取最新轮转 dev 日志，新增标题带锚点观测（每会话锚定页数、锚页分布、**裸带告警**：bandHtmlLength<100 视为占位带风险）与渲染验收观测（超时重试次数、最终不可用次数、被标超时页数），锚点解析兼容 JSON/inspect 两种键名引号风格。补 13 个定向测试。全量 346 测试文件（1843 用例）+ 双 typecheck 绿。

### 3.1 2026-08-29 第 22–29 项已提交推送

- 第 22–29 项（单页降本、system prompt 稳定化、telemetry、user prompt 去重、token fallback、pnpm 工作流、依赖瘦身、收尾修复）已全部提交并推送到 `origin/main`。
- 关键文件：`src/main/agent-runtime/agent/backend.ts`、`agent/factory.ts`、`prompt/composers/deck-system.ts`、`prompt/composers/generation-user.ts`、`prompt/composers/single-page-agent-user.ts`（新）、`prompt/metrics.ts`（新）、`token-estimate.ts`（新）、`src/main/generation/agent-runner.ts`、`src/main/agent-runtime/model/usage.ts`、`templates/deck-system/system.md`、`pnpm-workspace.yaml`（新）、`scripts/check-toolchain.mjs`（新）。
- 验证：全量 `pnpm test` 340 测试文件 / 1807 用例通过（10 skipped 为 symlink 等环境自跳过），Node/Web typecheck 双绿；遵守仓库规则未跑 lint/build。
- 当前机器的全局 pnpm 是 11，与项目 `<11` 约束不兼容；验证使用已安装的 Node/TypeScript/Vitest 二进制。新环境应先运行下方 Corepack 初始化。

## 4. 打包发布 SOP（含踩过的坑）⚠️ 必读

### 打包

```powershell
pnpm build:win        # = pnpm run build && electron-builder --win
```

产物：`dist/amy-ppt-{version}-setup.exe`（+ `.blockmap`、`latest.yml`）。

> AGENTS.md 禁止日常跑 `npm run lint` / `npm run build`，但用户明确要求打 Release 包时 `build:win` 是允许且必需的。

### 上传到 GitHub Releases（gh CLI 本机不可用，走 REST API）

**最大的坑：仓库已改名 `Amy-PPT` → `Amy-PPT-Agent`。**
`api.github.com` 会自动跟随改名重定向（所以查 release、建 release 都正常），但 **`uploads.github.com` 上传端点返回无 `Location` 头的 307，无法跟随，上传必失败**。上传 URL 必须硬编码新仓库名：

```
POST https://uploads.github.com/repos/296711867/Amy-PPT-Agent/releases/{release_id}/assets?name={file}
Authorization: token {TOKEN}
Content-Type: application/octet-stream
body: 文件二进制
```

Node 22 fetch 注意事项：传 `Buffer` body 即可（不需要 duplex）；`redirect: 'manual'` 更稳。PowerShell 5.1 的 `Invoke-WebRequest` 对大文件上传不可靠，统一用 Node fetch。

**Token 来源**：发布者自己的 GitHub token（classic，scope 含 repo）。**不要把 token 写进任何脚本或文档**，用完即删。

**流程**：

1. `POST /repos/296711867/Amy-PPT-Agent/releases`（tag `v{version}`，target main，带更新说明 body）
2. 上传 exe（上面的 URL，注意仓库名）
3. 验证：`curl -sIL <browser_download_url>` 应 200
4. 只传 exe 单文件即可 —— 当前未接入应用内自动更新，也未安装 `electron-updater`，不需要 latest.yml/blockmap；与 v1.0.3 保持一致

### 历史版本

- v1.0.4：`729b481 chore: release Amy-PPT 1.0.4`，release id `377099665`，asset id `531484434`
- v1.0.3 及更早：仅 exe 资产

## 5. 开发规则（AGENTS.md 摘要，完整版见仓库根）

- **不要跑** `npm run lint`、`npm run build`
- 代码风格：单引号、无分号、printWidth 100、无尾逗号
- 修 bug / 加功能**必须**补测试到 `tests/unit/`（按功能域分子目录，`*.test.ts`），跑最小相关测试
- 样式 UI 改动不需要写测试
- 改公共规则要同时确认生成与编辑链路覆盖
- React 组件规范：逻辑内聚少传 props、跨组件用 Zustand、复用逻辑抽 Hook

### 新环境初始化

```powershell
corepack enable
corepack prepare pnpm@10.10.0 --activate
node scripts/check-toolchain.mjs
pnpm install
```

`packageManager` 和 CI 都固定为 pnpm 10.10.0。不要用 pnpm 11 重写 lockfile。生产依赖声明与 `pnpm-lock.yaml` 根 importer 必须同步修改。

## 6. 当前状态与后续建议

- 全部改动已提交并推送（与 origin/main 同步）；全量测试与 typecheck 双绿
- git remote URL 已更新为新仓库名 `Amy-PPT-Agent.git`（旧 URL 靠 GitHub 重定向也能用）
- `dist/` 里还有 v1.0.3 旧产物，可清理
- **若未来要做应用内自动更新**：需在主进程接入 `electron-updater`，且每次 release 同时上传 `latest.yml` + `.blockmap`
- **下一步优先级 1**：✅ 已闭环（第 38 项）：真实日志确认同 deck system 指纹唯一、user 1607-2302 tokens/页。后续可在更多 provider 上复跑 `node scripts/check-prompt-cache.mjs logs/main.log` 观察缓存命中。
- **下一步优先级 2**：依赖审计已闭环（第 39 项，零候选）。超大文件拆分也告一段落（第 31/33/34/35/36 项）；`db/database.ts`（单一持久化门面）、`db/patch/index.ts`（历史迁移）、i18n 词典按约定不动。可做的方向：在 UI 的会话事件时间线里消费 `deck-quality/reviewed`/`deck-narrative/reviewed` 事件展示评审结论、每次真实生成后跑 `node scripts/check-prompt-cache.mjs` 持续观察锚点健康与渲染验收表现。
- **下一步优先级 3**：继续依赖审计时只生成候选并逐个确认；注意动态加载、Electron 打包钩子和 Radix 传递依赖，禁止仅凭字符串扫描批量删除。
