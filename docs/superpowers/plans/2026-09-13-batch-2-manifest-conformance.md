# Batch 2 Implementation Plan — Manifest conformance + residue removal

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm run constraints` green by fixing 7 stale versions, 2 `files` mismatches, and removing the manifest-less residue directory.

**Architecture:** Manifest-only edits (no runtime code), one gate-side extras entry for genuinely emitted artifacts, one disk-only residue deletion. No behavior or snapshot changes expected.

**Tech Stack:** git, PowerShell, `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md` (batch 2).

## Global Constraints

- Every `@deepseek-ai/dsh-*` manifest carries the root version (`0.1.5-rc.2`).
- `files` must equal `expectedDshPackageFiles()` exactly (order-sensitive).
- Never stage files outside the batch paths; the tree has pre-existing dirt.
- Non-trivial change MUST include an Agent Note in the same commit.

---

### Task 1: Bump the 7 stale versions

**Files:**
- Modify (one line each): `packages/client/ui-progress/package.json`, `packages/client/ui-usage-dashboard/package.json`, `packages/client/ui-workspace-memory/package.json`, `packages/context/workspace-memory-context/package.json`, `packages/session/usage-ledger/package.json`, `packages/workspace/workspace-memory/package.json`, `packages/workspace/workspace-memory-llm/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: all 7 manifests at `0.1.5-rc.2`.

- [ ] **Step 1: Confirm the stale set and bump**

```powershell
Get-ChildItem packages -Recurse -Filter package.json | Where-Object { $_.FullName -notmatch "node_modules" } | ForEach-Object { $m = Get-Content $_.FullName -Raw | Select-String '"version": "(.*?)"'; if ($m.Matches.Groups[1].Value -eq "0.1.5-alpha.1") { $_.FullName } }
```

Expected: exactly the 7 paths above (plus zero others; a path with no `"version"` match errors the loop — those are non-workspace manifests like `package.json` bin shims and are out of scope, note and skip them). For each of the 7, replace `"version": "0.1.5-alpha.1"` with `"version": "0.1.5-rc.2"` (exactly one occurrence per file). Verify:

```powershell
Get-ChildItem packages -Recurse -Filter package.json | Where-Object { $_.FullName -notmatch "node_modules" } | ForEach-Object { $c = Get-Content $_.FullName -Raw; if ($c -match '"version": "0\.1\.5-alpha\.1"') { $_.FullName } }; Write-Output "STALE_LEFT_ABOVE"
```

Expected: no paths printed.

### Task 2: Fix the 2 `files` mismatches

**Files:**
- Modify: `packages/client/ui-usage-dashboard/package.json` (remove one line)
- Modify: `scripts/check-workspace-constraints.ts` (add extras entry)

**Interfaces:**
- Consumes: Task 1 done.
- Produces: both manifests satisfy `expectedDshPackageFiles()`.

- [ ] **Step 2: Remove the stale emitted-tree entry from ui-usage-dashboard**

The manifest publishes `lib/types/**/*.js` but no export defaults into `./lib/types/` (`usesEmittedTreeDefaults` is false), so the entry is stale. Delete exactly the line `"lib/types/**/*.js",` from its `files` array. Do NOT touch the `./remote` export: `hasTypertRemoteNavigation()` already expects the remote-client pair.

- [ ] **Step 3: Cover hmr's emitted watch artifacts via `packageFileExtras`**

The build provably emits `lib/watch.js` + hashed `lib/bundle-watch-*.js` (`packages/client/hmr/lib/` listing + `./watch` export), so this is a gate gap, not a manifest bug. Add to `packageFileExtras` in `scripts/check-workspace-constraints.ts`, after the `dsh-experimental-webworker-packer` entry:

```typescript
  // The HMR driver ships its watch runtime beside the lib entry; the hashed
  // bundle-watch chunk is emitted by the client bundle for the watch page.
  '@deepseek-ai/dsh-client-hmr': ['lib/watch.js', 'lib/bundle-watch-*.js'],
```

Order check: extras render between `lib/invariant.js` and `lib/client.js`, matching the manifest's existing `files` order exactly (`index, invariant, watch, bundle-watch-*, client, types`) — no manifest edit.

### Task 3: Remove the textpreview residue + verify webworker-packer needs nothing

**Files:**
- Delete from disk (untracked): `packages/client/ui-sidebar-textpreview/`
- Read-only: `scripts/verify-application-entrypoints.ts:26-46`

**Interfaces:**
- Consumes: Tasks 1–2 done.
- Produces: hierarchy check passes; entrypoints finding closed as already-handled.

- [ ] **Step 4: Prove residue status, then delete**

```powershell
git ls-files packages/client/ui-sidebar-textpreview | Measure-Object | Select-Object -ExpandProperty Count
```

Expected: `0` (nothing tracked; `lib/` is gitignored build output of a deleted package, `node_modules/` likewise). Only then:

```powershell
Remove-Item -Recurse -Force packages/client/ui-sidebar-textpreview; Test-Path packages/client/ui-sidebar-textpreview
```

Expected: `False`. (`scripts/clean.ts:113` deliberately refuses manifest-less dirs, so manual removal is the fix; teaching `clean` to delete them is deferred — recorded in the Agent Note.)

- [ ] **Step 5: Confirm webworker-packer is already classified (no change)**

`scripts/verify-application-entrypoints.ts:26-46` already lists `webworker-packer` bin/src entries as "private build-only" and the `application entrypoints` gate PASSED in the review baseline. No edit; this step only records the finding as already-handled.

### Task 4: Verify, note, commit

**Files:**
- Create: `.agents/notes/implemented/process/2026-09-13-manifest-conformance-batch-2.md`
- Test: `pnpm run constraints`

- [ ] **Step 6: Run the constraints gate**

```powershell
pnpm run constraints 2>&1 | Select-Object -Last 6
```

Expected: exit clean (no `version must match`, no `files must be`, no `expected a package here`). If a NEW violation type appears (unrelated to the 5 fixed classes), STOP and triage before committing.

- [ ] **Step 7: Write the Agent Note**

Create `.agents/notes/implemented/process/2026-09-13-manifest-conformance-batch-2.md` recording: the 7 bumps, the dashboard `files` removal (why the entry was stale), the hmr extras entry (why gate-side, with build-emission evidence), the textpreview deletion (untracked proof + `clean` deferral), the webworker-packer already-handled verdict, and the constraints result. Supersession check: no older note covers manifest versions (verified by grep for `alpha.1`/version-bump notes — record the negative result).

- [ ] **Step 8: Commit exactly this batch**

```powershell
git add packages/client/ui-progress/package.json packages/client/ui-usage-dashboard/package.json packages/client/ui-workspace-memory/package.json packages/context/workspace-memory-context/package.json packages/session/usage-ledger/package.json packages/workspace/workspace-memory/package.json packages/workspace/workspace-memory-llm/package.json scripts/check-workspace-constraints.ts .agents/notes/implemented/process/2026-09-13-manifest-conformance-batch-2.md; git diff --cached --name-only; git commit -m "fix: manifest conformance (versions, files, residue)"
```

Expected: staged set is exactly the 9 paths above (the textpreview deletion is disk-only, untracked — nothing to commit).

- [ ] **Step 9: Write the 5-line batch checkpoint**

Reply with exactly: versions bumped, files fixed (2), residue deleted, already-handled (1), verification (constraints output), note path, commit SHA. Then proceed to write the Batch 3 plan.
