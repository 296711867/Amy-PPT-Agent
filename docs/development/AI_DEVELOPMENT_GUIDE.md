# Amy-PPT AI 开发手册

> 面向后续 Codex、Claude 和人工协作者。这里定义“如何安全地修改 Amy-PPT”。
> 领域细节以代码和对应领域文档为准；本文件负责给出入口、边界、检查矩阵与完成标准。

## 1. 文档优先级

遇到冲突时按以下顺序执行：

1. 根目录 `AGENTS.md`：仓库级强制规则和禁止项。
2. 当前任务的用户要求。
3. 领域契约，例如 `docs/design/generation-quality-contract.md`。
4. `PROJECT_STRUCTURE.md`：代码放置位置与模块职责。
5. `docs/design/generation-issue-log.md`：真实故障、根因和历史决策。
6. `HANDOFF.md`、`PROJECT_STATUS.md`：项目背景、发布信息与阶段状态。

代码、测试和文档不一致时，不要静默选择其一。先确认当前运行行为，再在同一变更中修正文档。

## 2. 开始任务前

每次修改前完成下面的最小检查：

1. 运行 `git status --short`，保留用户已有改动。
2. 判断任务属于生成、编辑、导入、导出、运行时、数据或纯 UI。
3. 用 `rg` 找到入口、共享类型、持久化和所有相邻调用方。
4. 阅读对应领域文档与历史问题，不重复引入已经解决过的故障。
5. 选择能覆盖所有入口的共享修复点；不要只补当前报错分支。

不要为了“顺手整理”改动无关文件。不要新建 `v2`、`new`、`final` 版本文件。

## 3. 架构边界

| 领域            | 权威位置                        | 规则                                                       |
| --------------- | ------------------------------- | ---------------------------------------------------------- |
| Electron 主进程 | `src/main/`                     | 文件、数据库、模型、导入导出和安全边界都在主进程           |
| React 渲染进程  | `src/renderer/src/`             | UI、组件内交互和 Zustand 状态；不直接访问 Node API         |
| 跨进程契约      | `src/shared/`                   | IPC 两端或多个主进程领域共享的类型、枚举和归一化函数       |
| 数据库          | `src/main/db/`                  | 调用方只依赖 `PPTDatabase` 门面；新 CRUD 放对应 repository |
| 生成编排        | `src/main/generation/`          | 规划、逐页生成、重试、评审、最终化                         |
| Agent 能力      | `src/main/agent-runtime/`       | 模型解析、Provider、Prompt、工具和流处理                   |
| 演示文稿契约    | `src/main/presentation/`        | HTML 写入、验证、资源策略和渲染检查                        |
| 导入导出        | `src/main/io/`                  | 外部格式、事务输出和临时资源                               |
| 会话运行时资产  | `resources/` + session 项目目录 | 修改时必须兼容旧 session 并确认刷新机制                    |
| 回归测试        | `tests/unit/<domain>/`          | 与生产领域同名分组，文件名 `*.test.ts`                     |

### 依赖方向

- renderer 可以依赖 `@shared/*`，不能导入 `src/main/`。
- main 可以依赖 `@shared/*`，不能依赖 renderer 组件或 store。
- shared 不能依赖 main、renderer、Electron 或 Node 专属实现。
- repository 负责单领域持久化；跨 repository 业务放 service 或数据库门面。
- Prompt 共享规则放 `agent-runtime/prompt/`，不要复制到多个 flow。

## 4. 变更覆盖矩阵

修改前先选择一行，并逐项确认。

| 变更类型       | 必查入口                                           | 必查持久化/兼容                  | 最小验证                          |
| -------------- | -------------------------------------------------- | -------------------------------- | --------------------------------- |
| 页面规划字段   | deck planner、page planner、source plan            | generation pages、旧记录可选字段 | planner + source-plan + DB 测试   |
| 页面生成规则   | deck、template deck、add page                      | completed/failed 回调            | single-page + prompt + flow 测试  |
| 页面编辑规则   | page edit、deck edit、all-page edit、selector edit | 页面快照与 metadata              | edit-flow 相关测试                |
| 重试策略       | retry deck、retry single page、Agent 空回合        | 失败原因和原始计划保留           | retry + page-write-failure 测试   |
| 风格/美化      | style switch、page beautify                        | 原内容大纲和视觉计划保留         | style-switch/page-beautify 测试   |
| HTML 页面契约  | page writer、编辑保存、导入                        | session runtime 兼容             | validator + writer + 相邻入口测试 |
| IPC/文件操作   | preload allowlist、main handler、renderer client   | 路径根、旧 payload               | IPC 边界与路径安全测试            |
| 数据库字段     | schema、records、repository、patch                 | 老数据库迁移、默认值             | repository/migration 测试         |
| 导出           | PDF/PNG/PPTX/video/slide pack                      | 临时文件和事务提交               | 对应 exporter 测试                |
| React 共享状态 | 组件、Zustand store、清理时机                      | session/document 隔离            | store + 组件定向测试              |
| 运行时资源     | packaged resource、session copy                    | 版本或兼容检测                   | runtime asset 测试                |

## 5. 实现规范

### 5.1 修根因

