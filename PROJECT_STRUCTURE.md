# Amy-PPT Project Structure

## Runtime Code

- `src/main/`: Electron main process, Agent runtime, generation/edit flows, persistence, import/export, and presentation validation.
- `src/renderer/`: React renderer application, pages, components, Zustand stores, UI themes, and IPC clients.
- `src/shared/`: Cross-process types, contracts, layout catalogs, error models, and shared constants.
- `resources/`: Packaged runtime assets, fonts, product skills, style packages, presentation runtimes, and Amy-PPT brand assets.

## Main-Process Module Map

- `src/main/db/`: persistence facade plus split layers. `schema.ts` holds Drizzle tables, `records.ts` holds row/union types, `repositories/` holds per-domain CRUD classes, `services/` holds cross-repository business logic, and `database.ts` (`PPTDatabase`) remains the single facade every caller imports. Historical migrations stay in `db/patch/`.
- `src/main/generation/planning/`: LLM planning extracted from the runner — deck/page planners, the design-contract builder, and model JSON response parsing (`model-response.ts`). `agent-runner.ts` re-exports the planner entry points, so existing imports keep working.
- `src/main/generation/`: the runner layer around `agent-runner.ts` (285-line orchestrator: dispatch + concurrency gate + circuit breaker + summary) — `runner-shared.ts` (locale/model-control/file/signal helpers), `page-refs.ts` (PageRef resolution with layout-master prompts), `deck-generation-types.ts` (run args/result contract), `page-progress-tracker.ts` (page progress aggregation and status emit), `single-page-generator.ts` (per-page worker with retry, rate-limit backoff, method-signal escalation, rescue writes), `deck-review-repair.ts` (deck quality + narrative review and targeted repairs), `deck-edit-runner.ts` (page/deck/selector edit runs), and `title-band-anchor.ts` (deck title-band anchor extraction for regenerations). `agent-runner.ts` re-exports the edit entry points too.
- `src/main/io/pptx-import/`: layered PPTX import — `index.ts` orchestrates parse → sample → render → persist, on top of `element-model.ts` (geometry/layer ordering), `sanitize.ts` (HTML/CSS allowlist sanitizing and typography scaling), `image-registry.ts` (data-url image dedup), `style-css.ts` (fill/border/shadow/gradient/table/XML-shape text CSS), `block-builders.ts` (text/image/vector-shape/table blocks), and `slide-render.ts` (element dispatch, slide HTML, title inference, animation matching). Dependencies point one way; nothing below `block-builders` imports `slide-render`.
- `src/main/generation/agent-stream-processor.ts`: shared deepagent stream-loop handling (tool-event logging, custom `deck_tool_status` chunks, final assistant text).
- `src/main/generation/outline-normalizer.ts`: page-plan normalization and bounded structured-content preservation. New plans retain claim/metric/detail text and normalize the `before → after` audience transition.
- `src/main/agent-runtime/prompt/`: typed prompt templates/composers plus log-safe prompt metrics. `metrics.ts` records only counts and a short fingerprint; it must never log prompt content. `composers/single-page-agent-user.ts` assembles the full single-page agent user prompt (run addenda, retry repair, template inspection, per-page data), keeping `generation/agent-runner.ts` lean and the assembly unit-testable.
- `src/main/agent-runtime/token-estimate.ts`: shared CJK-aware fallback estimator used by prompt telemetry and model-usage persistence when providers omit usage metadata.

## Renderer Module Map

- `src/renderer/src/components/session-detail/`: the session detail page component tree (hooks, ai-panel, workspace, preview, sidebar, browse, style, speech, toolbar, modal, element-inspector, shared). `pages/session-detail.tsx` only assembles these pieces.
- `src/renderer/src/components/presentation-webview/`: preview URL construction and webview runtime injection shared by `PreviewIframe` and `HtmlEditorCanvas` (`webview-utils.ts`, `usePresentationWebviewRuntime.ts`).
- `src/renderer/src/components/preview/`: the preview surface split — `PreviewIframe.tsx` assembles webview commands, the console router, lifecycles, and scaling; `webview-commands.ts` holds the `PreviewIframeHandle` contract and the imperative command factory; `usePreviewConsoleRouter.ts` owns element anchoring and console-event dispatch; `PreviewIframeHelpers.ts` holds pure predicates. The handle type and predicates stay re-exported from `PreviewIframe.tsx`.
- `src/renderer/src/store/editHistoryStore.ts`: shared edit-history implementation and store creator. `useEditHistoryStore` and `useHtmlEditHistoryStore` are separate instances built from the same creator; they must remain state-isolated. Per-page undo/redo history is bounded to 100 snapshots.

Source-contract tests under `tests/unit/` read these files as text; when moving code between modules, update the paths they read in the same change.

## Development And Release

- `tests/unit/`: Vitest regression tests grouped by functional domain.
- `scripts/`: Maintainer scripts for deterministic brand/icon assets, `check-toolchain.mjs` for Node/pnpm diagnostics, and `check-prompt-cache.mjs` for verifying per-deck system-prompt fingerprint stability from real generation logs.
- `build/`: Electron Builder hooks and application icons required for packaging.
- `docs/assets/`: README-facing brand assets.
- `docs/screenshots/`: Curated product screenshots used by project documentation.
- `docs/development/AI_DEVELOPMENT_GUIDE.md`: mandatory AI development workflow, architecture boundaries, coverage matrix, validation policy, and documentation maintenance rules.
- `docs/design/generation-quality-contract.md`: authoritative generation-plan, lifecycle, persistence, retry, and quality-gate contract.
- `docs/design/generation-issue-log.md`: append-only real-run issue ledger; do not delete resolved entries.
- `docs/design/node-agent-runtime-prompt-inventory.md`: registry of intentionally inline model builders.

## Root Files

- `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml`: package contract, reproducible dependency graph, pnpm overrides, supported architectures, and native build allowlist. Keep the root importer synchronized with direct dependencies.
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
