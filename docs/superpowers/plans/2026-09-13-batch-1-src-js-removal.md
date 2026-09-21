# Batch 1 Implementation Plan — Remove tracked `src/**/*.js` + forbid gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the 145 git-tracked build-output `.js` files under `packages/*/src/` and add a gate that forbids them from returning.

**Architecture:** Pure deletion plus one new source-ownership gate modeled verbatim on `scripts/verify-no-fixme.ts`. No runtime code changes, so no behavior or snapshot changes are expected.

**Tech Stack:** git, PowerShell, `tsx`, existing `scripts/run-gates.ts` gate runner.

**Spec:** `docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md` (batch 1).

## Global Constraints

- Source plane vs artifact plane, never mixed: tests resolve workspace imports to `src`, built output lives in `lib/`.
- ESM everywhere; local relative imports use `.ts` specifiers.
- Files end with exactly one trailing newline.
- Non-trivial change MUST include an Agent Note in the same commit.
- Never bypass test failures.

---

### Task 1: Inventory the residue and prove nothing imports it

**Files:**
- Read-only: `git ls-files` output, `packages/*/src/*.ts` grep results

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `JS_LIST` — the authoritative file list (count must be `>= 145`; the review counted exactly 145, a higher count means new residue landed and must also go).

- [ ] **Step 1: Generate the authoritative list**

```powershell
git ls-files "packages/*.js" "packages/*/*.js" "packages/*/*/src/*.js" "packages/*/*/src/**/*.js" | Sort-Object | Tee-Object -FilePath "$env:TEMP\src-js-list.txt"; (Get-Content "$env:TEMP\src-js-list.txt" | Measure-Object).Count
```

Expected: count `>= 145`, every path matches `packages/<group>/<pkg>/src/**/*.js`.

> Triage note (verified 2026-09-13): the broad patterns also catch 8 legitimate non-`src` files — `packages/experimental/webworker-packer/bin.js` (a declared `bin` entry) and 7 plain-JS Cordis plugins under `tests/fixtures/plugins/`. These must NOT be deleted. Derive the deletion list with:
>
> ```powershell
> Get-Content "$env:TEMP\src-js-list.txt" | Where-Object { $_ -match "/src/.+\.js$" } | Tee-Object -FilePath "$env:TEMP\src-js-src-only.txt" | Measure-Object | Select-Object -ExpandProperty Count
> ```
>
> Expected: exactly `145`. All deletion steps below consume `$env:TEMP\src-js-src-only.txt`, never the broad list.

- [ ] **Step 2: Prove every `.js` has a same-named `.ts` sibling (mirror check)**

```powershell
$bad = Get-Content "$env:TEMP\src-js-src-only.txt" | Where-Object { -not (Test-Path ($_.Substring(0, $_.Length - 3) + ".ts")) }; $bad; Write-Output "NON_MIRROR_COUNT:$($bad.Count)"
```

Expected: `NON_MIRROR_COUNT:0`. If non-zero, STOP: inspect each listed file before deleting (it may be legitimate handwritten source, not residue).

- [ ] **Step 3: Prove no `src/*.ts` imports a relative `.js` specifier**

```powershell
Select-String -Path "packages/*/*/src/*.ts" -Pattern "from\s+['""]\.[^'""]*\.js['""]" | Select-Object -First 10; Write-Output "DONE"
```

Expected: no matches (the review established `.js` specifiers appear only inside the residue files themselves and `lib/` output). If a `src/*.ts` match appears, STOP: that importer must be fixed to `.ts` first, in this same batch.

- [ ] **Step 4: Check `.gitignore` coverage for the residue pattern**

```powershell
Select-String -Path ".gitignore" -Pattern "src.*\*\.js|\*\.js" | Select-Object -First 10; Write-Output "DONE"
```

Expected: note whether a pattern already covers `packages/*/src/**/*.js`. If missing, Task 3 adds it.

### Task 2: Delete the residue from git

