# AGENTS.md — Documentation website adapter

Follow the [root instructions](../AGENTS.md), the [documentation standard](../docs/AGENTS.md), and the [documentation workflow](../.agents/skills/dsh-doc/SKILL.md).

## Keep documentation content out of this tree

`website/` owns only VitePress configuration, presentation assets, and the publication manifest; this file is the only maintained Markdown here.

Keep canonical prose and generated catalogs in their owning `docs/` tier, then expose selected pages through [docs.ts](docs.ts). Never add locale, route, API, or copied documentation trees such as `website/zh-CN/`, `website/en/`, or `website/api/`.

The projector writes disposable Markdown to the ignored `website/.generated/`; never edit or commit `.generated/`, `.cache/`, or `.dist/`. Production-build output removal, path-escape rejection, raw-Markdown twins, and the root `llms.txt` belong to the emitter and derive from the publication manifest.

Run `pnpm docs:check` after changing this subtree; the gate rejects additional non-ignored Markdown under `website/`.

Content-page Markdown actions use the projector's `rawMarkdownPath` and the site base; copy fetches carry `?dsh-raw=1`. Keep clipboard work within its initiating gesture and page lifetime; the [Markdown actions decision](../.agents/notes/implemented/feature/2026-09-15-docs-page-markdown-actions.md) owns browser limitations and verification.

The default-theme extension shares one fullscreen modal and pan/zoom controller between Mermaid diagrams and standalone content images; keep enhancements separate from Markdown projection and close the active view on route, language, theme, or source replacement. The [viewer decision](../.agents/notes/implemented/feature/2026-09-14-docs-mermaid-viewer.md) owns image eligibility and verification.

Native code groups keep their radio controls in separate forms; search excerpts and MPA builds display every command block because tab switching is unavailable. The [platform-tab decision](../.agents/notes/implemented/feature/2026-09-15-docs-platform-command-tabs.md) owns the interaction and verification.
