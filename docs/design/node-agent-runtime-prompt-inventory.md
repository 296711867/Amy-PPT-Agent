# Agent Runtime Prompt Inventory

Runtime 侧除 Thinking 主链路外，仍存在少量"有意内联"的模型构建点：它们是一次性、
局部性的 LLM 调用（规划、修复、抽取），不值得接入统一的 DeepAgent 工厂。
本清单用于防止内联构建器无声扩散：新增内联调用必须在此登记，并优先评估能否复用
既有共享入口（`resolveModel` + `assertModelText`）。

| ID | Builder | Source | 用途 |
| --- | --- | --- | --- |
| `add-page-plan` | `planNewPage` | `src/main/generation/planning/page-planner.ts` | 追加单页前的大纲规划 |
| `document-image-plan` | `buildImageDocumentPlanPrompt` | `src/main/io/document-parse-handlers.ts` | 源文档配图规划提示词 |
| `style-import-json-repair` | `retryFixJson` | `src/main/styles/import/pptx.ts` | 风格导入 JSON 解析失败后的修复重试 |
| `deck-background-plan` | `buildPromptPlan` | `src/main/generation/deck-backgrounds.ts` | PPT 背景图提示词成套规划 |
