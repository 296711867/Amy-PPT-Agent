<div align="center">
  <img src="docs/assets/amy-ppt-brand.svg" alt="Amy-PPT" width="720" />

# Amy-PPT

**Agent 驱动、可审查、可编辑的 AI PPT 创作软件**

[English](./README_EN.md) · [快速使用指南](./QUICK_START.md) · [项目上下文与交接文档](./HANDOFF.md) · [更新记录](./CHANGELOG.md) · [问题反馈](https://github.com/296711867/Amy-PPT-Agent/issues) · [版本发布](https://github.com/296711867/Amy-PPT-Agent/releases)

</div>

Amy-PPT 是一款 Electron 桌面端演示文稿工作台。它不是让模型一次性吐出一组网页，而是用受控 Agent 流程完成大纲规划、页面生成、写盘校验、失败回滚、跨页视觉检查和内容叙事检查。

第一次使用请参阅 [快速使用指南](./QUICK_START.md)。

![Amy-PPT 首页](docs/screenshots/amy-ppt-home.png)

## 核心能力

- Agent 创作：从主题、详细需求或源文档生成整套演示文稿。
- PPT 排版规则：通过 Layout 规则配置和专家 Markdown 编辑器约束画布、字体、安全区、间距、卡片和叙事结构。
- 基础版式库：覆盖 1-6 段纯文字、图文混排和 2/3/4/6 图画廊，Agent 会按内容结构选择并轮换相邻页面轮廓。
- 版式资产系统：内置版式 + 企业模板 PPTX 自动收割，插槽化参数与确定性内容填充，支持零 LLM 的锁定版式模式。
- 版式控制台：模块数量滑杆、风格内配色切换、页面重点与布局切换，全部本地即时生效。
- 插件化运行时：模型 Provider 注册表（Anthropic、OpenAI、Responses、Gemini、智谱、DeepSeek、Kimi）、生成事件总线、会话事件日志与 YAML Profile。
- 视觉元素偏好：创建会话时声明图表/图片/表格用量，规划阶段主动落实到大纲。
- 质量 Harness：检查 HTML 结构、字号、安全区、溢出、裁切、重叠、画布规格和核心字体。
- Deck 裁判：检查跨页配色、标题、留白、信息密度、版式节奏与 Web UI 倾向。
- 叙事裁判：检查内部过程泄漏、重复内容、页面职责、证据解释、开场和结尾，并进行有界定向修复。
- 文档生成：支持 Markdown、TXT、CSV、DOCX 和图片参考，先形成源文档页面骨架，再按页检索相关原文。
- 可视化编辑：支持整页、整套和元素级 AI 编辑，并对本次新增质量问题进行差分拦截与回滚。
- PPTX 工作流：支持 PPTX 导入、HTML 演示、可编辑 PPTX 导出、模板和风格管理。
- 本地优先：会话、素材、模板、风格和生成结果保存在用户指定目录；模型请求发送到用户配置的 Provider。
- 多主题 UI：包含暖杏珊瑚、粉彩等界面主题，方便继续扩展品牌皮肤。

## 技术栈

- Electron 39
- React 19 + TypeScript
- Vite / electron-vite
- Zustand
- LangChain + Deep Agents
- SQLite / libSQL + Drizzle ORM
- Vitest + happy-dom
- Tailwind CSS
- Chart.js

## 本地开发

环境要求：Node.js 20+、pnpm 10.10.0。建议通过 Corepack 使用仓库声明的准确版本：

```bash
corepack enable
corepack prepare pnpm@10.10.0 --activate
node scripts/check-toolchain.mjs
pnpm install
pnpm dev
```

定向验证：

```bash
pnpm run typecheck:node
pnpm run typecheck:web
pnpm test -- tests/unit/path/to/test.test.ts
```

## 模型配置

启动后前往“系统设置 → 模型”，添加并启用文本模型。当前支持 OpenAI/兼容 Chat Completions、OpenAI Responses、Anthropic、Google Gemini 和智谱兼容链路。

生图模型在“系统设置 → 生图模型”中单独配置。API Key 仅保存在本地数据库中，请不要提交数据库或日志文件。

## 更新发布

Amy-PPT 使用独立更新清单。当前版本为 `1.0.4`：

```text
https://raw.githubusercontent.com/296711867/Amy-PPT-Agent/main/version.json
```

私有部署或迁移到正式服务器时，可在启动环境中设置：

```text
AMY_PPT_UPDATE_MANIFEST_URL=https://your-domain.example/version.json
```

清单格式：

```json
{
  "version": "1.0.4",
  "downloadhome": "https://github.com/296711867/Amy-PPT-Agent/releases",
  "changeLog": "本次更新内容"
}
```

## 项目结构

```text
src/main/       Electron 主进程、Agent、生成、编辑、导入导出
src/renderer/   React 界面
src/shared/     主进程和渲染进程共享类型与规则
resources/      内置风格、Skills、运行时和字体
tests/unit/     Vitest 定向回归测试
```

## License

Amy-PPT 是基于 [arcsin1/oh-my-ppt](https://github.com/arcsin1/oh-my-ppt) 的二次开发项目。

上游项目由 arcsin1 `<zy19931129@gmail.com>` 开发并依据 Apache License 2.0 发布，Copyright 2026 arcsin1。Amy-PPT 继续采用 Apache License 2.0，并保留原项目的许可证与署名信息。详见本仓库的 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
