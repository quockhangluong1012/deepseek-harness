# Agent Note: Client programs type-check against node-free type leaves

Status: implemented

English | [中文](2026-09-12-client-program-node-free-type-leaves.zh.md)

## Problem

`pnpm run dev:desktop` builds the repository before launching Electron, and that build's two TypeScript aggregates carried roughly 2000 errors, nearly all of them in the `tsconfig.client.json` lane.

The client aggregate resolves workspace package names through the `paths` map in [tsconfig.base.json](../../../../tsconfig.base.json), which points every package at its `src` tree. A client program that imported a built declaration naming such a package pulled that package's source into the client program: `@deepseek-ai/dsh-api-remotes/client` named every Remote package's generated `typert.remote-client.d.ts`, and [evolution-controller](../../../../packages/evolution/evolution-controller/src/types.ts) re-exported its wire vocabulary from two host implementation packages. The client program then type-checked `node:crypto`, `Buffer`, and `process.env` reads under the client face's `types: ["client-build-environment"]` — node types are deliberately absent there — and the host `sessions: SessionStore` Context merge landed beside the client `sessions: ISessions` merge in one program, so client call sites such as `ctx.sessions.binding(...)` resolved against the host service and failed.

Two smaller defects hid in the same lane. The client face lists `lib` explicitly for the DOM, which drops `Disposable`; node types supply a compatibility declaration for host programs, so only client programs reported the missing global. And `apps/web/tsconfig.json` excluded host-plane e2e helpers while a new host-booting e2e file stayed in its `include`, pulling `tests/scaffold.ts` and the whole host spine into the client-registered project.

## Decision

Shared wire vocabulary lives in a node-free `types.ts` leaf that carries a `./types` export, and every package whose generated declarations name a `/types` subpath carries a matching `paths` entry, so a client program reaching that subpath reads the leaf rather than an implementation module.

[packages/evolution/command-evolution/src/types.ts](../../../../packages/evolution/command-evolution/src/types.ts) is that leaf for the `/journey` timeline vocabulary — the delta, calendar-bucket, cumulative, and pending types moved out of `journey.ts`, which re-exports them so its own surface is unchanged. The package's `./types` export points at `lib/types/types.{d.ts,js}`, which is what the typert-generated Remote client already imported.

[evolution-controller/src/types.ts](../../../../packages/evolution/evolution-controller/src/types.ts) imports `@deepseek-ai/dsh-command-evolution/types`, `@deepseek-ai/dsh-evolution-memory/types`, and `@deepseek-ai/dsh-usage-ledger/types` instead of those package roots. Each root is a host implementation — the usage ledger opens a storage domain and reads `@deepseek-ai/dsh-session`, whose Context merge is the host one — so the controller's wire face now reaches only modules that touch no node global and merge no Context key.

`tsconfig.base.json` gains five `paths` entries for the subpaths the wire face names: `dsh-command-evolution/types`, `dsh-evolution-memory/types`, `dsh-evolution-controller/types`, `dsh-client-ui-evolution/types`, and `dsh-client-ui-workspace-memory/types`. The last two exist because a generated Remote client references the client package's own `./types`, which without an alias resolves to the built declaration the same package emits, and `tsc` then refuses to write a file it also reads.

[tsconfig.base.client.json](../../../../tsconfig.base.client.json) adds `ESNext.Disposable` to the client `lib` list: [PromptFileBinding](../../../../packages/client/file-upload/src/index.ts) extends `Disposable`, and node types are what declare that global for host programs.

[apps/web/tsconfig.json](../../../../apps/web/tsconfig.json) excludes `tests/evolution-journey.e2e.ts`, and [tsconfig.host.json](../../../../tsconfig.host.json) includes it: the scenario boots the host spine through `tests/scaffold.ts`, so it belongs to the host aggregate, which every other host-booting web e2e already joins.

The vendored `hmr` and `include` sources were brought under the repository's `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` flags at the type level only; [vendor/README.md](../../../../vendor/README.md) item 20 records each divergence.

