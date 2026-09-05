# 生成质量契约

> 本文是 Amy-PPT 生成、重试和 AI 编辑的领域规范。修改规划字段、页面生成、质量门禁或持久化时必须同步检查本文。

## 1. 目标

一页合格的幻灯片不能只有“主题相关的文字”。它必须同时回答：

- 这页要让观众得出什么结论？
- 用哪些事实、指标或论据支撑？
- 用什么视觉形式表达最有效？
- 看完后观众的认知从什么状态变成什么状态？
- 它在整套叙事中承担什么职责？

因此，规划结果不是临时 Prompt 文本，而是贯穿页面生命周期的语义契约。

## 2. 页面计划模型

权威类型：`src/shared/generation.ts` 的 `OutlineItem`。

| 字段               | 新规划要求       | 含义                                          |
| ------------------ | ---------------- | --------------------------------------------- |
| `title`            | 必须             | 结论型标题，不是泛泛的主题标签                |
| `contentOutline`   | 必须非空         | 要点、论据、指标和必要细节                    |
| `layoutIntent`     | 必须可归一化     | 页面职责，如 cover、process、comparison       |
| `visualFormat`     | 必须             | 图、表、流程、时间线、大数字、引语等表达形式  |
| `audienceMove`     | 必须             | 简洁的 `before → after` 认知转变              |
| `contentStructure` | 按内容决定       | 内容语义结构                                  |
| `moduleCount`      | 按内容决定       | 有意义的内容模块数量，范围 1–6                |
| `visualAspect`     | 有视觉素材时决定 | 图片或视觉区域方向                            |
| `contentDensity`   | 按内容决定       | 页面可见内容负载                              |
| `layoutId`         | 有匹配时设置     | 通用版式或 session layout master ID           |
| `items`            | 建议保留         | 结构化 key points，含指标、单位、细节与优先级 |

类型中的部分字段为兼容旧 session 保持可选，但 `deck-planner.ts` 和 `page-planner.ts` 对新 LLM 规划必须校验 `visualFormat` 与 `audienceMove`，不能依赖可选类型静默放行。

### 内容容量

- 每页最多 10 个规划要点。
- 单个要点标签最多 72 字符。
- 合并后的 `contentOutline` 最多 720 字符。
- 结构化要点进入生成 Prompt 时必须保留 label、metric 和 detail，不能只取 label。
- 超出页面展示预算时应由 preflight/layout 规则调整，而不是在规划阶段过早丢失论据。

## 3. 规划不变量

### Deck 规划

- 返回页数必须与用户要求完全一致。
- 页数不符属于规划失败，进入带错误反馈的重试。
- 禁止用“第 N 页 + 空大纲”静默补齐。
- 每页必须选择适合内容的 `visualFormat`，不能默认全部使用 card grid。
- 相邻页面应有叙事推进和版式轮廓变化。

### 单页新增

- 新页不得重复已有标题或职责。
- 同样必须生成 `visualFormat` 和 `audienceMove`。
- 要结合 deck 主题、已有页面、源文档和相邻页面确定位置与表达。

### Source plan

- 直接使用源文档计划时仍需补全版式和视觉计划。
- 图片策略、章节目录和通用版式分配不能只存在于 LLM planner 路径。
- 修改规划规则时必须同时检查 `source-plan.ts`。

### 模板整套生成的选项契约

- 模板会话创建时必须把 `initialPrompt`（含大纲）与 `imagePolicy` 写入会话元数据（`templateInitialPrompt`）；生成页在路由 state 缺失时用元数据兜底恢复开始意图。
- 模板链路 `imagePolicy` 默认 `'none'`：模板页基底是视觉事实来源，不额外注入配图、不强制图槽版式；`'placeholder'`/`'ai'` 必须由用户显式选择。
- `animationPreferences` 在模板链路与标准链路同权：进入 run 持久化、模板重试从最近 run 继承、随 runner 传给单页生成。
- 字体、AI 背景、视觉元素侧重不进入模板创建选项——模板链路不消费这些字段，暴露即误导；要支持必须先定义模板视觉与用户覆盖的优先级。

## 4. 生命周期与元数据保真

以下字段形成一个不可拆分的页面计划包：

```text
contentOutline + layoutIntent + visualFormat + audienceMove + layoutId
```

