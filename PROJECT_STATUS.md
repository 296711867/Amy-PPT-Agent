# Amy-PPT Project Status

## Current Release

- Product: Amy-PPT
- Development version: `1.0.4`
- Published update manifest: `1.0.4`
- Repository: `https://github.com/296711867/Amy-PPT-Agent`
- Stack: Electron 39, React 19, TypeScript, LangChain/Deep Agents, libSQL/Drizzle, Vitest

## Completed

- All `1.0.3` milestones: GLM compatibility, rate-limit backoff, image-placeholder mode, theme rollout, and the reusable release publishing flow.
- Plugin-oriented runtime: model provider registry with seven builtin providers (DeepSeek and Kimi included), typed generation event bus, append-only session event log, and YAML profiles.
- Layout-asset system: builtin layouts, enterprise PPTX template harvesting with logo/header/footer filtering, slot parametrization, and deterministic locked-layout filling with structured content packages (`value` / `unit` / `priority`).
- Per-page layout control panel: module-count, palette, focus, and layout switching without AI round-trips.
- Visual element preferences for chart, image, and table planning in the outline.
- Workflow performance work: shared prompt-rule deduplication, non-blocking visual review, parallel background generation, preflight spec gate, and asset-integrity validation.
- Unreleased Agent cost work: single-page generation no longer exposes the general-purpose subagent; per-page variables moved out of the system prompt so pages in one deck share an identical cacheable system prompt; duplicated user-prompt rules were removed (with the fact-duplication and explicit-topic-list guardrails relocated into the deck-system template).
- Unreleased usage observability: log-safe system/user prompt metrics (characters, UTF-8 bytes, estimated tokens, stable fingerprint) and one shared CJK-aware fallback estimator for prompt telemetry and persisted model usage.
- Unreleased toolchain cleanup: pnpm 10.10.0/Corepack contract, valid Electron mirror npmrc settings, workspace-level pnpm configuration, toolchain doctor, corrected repository metadata, and seven unused direct dependencies removed.
- Unreleased maintainability: single-page user-prompt assembly extracted into `agent-runtime/prompt/composers/single-page-agent-user.ts` with focused unit tests, slimming `generation/agent-runner.ts`.
- Unreleased cache verification: a deterministic 10-page prompt-cost benchmark (`tests/unit/prompt/deck-prompt-cost.test.ts`) proves per-deck system-prompt byte stability and quantifies the dedup pass (~74% estimated user-prompt tokens saved on the fixture deck), and `scripts/check-prompt-cache.mjs` verifies the same fingerprint invariant against real electron-log output after a live generation.
- Unreleased pptx-import split: the 2168-line importer entry is now six one-way layered modules (element model, HTML/CSS sanitize, image registry, style CSS, block builders, slide render) plus a thin orchestration entry, with split regression tests and an updated io boundary inventory.
- Unreleased runner/preview splits: `generation/agent-runner.ts` (1747 → 285) now orchestrates seven layered modules (shared helpers, page refs, run types, progress tracker, single-page generator with retry/backoff, deck review-repair, edit runner) with all legacy exports re-exported; `PreviewIframe.tsx` (1423 → 318) assembles a webview-command factory, a console-router hook, and pure helpers, re-exporting its handle type and predicates.
- Unreleased title-band stability: regenerating or retrying a page now injects the deck's existing title band (extracted deterministically from the lowest-numbered written conventional page, falling back to the retried page's own previous version) as a hard prompt requirement, so the title band no longer shifts between attempts; cover/quote/image-focus pages and template imports are exempt, matching the deck quality validator's drift rules.
- Resilience: 503/502 mapped into the shared rate-limit backoff class, plus the layout-library write-recursion hotfix.
- Full project context, architecture map, and release SOP are documented in [HANDOFF.md](./HANDOFF.md).

## Verification Policy

- Run focused Vitest files for each changed domain.
- Run `pnpm run typecheck:node` and `pnpm run typecheck:web` before release.
- Do not run `npm run lint` or `npm run build` in this workspace unless the repository instructions change.
- Activate pnpm with `corepack prepare pnpm@10.10.0 --activate`; do not use pnpm 11 to rewrite the lockfile.

## Verification Snapshot (2026-08-29)

- The Agent cost, telemetry, pnpm, dependency-cleanup, composer-extraction, and cache-verification work above is committed and pushed to `origin/main`.
- Full Vitest run: 345 test files / 1830 tests passed (10 environment-skipped); both TypeScript checks green.
- Lint and build were not run, per repository instructions.
- See [HANDOFF.md](./HANDOFF.md) for exact files, constraints, and next steps.

## Next Work

- Generate one real deck, then run `node scripts/check-prompt-cache.mjs` to reconcile live fingerprint stability and token totals against the offline benchmark.
- Add rendered reference previews for the universal layout catalog.
- Collect real-deck evaluation results to tune layout routing and density budgets.
- Expand image prompt planning from generic slot subjects to explicit per-slot visual briefs.
- Supply licensed per-platform ffmpeg binaries when bundled MP4 export is required.
- If in-app auto-update is ever needed, wire up `electron-updater` in the main process and publish `latest.yml` plus `.blockmap` alongside each release.
