# Amy-PPT Project Status

## Current Release

- Product: Amy-PPT
- Development version: `1.0.5`
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
- Unreleased document-parse split: io/document-parse-handlers.ts (1471 → 363) keeps only IPC registration; the parsing pipeline is now five layered modules (source preparation, plan quality, plan model, page summaries, image plan) with contract tests following the moved code.
- Unreleased renderer IPC facade split: renderer/lib/ipc.ts (1666 → 28-line facade) now merges six domain modules under lib/ipc/ (core, types, sessions, generation, workspace, settings, styles, system) with every type and the ipc object re-exported; the preload channel-allowlist policy test scans the whole directory so no module bypasses it.
- Unreleased runner/preview splits: `generation/agent-runner.ts` (1747 → 285) now orchestrates seven layered modules (shared helpers, page refs, run types, progress tracker, single-page generator with retry/backoff, deck review-repair, edit runner) with all legacy exports re-exported; `PreviewIframe.tsx` (1423 → 318) assembles a webview-command factory, a console-router hook, and pure helpers, re-exporting its handle type and predicates.
- Unreleased title-band stability: regenerating or retrying a page now injects the deck's existing title band (extracted deterministically from the lowest-numbered written conventional page, falling back to the retried page's own previous version) as a hard prompt requirement, so the title band no longer shifts between attempts; cover/quote/image-focus pages and template imports are exempt, matching the deck quality validator's drift rules.
- Unreleased run-resilience fixes from a real generation: placeholder scaffold pages can no longer supply the title-band anchor (their bare band was being replicated across regenerations), bare h1 title elements now get the 48px shell floor, and hidden-window render validation waits 25s and retries once on timeout instead of failing every page at 10s on loaded machines.
- Unreleased generation-quality contract: deck and single-page planning now require an actionable `visualFormat` plus a `before → after` `audienceMove`, preserve richer structured outline evidence, reject page-count drift instead of padding empty slides, and persist the full page-plan package across generation, retry, page/deck edit, style switch, page beautify, and deck-review failure paths.
- Unreleased empty-turn recovery: main-graph Agent conversation messages are retained, GLM 5+ avoids the unsupported `thinking.type=disabled` parameter, and a tool-less/text-less model turn continues in the same Agent session up to two times before consuming a full page retry.
- Unreleased editor-history cleanup: the session editor and standalone HTML editor now use isolated instances of one shared Zustand history implementation; native `structuredClone` replaces manual cloning and each page is bounded to 100 undo/redo snapshots.
- AI development governance is now centralized in [docs/development/AI_DEVELOPMENT_GUIDE.md](./docs/development/AI_DEVELOPMENT_GUIDE.md), with the generation-specific invariants in [docs/design/generation-quality-contract.md](./docs/design/generation-quality-contract.md). `AGENTS.md` requires future agents to use both documents and maintain the issue ledger.
- Prompt-cache reconciliation on the real dev log (project logs/main.log): one system fingerprint across 10 agent calls, system 11390 tokens per deck, user 1607-2302 tokens per page.
- Generation issue log: real-run defects from 2026-08-30 (render-validation timeouts failing whole decks, locked-layout shell/palette gaps, placeholder-image loss on the source-plan path, misleading "page not written" retry feedback) are tracked with root causes and fixes in [docs/design/generation-issue-log.md](./docs/design/generation-issue-log.md); append new real-run defects there before fixing them.
- Resilience: 503/502 mapped into the shared rate-limit backoff class, plus the layout-library write-recursion hotfix.
- Full project context, architecture map, and release SOP are documented in [HANDOFF.md](./HANDOFF.md).

## Verification Policy

- Run focused Vitest files for each changed domain.
- Run `pnpm run typecheck:node` and `pnpm run typecheck:web` before release.
- Do not run `npm run lint` or `npm run build` in this workspace unless the repository instructions change.
- Activate pnpm with `corepack prepare pnpm@10.10.0 --activate`; do not use pnpm 11 to rewrite the lockfile.