它们必须通过下面所有路径：

| 路径                | 主要实现                                                 |
| ------------------- | -------------------------------------------------------- |
| 初次整套生成        | `generation/deck-flow.ts`                                |
| 模板整套生成        | `generation/template-deck-flow.ts`                       |
| 新增单页            | `generation/add-page-flow.ts`                            |
| 失败页面重试        | `generation/retry-flow.ts`、`retry-single-page-flow.ts`  |
| 单页/selector 编辑  | `generation/edit-flow.ts`                                |
| 整套页面编辑        | `generation/edit-deck-allpage-flow.ts`                   |
| 风格切换            | `edit-jobs/style-switch-job-*`                           |
| 一键美化            | `edit-jobs/page-beautify-job-service.ts`                 |
| Deck 评审修复       | `generation/deck-review-repair.ts`                       |
| Agent 正常完成/失败 | `generation/agent-runner.ts`、`single-page-generator.ts` |

任何 completed 或 failed 回调都必须带回这组字段。失败状态不能用 `undefined` 覆盖原规划，否则下一次重试和美化会丢失页面职责。

## 5. 持久化契约

权威位置：

- schema：`src/main/db/schema.ts`
- record：`src/main/db/records.ts`
- repository：`src/main/db/repositories/generation-run-repository.ts`
- 公共回调：`src/main/generation/generation-utils.ts`
- migration：`src/main/db/patch/index.ts`

`generation_pages` 必须保存：

- `content_outline`
- `layout_intent`
- `visual_format`
- `audience_move`
- `layout_id`
- 页面状态、HTML 路径和失败原因

读取页面计划时使用最新 generation run 的页面快照，并兼容老记录缺少新增字段。新增字段要提供幂等 migration；禁止修改已经发布的历史 patch。

## 6. 单页生成状态机

```text
计划 → 组装 Prompt → Agent 流 → 工具写入/HTML 救援
     → 静态验证 → 必要的渲染验证 → completed
                         ↓
                   可执行反馈 → 同会话续跑/页面重试
```

### Agent 流

- 只从主图收集会话消息，不能把 subagent 内部消息混进主会话。
- 记录是否出现工具调用、是否有用户消息和最终 assistant 文本。
- 模型“无工具调用 + 无正文”属于空回合，不等同于写盘校验失败。
- 页面写盘工具已完成有效提交后，即使模型在最终回复阶段超时，也必须按页面成功处理；尾随回复不得反向否定磁盘提交或污染熔断计数。

### 空回合

- 最多在同一 Agent 会话自动续跑 2 次。
- 续跑必须保留完整主图会话历史，并明确要求立即调用页面写入工具。
- 续跑仍为空才进入页面级重试，错误信息要准确说明空回合。
- GLM 5 及更高版本不能发送 `thinking.type=disabled`。

### HTML 救援

- 模型未调用工具但最终正文包含完整 HTML 片段时，可以提取候选。
- 候选必须进入 `page-writer-core` 的同一修复、资源和验证管道。
- 禁止直接写文件绕过页面契约。

锁定单页上下文暴露的写盘工具必须以唯一目标页为默认 `pageId`；模型省略重复的 `pageId` 时可以安全写入锁定页，显式传入其它页仍必须拒绝。对无歧义、语义等价的常见生成别名可在统一写盘预处理内归一化（当前仅 `data-anim="fade-in"` → `fade`）；其它未知值继续由权威门禁拒绝。

### 页面终态记账

- runner 返回时，每个计划页必须有 completed 或 failed 终态；熔断后未派发的页必须通过 failed 回调落库，不得静默消失。
- 可重试的模型系统故障需同指纹累计两次才打开熔断；鉴权、额度或存储等不可重试故障仍立即熔断。
- 模板页只有观测到 completed 回调且最终 HTML 不再匹配 `templateSeedFingerprints` 时才能标记完成；旧会话缺少种子指纹时，也不得仅凭静态 HTML 校验补记 completed。

## 7. 质量门禁

页面完成至少包含：

1. 目标文件产生了有效提交变化。
2. HTML 页面壳、资源、动画、图标和布局规则通过静态验证。
3. 模板或背景资产没有在写入中丢失。
4. 需要浏览器指标时完成渲染验证；基础设施不可用和页面缺陷要分开处理。
5. 整套生成完成后执行跨页质量与叙事评审。

