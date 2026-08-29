<div align="center">
  <img src="docs/assets/amy-ppt-brand.svg" alt="Amy-PPT" width="720" />

# Amy-PPT

**An agent-controlled, reviewable, and editable AI presentation studio**

[中文](./README.md) · [Changelog](./CHANGELOG.md) · [Quick Start](./QUICK_START.md) · [Handoff](./HANDOFF.md) · [Changelog](./CHANGELOG.md) · [Issues](https://github.com/296711867/Amy-PPT-Agent/issues) · [Releases](https://github.com/296711867/Amy-PPT-Agent/releases)

</div>

Amy-PPT is an Electron desktop presentation workbench. Instead of asking a model to emit a collection of web pages in one pass, it runs a controlled workflow for planning, page generation, validated persistence, rollback, deck-level visual review, and narrative review.

For the first-run workflow, see the [quick start guide](./QUICK_START.md) (Chinese).

![Amy-PPT home](docs/screenshots/amy-ppt-home.png)

## Highlights

- Agent-driven deck creation from a topic, detailed brief, or source document.
- Editable Layout Rules and an expert Markdown editor for canvas, typography, safe areas, spacing, cards, and narrative structure.
- A universal layout library for 1-6 text sections, mixed image/text compositions, and 2/3/4/6-image galleries, with adjacent-slide silhouette rotation.
- A layout-asset system with builtin layouts, automatic harvesting from enterprise PPTX templates, slot parametrization, deterministic content filling, and a locked-layout zero-LLM mode.
- A per-page layout console: module-count slider, in-style palette switching, focus and layout switching, all applied locally.
- A plugin-oriented runtime: model provider registry (Anthropic, OpenAI, Responses, Gemini, Zhipu, DeepSeek, Kimi), generation event bus, session event log, and YAML profiles.
- Visual element preferences that plan chart, image, and table usage into the outline up front.
- HTML and rendered-page harnesses for structure, typography, clipping, overflow, overlap, canvas, and font contracts.
- Deck-level review for palette, titles, margins, density, layout rhythm, and web-dashboard patterns.
- Narrative review for process leakage, repetition, slide responsibilities, evidence interpretation, openings, and conclusions.
- Document-to-PPT support for Markdown, TXT, CSV, DOCX, and image references with page-scoped retrieval.
- Visual, full-page, deck, and selector-scoped editing with differential validation and rollback.
- PPTX import, HTML presentation, editable PPTX export, templates, styles, fonts, and media workflows.
- Local-first storage with user-configured model providers.
- Extensible application themes, including Warm Apricot Coral and Pastel.

## Development

Requires Node.js 20+ and pnpm 10.10.0. Use Corepack to activate the exact repository version:

```bash
corepack enable
corepack prepare pnpm@10.10.0 --activate
node scripts/check-toolchain.mjs
pnpm install
pnpm dev
```

Run focused verification with:

```bash
pnpm run typecheck:node
pnpm run typecheck:web
pnpm test -- tests/unit/path/to/test.test.ts
```

## Updates

Amy-PPT uses its own update manifest. The current version is `1.0.4`:

```text
https://raw.githubusercontent.com/296711867/Amy-PPT-Agent/main/version.json
```

Override it for private or self-hosted releases with `AMY_PPT_UPDATE_MANIFEST_URL`.

## License

Amy-PPT is a derivative project based on [arcsin1/oh-my-ppt](https://github.com/arcsin1/oh-my-ppt).

The upstream project was developed by arcsin1 `<zy19931129@gmail.com>` and released under the Apache License 2.0, Copyright 2026 arcsin1. Amy-PPT remains licensed under the Apache License 2.0 and retains the upstream license and attribution. See this repository's [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
