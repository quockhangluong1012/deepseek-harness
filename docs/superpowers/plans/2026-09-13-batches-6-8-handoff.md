# Handoff — batches 6–8 resume state

> Written at the batch-5/6 boundary to survive context compaction. All facts below are verified against disk/git; do not re-derive them from narration.

## Goal & branch

- Goal `goal-c5707119-1c6d-4e8a-8bf7-71f654ded42b` (active): 8 batches P0→P4.
- Branch `fix/full-sweep-batch-1` (local, unpushed). Commits:
  - `58a28e3492` design spec (main, pre-branch)
  - `696c325e24` batch 1 (145 src .js + gate)
  - `4073c642f4` batch 2 (manifests)
  - `4a094a89f1` batch 3 (llm)
  - `6c28cc52a1` batch 4 (session; includes approval policy cache)
  - `8ae3c7fec5` batch 5 (api; approval note corrected here)
- Design spec: `docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`.
- Batch plans: `docs/superpowers/plans/2026-09-13-batch-{1,2}-*.md` (batches 3–5 executed finding-by-finding per the design TDD loop; see Agent Notes).
- Agent Notes: `simplification/2026-09-13-remove-src-js-residue.md`, `process/2026-09-13-manifest-conformance-batch-2.md`, `bug-fix/2026-09-13-p0-llm-batch-3.md`, `bug-fix/2026-09-13-p0-session-batch-4.md`, `bug-fix/2026-09-13-p0-api-batch-5.md` (each records triage verdicts).

## Batch 6 scope (P0-security) — from the design spec

sandbox `/tmp` narrowing (`sandbox/sandbox/src/roots.ts:63-69`); bash marker spoof (`shell/tool-bash-persistent/src/index.ts:80-106`); ACP per-session `imagePromptEnabled` (`acp/acp/src/index.ts:106,179,364` — VERIFIED shared global); hooks `continue:false` halt (`hooks-codex:171`, claude twin + TODOs); web SSRF/proxy + `baseURL` https-only (`web-fetch-http/provider.ts:134-137`, `policy.ts:52-57`; `web-search-exa/perplexity/deepseek` `isValidBaseUrl` — VERIFIED weak); LSP TOCTOU (`lsp-stdio/host.ts:91-109`); Windows ACL boundary (`sandbox-windows-acl/path-boundary.ts:11-26`); fs-sandbox residual (`fs-sandbox/index.ts:122-144` — re-canonicalize verified good); hook timeout clamp (`hook-protocol/runner.ts:74-84`); invariants `new RegExp` ReDoS (`runtime-diagnostics/invariants:75-90`); store JSON validation (`client/store/index.ts:152-154`); Typert loader freeze + `z.any()` (`typert/loader:105-107`, `generator/emitter.ts:788`); webworker-packer = already-handled; SDK stderr = DONE (batch 5); worker/vm/timers/inspector/ blocklist/credentials = triaged accepted in batch 5 note.

## Batch 7 (P1) & 8 (P2–P4)

- Batch 7: bottlenecks incl. SSE incremental `block-end` (deferred from batch 3, needs TTFT measurement); session list/deriveMessages/budgets already partly covered by batch 4–5 caches.
- Batch 8: 22 jscpd groups, ~197 `.d.ts` mirrors, remaining duplication, hygiene leftovers (rescope-vendor, node-next, publint CSS, FIXME runner, llm-fallback README), then full `duplication` + `hygiene` + `typecheck`; then `finishing-a-development-branch` for integration.
- Batch plans for 6–8: write one plan file each just before executing (batch-1/2 pattern), not upfront.

## Environment lessons (do not relearn)

- PowerShell `| Select-Object` pipelines mask pnpm/vitest exit codes (stderr warning → NativeCommandError, exit 1). Read SUMMARY lines (`Test Files|Tests`), not exit codes. Run vitest directly + `Write-Output EXIT:$LASTEXITCODE` for gates.
- Never combine `git stash` + long test + `pop` in one command (tool timeout → index.lock). Separate calls; if locked with no live git, remove stale `.git/index.lock`.
- Tree is dirty from other agents' active work: commit exact paths only; pre-existing test failures must be stash-baselined before attribution.
- `git ls-files` `*` crosses `/` but `**` matches nothing here; `.gitignore` `**` works (different engines) — verify patterns empirically.
- Never write `*/` inside JSDoc block comments (closes the comment).
- `mtimeMs` is fractional — floor it for hex etags.
- Windows env vars cap ~32KB: fake-runtime flood uses numeric env, not payload. -materials: `Mock` style: `vi.mock` + `vi.hoisted` injector is the repo precedent (jsonl.spec.ts) for deterministic fs-failure tests.
- TDD proof standard used throughout: new test fails pre-fix (stash-baselined with exact predicted values, e.g. 99-vs-98, 262247 bytes), passes post-fix.
