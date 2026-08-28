# Amy-PPT Project Structure

## Runtime Code

- `src/main/`: Electron main process, Agent runtime, generation/edit flows, persistence, import/export, and presentation validation.
- `src/renderer/`: React renderer application, pages, components, Zustand stores, UI themes, and IPC clients.
- `src/shared/`: Cross-process types, contracts, layout catalogs, error models, and shared constants.
- `resources/`: Packaged runtime assets, fonts, product skills, style packages, presentation runtimes, and Amy-PPT brand assets.

## Main-Process Module Map

- `src/main/db/`: persistence facade plus split layers. `schema.ts` holds Drizzle tables, `records.ts` holds row/union types, `repositories/` holds per-domain CRUD classes, `services/` holds cross-repository business logic, and `database.ts` (`PPTDatabase`) remains the single facade every caller imports. Historical migrations stay in `db/patch/`.
- `src/main/generation/planning/`: LLM planning extracted from the runner — deck/page planners, the design-contract builder, and model JSON response parsing (`model-response.ts`). `agent-runner.ts` re-exports the planner entry points, so existing imports keep working.
- `src/main/generation/agent-stream-processor.ts`: shared deepagent stream-loop handling (tool-event logging, custom `deck_tool_status` chunks, final assistant text).

## Renderer Module Map

- `src/renderer/src/components/session-detail/`: the session detail page component tree (hooks, ai-panel, workspace, preview, sidebar, browse, style, speech, toolbar, modal, element-inspector, shared). `pages/session-detail.tsx` only assembles these pieces.
- `src/renderer/src/components/presentation-webview/`: preview URL construction and webview runtime injection shared by `PreviewIframe` and `HtmlEditorCanvas` (`webview-utils.ts`, `usePresentationWebviewRuntime.ts`).

Source-contract tests under `tests/unit/` read these files as text; when moving code between modules, update the paths they read in the same change.

## Development And Release

- `tests/unit/`: Vitest regression tests grouped by functional domain.
- `scripts/`: Maintainer scripts for deterministic brand and icon asset generation.
- `build/`: Electron Builder hooks and application icons required for packaging.
- `docs/assets/`: README-facing brand assets.
- `docs/screenshots/`: Curated product screenshots used by project documentation.

## Root Files

- `package.json` and `pnpm-lock.yaml`: package contract and reproducible dependency graph.
- `electron-builder.yml`, `electron.vite.config.ts`, and TypeScript/PostCSS/Tailwind/Vitest configs: build and development configuration.
- `README.md`, `README_EN.md`, `QUICK_START.md`, `CHANGELOG.md`, `LICENSE`, and `NOTICE`: product documentation and legal attribution.
- `version.json`: public update manifest for the current `1.0.4` release.

## Local-Only Outputs

The following are development or user-state artifacts and must not be committed:

- `node_modules/`, `out/`, and `dist/`
- `logs/` and root `*.log*` files
- `*.db` local databases and their `*.db-wal` / `*.db-shm` sidecars
- TypeScript build-info files and ESLint caches

These paths are covered by `.gitignore`. Database files can contain local sessions, provider settings, and other user data.

## Compatibility Names

Some internal names still contain `ohmyppt` or `oh-my-ppt`. They are compatibility identifiers for migrated databases, local-storage keys, runtime bridge messages, session assets, or historical tests. Do not rename them without a dedicated migration that covers existing sessions and runtime assets.

## Placement Rules

- Production behavior belongs under the owning `src/` domain.
- Shared runtime contracts belong in `src/shared/`, not renderer-only helpers.
- New regressions belong in `tests/unit/<domain>/`.
- Packaged assets belong in `resources/`; documentation-only media belongs in `docs/`.
- Generated local output must remain ignored. Do not add suffix chains such as `new`, `final`, or `v2`; use version control.