**Files:**
- Modify (delete): every path in `$env:TEMP\src-js-list.txt`
- Modify: `.gitignore` (only if Step 4 showed a gap)

**Interfaces:**
- Consumes: `JS_LIST` from Task 1 (all-mirror + no-importer preconditions green).
- Produces: working tree with residue removed, still-uncommitted.

- [ ] **Step 5: Remove the files from the index (keep nothing on disk that git tracks)**

```powershell
Get-Content "$env:TEMP\src-js-src-only.txt" | ForEach-Object { git rm --quiet "$_" }; git status --porcelain | Select-String "packages/.*\.js" | Measure-Object | Select-Object -ExpandProperty Count
```

Expected: the count equals the Step 1 count (all staged as deleted), and `git status` shows no other unintended modifications from this command.

- [ ] **Step 6: Add the ignore rule if Step 4 showed a gap**

Append exactly one line to `.gitignore` (create the minimal diff):

```gitignore
packages/*/*/src/**/*.js
```

Then verify:

```powershell
git check-ignore -q "packages/llm/llm/src/retry-policy.js" ; Write-Output "IGNORED:$LASTEXITCODE"
```

Expected: `IGNORED:0`. Skip this step entirely if Step 4 already covered the pattern.

### Task 3: Add the `verify-no-src-js` gate

**Files:**
- Create: `scripts/verify-no-src-js.ts`
- Modify: `package.json` (add one script line next to `verify-no-fixme`)
- Modify: `scripts/run-gates.ts` (register the gate next to the `verify-no-fixme` entry)
- Test: manual gate runs (Steps 8–9)

**Interfaces:**
- Consumes: residue-free tree from Task 2.
- Produces: `pnpm run verify-no-src-js` exit 0 on clean tree, exit 1 when residue is reintroduced.

- [ ] **Step 7: Write the gate script (modeled on `scripts/verify-no-fixme.ts`)**

Create `scripts/verify-no-src-js.ts` with exactly this content:

```typescript
/**
 * Reject committed build output under package sources. `src/` holds the
 * source plane; compilers emit to `lib/`. A tracked JavaScript file under
 * `src/` is residue that drifts from its TypeScript original and pollutes
 * clone detection.
 * @module scripts/verify-no-src-js
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Collect tracked JavaScript paths under package `src/` dirs without exiting.
 * @param root - Repository root to scan.
 * @returns tracked residue paths; empty means the source plane is clean.
 */
export function collectSrcJsViolations(root: string = ROOT): string[] {
  // One pattern only: verified empirically that `*` crosses `/` in this
  // repo's git pathspec handling (so this also catches deeper nesting),
  // while the `**` form matches nothing and must not be used here.
  const output = execFileSync('git', ['ls-files', 'packages/*/*/src/*.js'], {
    cwd: root,
    encoding: 'utf8',
  })
  return output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).sort()
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const violations = collectSrcJsViolations(ROOT)
  if (violations.length > 0) {
    process.stderr.write('verify-no-src-js: tracked build output under src/:\n')
    for (const violation of violations) process.stderr.write(`  ${violation}\n`)
    process.exit(1)
  }
  process.stdout.write('verify-no-src-js: no tracked src/**/*.js residue.\n')
}
```

- [ ] **Step 8: Register the script and gate**

```powershell
Select-String -Path "package.json" -Pattern "verify-no-fixme"
```

Add `"verify-no-src-js": "tsx scripts/verify-no-src-js.ts"` immediately after the line `"verify-no-fixme": "tsx scripts/verify-no-fixme.ts",` (package.json line 143, same indentation, trailing comma preserved). Then register the gate in `scripts/run-gates.ts` inside `sharedComplianceGates()` (line 323-329) with exactly this edit:

```typescript
    pnpmScript('no-fixme', 'verify-no-fixme', { label: 'release FIXME markers' }),
    pnpmScript('no-src-js', 'verify-no-src-js', { label: 'tracked src build output' }),
```

Verify:

