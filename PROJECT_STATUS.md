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
- Resilience: 503/502 mapped into the shared rate-limit backoff class, plus the layout-library write-recursion hotfix.
- Full project context, architecture map, and release SOP are documented in [HANDOFF.md](./HANDOFF.md).

## Verification Policy

- Run focused Vitest files for each changed domain.
- Run `pnpm run typecheck:node` and `pnpm run typecheck:web` before release.
- Do not run `npm run lint` or `npm run build` in this workspace unless the repository instructions change.
- Activate pnpm with `corepack prepare pnpm@10.10.0 --activate`; do not use pnpm 11 to rewrite the lockfile.

## Verification Snapshot (2026-08-29)

- The Agent cost, telemetry, pnpm, dependency-cleanup, and composer-extraction work above is committed and pushed to `origin/main`.
- Full Vitest run: 340 test files / 1807 tests passed (10 environment-skipped); both TypeScript checks green.
- Lint and build were not run, per repository instructions.
- See [HANDOFF.md](./HANDOFF.md) for exact files, constraints, and next steps.

## Next Work

- Compare prompt metric fingerprints and estimated token totals on real multi-page generation runs.
- Add rendered reference previews for the universal layout catalog.
- Collect real-deck evaluation results to tune layout routing and density budgets.
- Expand image prompt planning from generic slot subjects to explicit per-slot visual briefs.
- Supply licensed per-platform ffmpeg binaries when bundled MP4 export is required.
- If in-app auto-update is ever needed, wire up `electron-updater` in the main process and publish `latest.yml` plus `.blockmap` alongside each release.
