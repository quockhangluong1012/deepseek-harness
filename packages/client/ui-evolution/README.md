---
description: "Evolution journey page and its Host evolutionCurator status Remote face over the per-scope evolution record."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-evolution

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-evolution` owns the evolution journey page and this package's `evolutionCurator` Remote namespace. The page shows one Scope's recorded evolution over a switchable window (today, 7 days, 30 days, all) with the day buckets the read model proves — instructions, lessons, and profile writes, context attachments, produced files, staged writes, and the staged decisions counted per day — beside the staged writes awaiting a decision, the Scope's current lesson artifacts rendered strongest-first with their confidence, the curator's recorded passes, and the brief's charged bytes against the record's ceiling. Scope verbs live on the Host `ctx.evolutionController` (`evolution` namespace); the curator status face exists here because a browser cannot read a Host Cordis service.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row in the `web-app` bundle beside the evolution Host rows and the controller. The page is a global panel: its sidebar row (the `sidebar.panellist` list id `evolution-journey`) selects the center-track `main` keyed panel of the same name, so the surface is additive — it neither replaces the conversation nor contends for the single `shell.page` seat the Workspace page owns.

The panel follows the selected Session's Workspace as its Scope. With no Session, or a Session the Workspace registry no longer lists, it renders the no-Scope state instead of a blank column. Approved and rejected staged writes are retired by identity through the controller, and the timeline is refetched so the day counts catch up.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

No invariant companion is published: the Host face projects the mounted curator without holding independent state.

### Design concept

The browser half reads two Remote namespaces: the controller's `evolution` (Scope reads, staged decisions, the journey timeline, and the follow stream) and this package's `evolutionCurator` (the curator's recorded passes plus today's cache-hit share and the aggregate skill failure rate). The follow stream keeps one complete baseline per generation and an upsert per durable Scope change, so a background extraction or an approval lands without a refetch; the page's own record projection carries the pending list, which makes a decision retire its row in the same step the controller answers.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host `evolutionCurator` status face over the mounted curator |
| [`src/types.ts`](src/types.ts) | Browser-safe Remote vocabulary |
| [`src/client/index.ts`](src/client/index.ts) | Sidebar panel row, center-track panel, and dictionaries |
| [`src/client/rpc.ts`](src/client/rpc.ts) | Throwing page verbs and the follow subscription |
| [`src/client/Seat.tsx`](src/client/Seat.tsx) | Panel-row glyph and Session → Scope mapping |
| [`src/client/Page.tsx`](src/client/Page.tsx) | The page: timeline, pending decisions, curator, capacity |
| [`src/client/locales.ts`](src/client/locales.ts) | Typed dictionaries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary harness specification](../../../specs/evolutionary-harness.spec.md) — the behaviour contract the Host half implements.
- [Improvement specification](../../../specs/improvement.spec.md) — the journey read model and the page's acceptance.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-evolution-memory-context`, which renders the scope's brief into the request; this package only displays what those writes recorded.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix, so it cannot invalidate provider cache reuse.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Web only** — the page lives in the web composition; other profiles have no surface.
- **No journey export or web scenario** — the specification's ZIP export and the `snapshots/web/evolution-journey` scenario are out of scope for this slice; the user waived snapshot work, so the page is verified on the real surface instead.
- **The curator card reads passes and two rates** — today's cache-hit share and the aggregate skill failure rate, each hidden when its source is unmounted or holds no loads; transitions, rollback, and consolidation reports stay CLI surfaces.
- **Read-only brief** — the page displays charged bytes and the digest; editing instructions, lessons, and profile stays with the CLI until the page grows those editors.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The page occupies a `main` keyed panel rather than `shell.page` on purpose: `shell.page` is a single-occupancy seat already owned by the Workspace page, and two conditional occupants collide in both directions.

</details>