```powershell
node --import tsx/esm scripts/verify-no-src-js.ts; Write-Output "EXIT:$LASTEXITCODE"
```

Expected: `verify-no-src-js: no tracked src/**/*.js residue.` and `EXIT:0`.

- [ ] **Step 9: Prove the gate catches reintroduced residue**

The gate reads `git ls-files`, which only sees tracked files — so the probe must be staged to be visible. The new `.gitignore` rule ignores it, so force-add with `-f` (this mirrors the real threat: residue tracked before the rule existed stays tracked). Stage it, expect failure, then unstage and delete:

```powershell
Copy-Item "$env:TEMP\gate-probe\web-probe.js" "packages/util/time/src/gate-probe.tmp.js"; git add -f "packages/util/time/src/gate-probe.tmp.js"; node --import tsx/esm scripts/verify-no-src-js.ts; Write-Output "EXIT:$LASTEXITCODE"; git rm --cached --quiet "packages/util/time/src/gate-probe.tmp.js"; Remove-Item "packages/util/time/src/gate-probe.tmp.js"; Test-Path "packages/util/time/src/gate-probe.tmp.js"
```

Expected: gate prints the probe path and `EXIT:1` while staged, final `Test-Path` returns False (use a `.tmp.js` name so even a leftover cannot be mistaken for residue). Confirm the index is back to pre-probe state with `git status --porcelain` showing no `gate-probe` entry.

### Task 4: Verify, note, commit

**Files:**
- Create: `.agents/notes/implemented/simplification/2026-09-13-remove-src-js-residue.md` (Agent Note)
- Test: `pnpm run duplication`, scoped `vitest`, scoped `typecheck`

**Interfaces:**
- Consumes: gate-green tree from Task 3.
- Produces: one commit containing deletions + gate + note, and a 5-line batch checkpoint.

- [ ] **Step 10: Run the verification set**

```powershell
pnpm run duplication 2>&1 | Select-Object -Last 12
```

Expected: the gate exits 0 on the clean tree. Record the new clone numbers and verify no remaining clone pair references a deleted `.js` path (the `.jscpd.json` corpus covers `typescript`/`tsx` only, so the count may stay near the 22/817 baseline — the deletion proof is the gate, not the delta; `jscpd` still exits 1 while any `.ts` clones remain, which is pre-existing and out of scope for this batch). Then run the test suites of three representative touched packages:

```powershell
pnpm vitest run packages/llm/llm packages/attachment/attachment packages/shell/shell 2>&1 | Select-Object -Last 8
```

Expected: all pass. Then the host typecheck (background, slow — start it and continue to Step 11 while it runs):

```powershell
pnpm run typecheck 2>&1 | Select-Object -Last 5
```

Expected: exit 0. If any check fails, STOP: fix or revert before committing (never bypass).

- [ ] **Step 11: Write the Agent Note**

Create `.agents/notes/implemented/simplification/2026-09-13-remove-src-js-residue.md` recording: why the residue existed and why deletion is safe (mirror check + no-importer proof), what was given up (nothing — `lib/` remains the artifact plane), and the verification (gate run, duplication delta, vitest + typecheck results).

- [ ] **Step 12: Commit exactly this batch**

The `git rm` in Step 5 already staged the deletions; now stage only the exact remaining batch paths (never `-A` on this dirty tree):

```powershell
git add .gitignore scripts/verify-no-src-js.ts package.json scripts/run-gates.ts .agents/notes/implemented/simplification/2026-09-13-remove-src-js-residue.md; git status --porcelain | Select-Object -First 12; git commit -m "chore: remove tracked src build residue and forbid it by gate"
```

Expected: `git status` before commit shows only the intended paths; commit succeeds with the pre-commit hook green.

- [ ] **Step 13: Write the 5-line batch checkpoint**

Reply with exactly: what was deleted (count), gate added, verification results (duplication delta, vitest, typecheck), note path, commit SHA. Then proceed to write the Batch 2 plan.
