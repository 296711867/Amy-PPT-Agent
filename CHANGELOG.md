# Amy-PPT Changelog

## Unreleased

- Added a card-grid view to the thinking page-outline panel: list/grid toggle, 16:9 slide-style placeholder cards (three per row, panel auto-widens), and dialog-based per-page outline editing.
- Fixed a generation retry dead loop: when a page write was rejected by quality validation (e.g. `font-below-floor`) and the model never re-called the write tool, the outer "page not written" error now preserves the last validation details, and retry prompts teach the explicit font-size fixes (canvas floors, auxiliary-text marking) instead of looping until retries are exhausted.
- Unified the title band across generated decks: reversed the three "vary title position" instructions (system prompt, layout skill, expert profile), promoted the title band to a deck-level hard contract, and upgraded `deck-title-anchor-drift` to an error-level check that also compares title font sizes against the deck median.
- Raised presentation-scale typography and icon defaults on the 1600×900 canvas: body 20→24px, module title 24→28px, slide subtitle 26→28px, slide title 40→48px (aligned with the runtime 48px title clamp), emphasis 52→56px, icon backing 52→64px, and card padding 24→32px; the composition profile now requires cutting copy before shrinking type when the height budget is exceeded.
- Split the oversized core files into maintainable modules with no behavior change: `db/database.ts` (3758→2767 lines) now delegates to `db/records.ts` (row/union types), seven `db/repositories/*` classes, and `db/services/*`; `generation/agent-runner.ts` (2595→1800 lines) extracted `generation/planning/*` (deck/page planners, design-contract builder, model JSON parsing) and `agent-stream-processor.ts`; `pages/session-detail.tsx` (1894→1270 lines) moved its UI and logic into `components/session-detail/*` (98 files: `hooks/`, `ai-panel/`, `workspace/`, `preview/`, `sidebar/`, `modal/`, etc.); `PreviewIframe`/`HtmlEditorCanvas` share the new `components/presentation-webview/*` runtime helpers.
- Realigned regression tests with the refactored layout: source-contract assertions now read the new module paths (`db/records.ts`, `useSessionGenerationEvents.ts`, `presentation-webview/webview-utils.ts`), layout-profile expectations follow the raised typography defaults, the update-manifest URL follows the renamed `Amy-PPT-Agent` repository, and the symlink-escape test self-skips on Windows without symlink privilege.
- Completed the db layering: `db/database.ts` (2746→2039 lines) now also delegates generation runs/jobs/pages to `repositories/generation-run-repository.ts` and session pages/source skeletons to `repositories/session-page-repository.ts` (nine repositories total); the create-data input types moved next to their repositories, and focused repository tests cover the run/job lifecycle, page snapshots, soft/hard deletes, reordering, and skeleton replacement.

## 1.0.4 - 2026-08-27

- Added the plugin-oriented architecture: model provider registry (DeepSeek and Kimi included), typed generation event bus, append-only session event log, and YAML profiles.
- Added the enterprise template workflow: automatic layout harvesting from uploaded PPTX with logo/header/footer filtering, plus a per-page layout control panel (module count, palette, focus, and layout switching without AI round-trips).
- Added visual element preferences so the planner explicitly charts image and table usage into the outline.
- Added structured content packages with `value` / `unit` / `priority` on key points and deterministic locked-layout filling.
- Improved workflow performance: shared prompt-rule deduplication, non-blocking visual review, parallel background generation, and a preflight spec gate.
- Mapped 503/502 service-unavailable responses into the rate-limit backoff class alongside 429.
- Unified the five UI themes across every page and fixed a layout-library write recursion that could exhaust disk space.

## 1.0.3 - 2026-08-18

- Added GLM-5.2 reasoning-mode compatibility and fixed shutdown crashes.
- Added automatic rate-limit backoff, configurable generation concurrency, and quota-aware failure reporting.
- Switched model validation to streaming and raised the output-token ceiling to reduce truncated full-page generation.
- Added an explicit image-placeholder mode with semantic replacement guidance.
- Applied the five application themes to conversation creation, quick creation, and session workflows.
- Added the reusable Windows GitHub release publishing script.

## 1.0.2 (Not separately released; included in 1.0.3)

- Restricted renderer IPC access to an explicit channel allowlist and hardened main-window and WebView navigation.
- Kept stored text and image-model credentials in the main process and bound credential reuse to the original provider endpoint.
- Added staged export output, session runtime refresh before export, and failure cleanup that preserves existing targets.
- Improved session, editing, preview, and recovery failure handling with focused regression coverage.
- Normalized generic and GLM model responses while preserving streamed tool calls and actionable errors.
- Made `minimal-white` the stable fallback style across standard and Thinking generation flows.
- Hardened render-readiness validation, incomplete-page rejection, and failed-page retry behavior.
- Added continuous type-check and unit-test verification and aligned release metadata and documentation.

## 1.0.1

- Added the three-level font system, reusable font schemes, and generated deck backgrounds.
- Curated 44 presentation-oriented styles and expanded the universal layout catalog to 39 compositions.
- Added semantic template roles, fidelity guards, per-slide visual-format planning, and editorial diagram guidance.
- Added repeated-failure escalation, render-level visual review, and chart-pattern recall.
- Improved GLM compatibility, page retry selection, thumbnail recovery, and targeted regression coverage.

## 1.0.0

- Established Amy-PPT as an independent desktop product identity.
- Added multiple application UI themes with Warm Apricot Coral as the default direction.
- Added editable Layout Rules and an expert Markdown editor.
- Added a 28-layout universal presentation library covering 1-6 text modules, mixed image/text compositions, and 2/3/4/6-image galleries.
- Added deterministic adjacent-slide silhouette rotation and persisted layout/image-slot recovery across retry, edit, template, and style-switch flows.
- Added opt-in per-slot AI image generation with replaceable placeholder fallback.
- Added controlled page persistence, rendered-page checks, rollback, and generation recovery.
- Added deck-level visual consistency review and bounded repair.
- Added deterministic and LLM-assisted presentation narrative review.
- Added source-document planning and page-scoped retrieval for document-to-PPT generation.
- Preserved editable HTML/PPTX workflows, style management, templates, fonts, and media tools.