Two runtime declarations were missing for the same package pair, and each one stopped the desktop Host from loading its plugin tree. [evolution-controller](../../../../packages/evolution/evolution-controller/package.json) and [ui-evolution](../../../../packages/client/ui-evolution/package.json) ship generated `typert.host.js` modules that import `zod` while neither manifest declared it, so the loader's `./typert` import failed with `Cannot find package 'zod'`; both now declare `zod: ^4.4.3` like every other package exporting a `./typert` face. The web-app bundle mounted `command-evolution` without the `profile` value its Config requires, so that entry failed with `$.profile missing required value`; the entry now carries the family's `default` namespace, and the comment describing the shared namespace sits on the controller it describes.

## Alternatives considered

**Give the client aggregate its own `paths` map that omits the host packages.** The client face needs the same source-level resolution for its own packages, and the failing import arrives from a built declaration rather than from client source, so a hand-maintained subset would have to be re-derived on every Remote addition. Leaf exports state the boundary once, in the package that owns the vocabulary.

**Widen `rootDir` on the affected projects.** `apps/web`'s `rootDir` is what makes its emit layout predictable, and the host sources entering its program were a symptom of the import graph, not of the directory setting. Widening it would have produced emit paths for files that never belonged in the program.

**Keep the duplicated timeline types in the client package.** The client mirror at [packages/client/ui-evolution/src/types.ts](../../../../packages/client/ui-evolution/src/types.ts) stays as a deliberate browser-side copy of the wire shape; deleting it would make the browser bundle depend on the host package's emit order for no gain.

**Add `ESNext.Disposable` to the host base config instead of the client face.** A client-only requirement, and the repository's host programs already receive the global from `@types/node/compatibility/disposable.d.ts`. Naming `lib` on the host base also drops the default DOM library from host programs, which broke unrelated packages.

## Consequences

A client program now fails loudly when a wire type reaches for a host implementation, instead of type-checking that implementation under the wrong compiler face; `dsh-usage-ledger/types`, `dsh-evolution-memory/types`, and `dsh-command-evolution/types` are the named leaves a future Remote vocabulary must extend. Adding a Remote whose types file needs a new leaf costs one `paths` entry plus one `./types` export.

Package surfaces change: `@deepseek-ai/dsh-command-evolution`'s `./types` subpath now resolves to `lib/types/types.{d.ts,js}` rather than the compiled `journey` module. Consumers of `JourneyTimeline` and its siblings keep the same type identity, because `journey.ts` re-exports the moved declarations.

`pnpm run build` completes end to end, and both aggregates type-check clean: `tsc -b tsconfig.host.json` and `tsc -b tsconfig.client.json` report no errors. The focused suites covering the touched packages pass — the seven evolution packages, `ui-evolution`, `context/evolution-memory-context`, the client specs that previously resolved `ctx.sessions` against the host merge, and `test-support/client-runtime`'s assembly check (401 tests across 30 files, plus the 36 `ui-evolution` tests re-run in isolation after a forks-worker timeout under load). `pnpm run dev:desktop` builds, prepares the development project, launches Electron, and boots the Host: the running renderer serves `dsh-app://app/index.html` with a Session title instead of the startup error document, and the Host inspector on its configured port answers. `pnpm run verify-tsconfig-paths` passes, which is what keeps the five hand-written subpath aliases honest — the generated region rewrites itself and maps bare package names only.

Three facts remain outside this change. The web e2e's recorded golden `snapshots/web/evolution-journey/ui.expected.md` carries `background_review · p/model` while the fixture now seeds `deepseek-official/deepseek-v4-flash`, so that scenario needs a refresh before `pnpm run test:web` is green. `pnpm run publint` still reports `Page.module.css` imports that `files` does not publish for `ui-evolution`, `ui-workspace-memory`, and the pre-existing `ui-usage-dashboard`. And `pnpm run doc-sync` fails on damage the evolutionary-harness merge left behind rather than on this change: `evolution-trajectory/src/index.ts:123` gives a Remote parameter a default value, which the typert analyzer rejects (`verify-cordis-catalog` aborts), sibling Agent Notes under `.agents/notes/implemented/feature/` from the same merge lack bilingual counterparts and valid refs, the configuration and persistence catalogs are stale, and `verify-export-jsdoc` still lists unrelated packages.