## Verification Snapshot (2026-08-29)

- Dev logs now rotate daily with a 7-day prune (logs/main-YYYY-MM-DD.log); deck quality and narrative review outcomes persist into session_events (deck-quality/reviewed, deck-narrative/reviewed) for UI timelines; check-prompt-cache.mjs now reports title-band anchor health (bare-band warnings) and render-validation resilience alongside fingerprint stability.
- Dependency audit closed: all 61 runtime and 27 dev dependencies verified in use (ESM/dynamic/require/postcss-plugin/tsconfig reference forms); zero removal candidates, lockfile root importer fully consistent with package.json. Radix packages are direct deps with live wrappers; react-slot et al. remain only as normal Radix-internal transitives.

- The Agent cost, telemetry, pnpm, dependency-cleanup, composer-extraction, and cache-verification work above is committed and pushed to `origin/main`.
- Full Vitest run: 345 test files / 1830 tests passed (10 environment-skipped); both TypeScript checks green.
- Lint and build were not run, per repository instructions.
- See [HANDOFF.md](./HANDOFF.md) for exact files, constraints, and next steps.

## Verification Snapshot (2026-08-31)

- Full Vitest run with four workers: 352 test files passed; 1898 tests passed and 10 environment/configuration tests skipped (1908 total).
- Node and Web TypeScript checks passed; `git diff --check` passed.
- Generation planning, metadata preservation, empty-turn continuation, page-write rescue, Deck review failure persistence, and isolated bounded edit history have focused regression coverage.
- Lint and build were not run, per repository instructions.

## Verification Snapshot (2026-09-03)

- Template-generation workflow fixed and iterated on a real run (恒流LED模板 → 运放培训大纲):
  - I-15: never-started template sessions no longer get their seed pages "recovered" to completed, and the generating page honors manual start intent instead of redirecting to the editor.
  - I-16: the template brief persists at session creation (`templateInitialPrompt`), `animationPreferences` flows through the template chain (payload → run persistence → retry inheritance → per-page runner), and `ImagePolicy` gains `'none'` as the template default so template visuals are no longer forced into image-slot layouts with placeholder injections.
  - Template use dialog now exposes 配图策略 (keep-template-visuals / placeholders / AI) and animation preference chips; font/AI-background/visual-element options stay out deliberately (the template page base is the visual source of truth).
- Full Vitest run: 354 test files passed; 1907 tests passed and 10 environment/configuration tests skipped (1917 total). Node and Web TypeScript checks passed.
- Lint and build were not run, per repository instructions.

## Verification Snapshot (2026-09-05)

- Template generation I-18–I-25 was validated against the resumed 15-page operational-amplifier run: all 15 pages changed from their template seed fingerprints, no LED seed text remained, every page reached a persisted terminal state, and transient model failures no longer create false completion.
- Editable PPTX export I-26 was validated on the resulting 15-page deck: full-slide static backgrounds retain DOM stacking order, uniform fills no longer trigger false text-residue rasterization, all slides render correctly, and every slide retains text nodes.
- Focused regression run: 43 test files passed, 302 tests passed and 9 environment-dependent tests skipped. Node and Web TypeScript checks and `git diff --check` passed.
- Lint and build were not run, per repository instructions.

## Next Work

- Repeat the template-generation and editable-export acceptance run with another provider/template pair to broaden real-world coverage.
- Add rendered reference previews for the universal layout catalog.
- Collect real-deck evaluation results to tune layout routing and density budgets.
- Expand image prompt planning from generic slot subjects to explicit per-slot visual briefs.
- Supply licensed per-platform ffmpeg binaries when bundled MP4 export is required.
- If in-app auto-update is ever needed, wire up `electron-updater` in the main process and publish `latest.yml` plus `.blockmap` alongside each release.