- 先列出目标函数的所有调用方。
- 公共不变量放在共享入口校验一次。
- 输入边界必须归一化；内部已归一化的数据不重复防御。
- 不用静默默认值掩盖模型、数据库或协议错误。
- 降级行为必须可观测，并区分用户内容错误、模型错误和基础设施错误。

### 5.2 保持简单

- 两处完全相同且会同步演进的逻辑才提取共享实现。
- 优先标准库和已安装依赖，不为少量代码增加包。
- 不建立只有一个实现的接口、工厂或配置层。
- 大文件不是自动拆分理由；只有明确职责边界和回归覆盖时才拆。
- 删除重复实现后保留兼容导出，避免一次性扩散调用方变更。

### 5.3 React 与 Zustand

- 只在组件内使用的状态与事件留在组件内。
- 多组件共享状态放 Zustand；相同有状态逻辑才抽 Hook。
- props 主要传配置和纯展示数据，不做多层状态搬运。
- 同一逻辑需要多个独立实例时，使用共享 store creator，测试实例隔离。
- 有历史栈、缓存或队列的状态必须有明确上限和清理时机。

### 5.4 数据与文件安全

- renderer 传入的路径、URL、HTML 和对象一律视为不可信。
- 文件 IPC 必须经过允许目录解析；导入归档必须防路径穿越和解压炸弹。
- 关键文件优先使用临时文件 + rename 或已有事务工具，避免半写入。
- 不在日志记录 API key、完整 Prompt、源文档全文或用户 HTML。
- 数据库新字段必须同步 schema、record、repository、patch 和测试。
- 不修改历史 patch；新增幂等 patch 并保证旧数据库可升级。

## 6. 生成领域规则

生成质量的完整契约见 [generation-quality-contract.md](../design/generation-quality-contract.md)。最重要的规则：

- 新规划页面必须有结论型标题、有效内容、`layoutIntent`、`visualFormat` 和 `audienceMove`。
- `audienceMove` 使用 `before → after` 表达页面对观众认知的作用。
- 用户要求的页数必须精确满足；不得用空白占位大纲静默补页。
- 内容计划元数据必须穿过生成、重试、编辑、风格切换和一键美化。
- 模型最终回复里的 HTML 可以走统一验证后救援落盘；不能绕过 page writer。
- 空回合优先在同一 Agent 会话续跑，再进入完整页面重试。
- 只有写入、静态验证和需要时的渲染门禁通过，页面才算完成。

## 7. 测试与验证

### 7.1 命令

```powershell
pnpm test -- tests/unit/<domain>/<file>.test.ts
pnpm run typecheck:node
pnpm run typecheck:web
pnpm test
git diff --check
```

如果 pnpm 版本不符合 `package.json` 的 `<11` 约束，先执行：

```powershell
corepack prepare pnpm@10.10.0 --activate
node scripts/check-toolchain.mjs
```

禁止运行 `npm run lint` 和 `npm run build`。除非用户明确要求发布，日常任务也不要跑打包命令。

### 7.2 选择测试

- bug：至少新增一个修复前失败、修复后通过的回归测试。
- 共享契约：测试当前问题和一个相邻入口。
- 数据库：测试新记录、更新记录和旧字段缺失。
- 纯 UI 样式：可以不写单测，但要检查受影响尺寸和状态。
- 大范围重构：定向测试通过后再跑全量测试和两端 typecheck。
- 资源受限环境中的超时要先单独复跑；只有能独立复现才按产品缺陷处理。

### 7.3 完成标准

任务只有同时满足以下条件才算完成：

- 根因修复覆盖所有相关入口。
- 必要的兼容、迁移和持久化已完成。
- 新增或修改的非样式行为有回归测试。
- 最小相关测试通过；跨领域变更通过两端 typecheck。
- 没有覆盖用户已有改动，`git diff --check` 无错误。
- 架构、领域契约或操作方式变化时，同步更新对应文档。

## 8. 文档维护

| 发生的变化                       | 必须更新                                 |
| -------------------------------- | ---------------------------------------- |
| 新模块、目录或职责迁移           | `PROJECT_STRUCTURE.md`                   |
| 新的强制开发规则                 | `AGENTS.md` 和本手册                     |
| 生成字段、质量门禁或覆盖链路变化 | `generation-quality-contract.md`         |
| 真实生成故障与根因修复           | `generation-issue-log.md`                |
| 新的内联模型调用                 | `node-agent-runtime-prompt-inventory.md` |
| 阶段性能力、测试统计或下一步     | `PROJECT_STATUS.md`                      |
| 发布版本或发布流程变化           | `HANDOFF.md`、`CHANGELOG.md`             |

文档记录事实和不变量，不复制大段代码。文件路径和测试名称必须可搜索；过时统计要注明日期。

## 9. AI 交付模板

后续 AI 完成任务时，最终说明至少包含：

1. 修复或实现的结果。
2. 根因或设计选择。
3. 主要文件。
4. 实际运行的测试与结果。
5. 未执行的检查及原因。
6. 仍需真实运行验证的观测点。

不要把“建议用户自己验证”当作测试结果，也不要声称运行过未实际运行的命令。
