# Manifest conformance batch 2

- Date: 2026-09-13
- Batch: 2 of full-sweep fixes (`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`)

## Why

`pnpm run constraints` failed on five classes; all are fixed here:

1. Seven manifests still carried `0.1.5-alpha.1` while the root (and the
   dsh-family rule in `checkDshFamilyVersion`) requires `0.1.5-rc.2`:
   `client/ui-progress`, `client/ui-usage-dashboard`,
   `client/ui-workspace-memory`, `context/workspace-memory-context`,
   `session/usage-ledger`, `workspace/workspace-memory`,
   `workspace/workspace-memory-llm`. Bumped, one line each.
2. `client/ui-usage-dashboard` published `lib/types/**/*.js`, but no export
   defaults into `./lib/types/` (`usesEmittedTreeDefaults` is false), so the
   entry was stale. Removed; the `./remote` export was already expected via
   `hasTypertRemoteNavigation` and is untouched.
3. `client/hmr` genuinely emits `lib/watch.js` plus a hashed
   `lib/bundle-watch-*.js` (verified in `packages/client/hmr/lib/` against
   the `./watch` export), so the gate — not the manifest — was wrong. Covered
   via the designed `packageFileExtras` escape hatch, and reordered the
   manifest `files` to the gate's canonical order (extras render after
   `lib/client.js`).
4. `packages/client/ui-sidebar-textpreview/` held only `lib/` + `node_modules`
   with zero tracked files: untracked residue of a deleted package. Removed
   from disk (nothing to commit).
5. `experimental/webworker-packer` CLI: already classified as private
   build-only in `verify-application-entrypoints.ts:26-46`, and that gate
   passed. No change; recorded as already-handled.

## What was given up

- Teaching `scripts/clean.ts` to delete manifest-less package dirs: deferred.
  `clean` refuses them deliberately (line 113), and automatic deletion of
  unknown directories is riskier than the one-off manual removal done here.
- No runtime code changed; no behavior or snapshot changes expected.

## Verification

- `node --import tsx/esm scripts/check-workspace-constraints.ts` exits 0 with
  no violation lines (previously: 7 version + 2 files + 1 hierarchy errors).