渲染基础设施连续超时后允许进入短期冷却，避免同一 run 的每一页重复支付超时；冷却必须保留明确警告并自动重新探测，不能把“未验收”伪装成“验收通过”。模板生成已经以目标模板页作为版式事实来源，不应再强制逐页读取通用 layout skill。

模板保留模式下，PPTX 导入的顶层绝对/固定定位分区以坐标定义安全区，不适用创意页内容根容器的水平 padding 下限；只有这些定位分区可豁免，普通生成和模板中的流式内容根仍执行相同 gutter 门禁。

模板 Agent 检查目标页时只应读取可编辑的创意正文片段；完整运行时页面保留在磁盘侧用于骨架校验和落盘，不应把不可编辑的 head、runtime、fit shell 重复送入模型上下文。

Deck 评审的定向修复必须保留事实、页面职责、视觉形式和已正确的布局元素。评审失败回写也必须保留原始页面计划包。

视觉评审只能在模型 endpoint 接受图片输入时执行；已知文本型 Coding endpoint 必须在截图渲染与模型调用之前跳过，不能先支付截图成本再用 400 响应探测能力。

### 可编辑 PPTX 导出

- PPTX 导入模板中的全页贴边图片属于静态背景层，必须留在背景合成中维持原 DOM 层级，不能再作为独立顶层图片导出；普通内容图片仍应保持可编辑。
- 背景截图的文本残留检测必须区分字形残留与纯色/大面积填充。接近整页的均匀非透明像素不能单独作为整页栅格化依据。
- 只有确认背景合成中仍存在实际文本残留，且重试无法消除时，才允许把页面降级成整页位图；降级必须有明确日志。
- 导出验收不能只检查文件可打开：至少要核对页数、逐页渲染结果、零文本页数量，以及预期可编辑页面的文本节点是否仍存在。

## 8. Prompt 规则

- Deck 级稳定规则放 system prompt，页级变量放 user prompt，保持同 deck system fingerprint 稳定。
- 共用规则必须集中在 `agent-runtime/prompt/`；不要在 deck/add/retry/edit 各复制一份。
- Prompt 日志只记录字符数、字节数、估算 token 和 fingerprint，不记录原文。
- 新增独立内联模型调用时更新 `node-agent-runtime-prompt-inventory.md`。
- 错误反馈必须告诉模型合法值、目标文件和下一步动作，不能只写“格式错误”。

## 9. 回归测试地图

| 契约                          | 主要测试                                                          |
| ----------------------------- | ----------------------------------------------------------------- |
| Deck 规划字段与精确页数       | `deck-planner.test.ts`                                            |
| 单页新增规划                  | `page-planner.test.ts`                                            |
| 大纲容量与结构化细节          | `outline-normalizer.test.ts`、`structured-content.test.ts`        |
| Source plan 补全              | `source-plan.test.ts`                                             |
| Agent 流消息收集              | `agent-stream-processor.test.ts`                                  |
| 空回合、写入错误和 HTML 救援  | `page-write-failure.test.ts`                                      |
| 熔断后的逐页终态记账          | `agent-runner-circuit-outcome.test.ts`                            |
| completed/failed 元数据持久化 | `generation-run-repository.test.ts`、`deck-review-events.test.ts` |
| 编辑链路元数据                | `edit-deck-allpage-flow.test.ts`、`style-switch-job-flow.test.ts` |
| Prompt 共享规则               | `tests/unit/prompt/source-grounding.test.ts`                      |
| 视觉与叙事评审                | `visual-review.test.ts`、`deck-narrative-reviewer.test.ts`        |
| PPTX 静态背景层级             | `static-background.test.ts`、`browser-scripts-animation.test.ts`  |
| PPTX 文本残留判定             | `text-residue.test.ts`                                            |

## 10. 修改检查表

修改任何页面计划字段时逐项确认：

- [ ] shared type/normalizer
- [ ] deck planner 与 retry prompt
- [ ] page planner
- [ ] source plan
- [ ] PageRef/PageTaskInput
- [ ] deck/template/add/retry/edit flows
- [ ] style switch 与 page beautify
- [ ] completed/failed callbacks
- [ ] schema/record/repository/migration
- [ ] 相关定向测试
- [ ] 本文与生成问题台账
