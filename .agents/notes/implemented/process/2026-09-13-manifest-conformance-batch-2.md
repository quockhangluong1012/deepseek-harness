# Agent Note: Manifest conformance (full-sweep batch 2)

Status: implemented

English | [中文](2026-09-13-manifest-conformance-batch-2.zh.md)

## Problem

`pnpm run constraints` failed on five classes — batch 2 of the full-sweep fixes dated 2026-09-13 (`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`); all five are fixed here:

1. Seven manifests still carried `0.1.5-alpha.1` while the root (and the dsh-family rule in `checkDshFamilyVersion`) requires `0.1.5-rc.2`: `client/ui-progress`, `client/ui-usage-dashboard`, `client/ui-workspace-memory`, `context/workspace-memory-context`, `session/usage-ledger`, `workspace/workspace-memory`, `workspace/workspace-memory-llm`.
2. `client/ui-usage-dashboard` published `lib/types/**/*.js`, but no export defaults into `./lib/types/` (`usesEmittedTreeDefaults` is false), so the entry was stale.
3. `client/hmr` genuinely emits `lib/watch.js` plus a hashed `lib/bundle-watch-*.js` (verified in `packages/client/hmr/lib/` against the `./watch` export), so the gate — not the manifest — was wrong.
4. `packages/client/ui-sidebar-textpreview/` held only `lib/` + `node_modules` with zero tracked files: untracked residue of a deleted package.
5. The `experimental/webworker-packer` CLI was already classified as private build-only in `verify-application-entrypoints.ts:26-46`, and that gate passed.

## Decision

1. Bumped the seven versions, one line each.
2. Removed the stale `files` entry; the `./remote` export was already expected via `hasTypertRemoteNavigation` and is untouched.
3. Covered the real emission through the designed `packageFileExtras` escape hatch, and reordered the manifest `files` to the gate's canonical order (extras render after `lib/client.js`).
4. Removed the manifest-less directory from disk, which had nothing to commit.
5. Made no change for the `webworker-packer` CLI, recorded as already handled.

## Alternatives considered

**Teach `scripts/clean.ts` to delete manifest-less package directories.** Deferred: `clean` refuses them deliberately (line 113), and automatic deletion of unknown directories is riskier than the one-off manual removal done here.

**Widen the constraint gate's default file list instead of declaring the emission per package.** Only `client/hmr` emits a hashed watch bundle, so the designed `packageFileExtras` escape hatch keeps the shared file rule narrow and the package-specific knowledge in the manifest.

**Make `client/ui-usage-dashboard` actually default into `./lib/types/` so the published glob stays true.** No export defaults there (`usesEmittedTreeDefaults` is false), so the entry is stale against the export surface the package ships; the fix belongs in `files`.

## Consequences

No runtime code changed, so no behavior or snapshot changes are expected; the batch edits `version` and `files` fields only, and deletes one untracked directory that had no tracked files.

## Verification

`node --import tsx/esm scripts/check-workspace-constraints.ts` exits 0 with no violation lines (previously: 7 version + 2 files + 1 hierarchy errors).
