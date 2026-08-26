# Amy-PPT 项目上下文与交接文档

> 更新时间：2026-08-27 · 当前版本 **1.0.4**
> 本文件面向接手开发/协作者：项目全景、近期演进、打包发布 SOP。新 Agent 会话开始时优先读本文件，再按需查阅 `README.md`、`PROJECT_STRUCTURE.md`、`AGENTS.md`。

---

## 1. 项目关键事实

| 项 | 值 |
|---|---|
| 产品名 | Amy-PPT（前身 oh-my-ppt） |
| 类型 | Electron 桌面应用，AI 生成 PPT |
| GitHub 仓库 | `296711867/Amy-PPT-Agent` ⚠️ **已从 `Amy-PPT` 改名** |
| 最新 Release | [v1.0.4](https://github.com/296711867/Amy-PPT-Agent/releases/tag/v1.0.4)，已发布（非 draft），带更新说明 |
| 安装包 | `amy-ppt-1.0.4-setup.exe`（161.7 MB）已上传，公开下载链接验证 HTTP 200 |
| 包管理器 | pnpm |
| 测试 | Vitest + happy-dom，`pnpm test`，单文件 `pnpm test -- tests/unit/xxx/foo.test.ts` |

## 2. 架构总览

- **主进程** `src/main/`：生成编排、IPC、版式资产、导出
- **渲染进程** `src/renderer/`：React UI，路径别名 `@renderer/*`、`@shared/*`
- **共享类型** `src/shared/`

### 核心链路（改公共规则时三条都要确认）

1. **生成链路**：`src/main/generation/deck-flow.ts`（~1400 行，主编排）→ `agent-runner.ts`（~2100 行，LLM 编排 + 结构化内容提取 + 重试）
2. **编辑链路**：整页编辑、deck 编辑、selector 编辑（`edit-flow.ts`、`retry-flow.ts`、`page-merge-*`）
3. **运行时资源**：session asset 兼容/刷新机制

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

## 4. 打包发布 SOP（含踩过的坑）⚠️ 必读

### 打包

```powershell
pnpm build:win        # = npm run build && electron-builder --win
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
4. 只传 exe 单文件即可 —— `electron-updater` 虽在 dependencies 但**源码从未使用**（遗留依赖），不需要 latest.yml/blockmap；与 v1.0.3 保持一致

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

## 6. 当前状态与后续建议

- 全部改动已提交并推送（与 origin/main 同步）
- git remote URL 已更新为新仓库名 `Amy-PPT-Agent.git`（旧 URL 靠 GitHub 重定向也能用）
- `dist/` 里还有 v1.0.3 旧产物，可清理
- **若未来要做应用内自动更新**：需在主进程接入 `electron-updater`，且每次 release 同时上传 `latest.yml` + `.blockmap`
