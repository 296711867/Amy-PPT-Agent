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
- Resilience: 503/502 mapped into the shared rate-limit backoff class, plus the layout-library write-recursion hotfix.
- Full project context, architecture map, and release SOP are documented in [HANDOFF.md](./HANDOFF.md).

## Verification Policy

- Run focused Vitest files for each changed domain.
- Run `pnpm run typecheck:node` and `pnpm run typecheck:web` before release.
- Do not run `npm run lint` or `npm run build` in this workspace unless the repository instructions change.

## Next Work

- Add rendered reference previews for the universal layout catalog.
- Collect real-deck evaluation results to tune layout routing and density budgets.
- Expand image prompt planning from generic slot subjects to explicit per-slot visual briefs.
- Supply licensed per-platform ffmpeg binaries when bundled MP4 export is required.
- If in-app auto-update is ever needed, wire up `electron-updater` in the main process and publish `latest.yml` plus `.blockmap` alongside each release.
