# Full-Sweep Fixes Design — 8 batches, P0 → P4

- Date: 2026-09-13
- Source: full-sweep review report (5 chunk reviews + machine gates), user decisions in brainstorming.
- Execution: Approach A (sequential in main session), continuous through all 8 batches.

## Decisions (user-approved)

1. Scope: all findings in priority order P0 → P4.
2. Batching: 8 batches, one PR/commit each, independently revertable.
3. Behavior policy: correct behavior wins; update tests + snapshots with explanation.
4. Snapshots needing a real model: re-record with the opencode provider or session LLM.
5. Flow: continuous through batch 8, no mid-way review stops.
6. Context: strategic compact between batches when heavy, never mid-batch.

## Batch plan

1. P0-infra: remove 145 tracked `src/**/*.js` from git, add gate forbidding `src/*.js`.
2. P0-infra: fix 7 package version mismatches (`0.1.5-alpha.1` → `0.1.5-rc.2`),
   remove `packages/client/ui-sidebar-textpreview` residue (only `lib/` +
   `node_modules`, no `package.json`/`src`), classify `webworker-packer` CLI
   in `verify-application-entrypoints`.
3. P0-llm: `llm-retry` `always` swallowing downstream decisions, bare-`return`
   waterfall short-circuit on abort, `BlockAssembler` tolerance vs invariant
   divergence, `command-goal` local `assertNever`, `?? 1` quanta in run-path,
   `dsh-foreign` replay default, `translate` empty tool-call id/name,
   SSE `block-end` batching, `always` unbounded retry, process-local breaker.
4. P0-session: jsonl fail-silent `JSON.parse`, `session/disposed` fire-and-forget
   close, cold-read success-path close outside try, plan-mode switch without
   default/`assertNever`, `enqueueChain` unnamed catch, agent-loop unnamed
   `close().catch()`, `parseArguments` fail-silent, scheduler drain swallow,
   spill `EEXIST`, `timeout-policy` hidden default, session-query Config schema.
5. P0-api/infra: gateway `RemoteEventQueue` lost-wakeup, `Function.toString`
   param parsing, `srcClaims` cache staleness, patch-layer index provenance,
   patch object mutation, approval O(n) scan, permission-preset live fallback,
   schedule `faulted` latch + single timer, jobs `stopping` quota.
6. P0-security: sandbox `/tmp` narrowing, bash marker spoofing, ACP per-session
   `imagePromptEnabled`, hooks `continue:false` halt, web SSRF/proxy + `baseURL`
   `https:`-only, LSP TOCTOU, Windows ACL boundary, fs-sandbox residual TOCTOU,
   `hook-protocol` timeout clamp, invariants `RegExp` ReDoS, store `JSON.parse`
   validation, Typert loader freeze + `z.any()` gate, `.env` credential warn,
   SDK stderr cap, inspector redaction, cordis-host-runner watchdog/timers,
   worker message fail-fast.
7. P1 bottlenecks: session `list` rescan, corpus point-read O(N),
   `deriveMessages` copy + per-step deepFreeze, budgets per-step replay,
   `structuredClone` per query, static-asset cache/etag, boot sync FS,
   RPC linear scans, subprocess poller, terminal buffer, E2B N+1 RPC,
   web-fetch memory multiplier, client per-row timers, MCP double-codec,
   ACP `listSessions` O(N), projection-cache timer `unref`, Python SDK drops.
8. P2–P4 remainder: 22 jscpd clone groups, ~197 `.d.ts` mirrors, bash/pwsh base
   split, fs-text split, sqlite open helper, invariant-trace helper,
   agent-option const, `MAX_TIMER` import, attachment double-default, client
   drag/timer hooks, dead `title` param, settings double-default, gate-script
  dedup (`verify-client`, tunables glob), hardcoded tunables → Config,
   locale-owned copy, JSDoc `@mode`, store double-create, schedule/stream/boot
   tunables, identity catch/memo/`_actionHandler`, rescope-vendor sync,
   node-next types, publint CSS + `./src/*` noise, FIXME Windows runner,
   llm-fallback README sentence.

## Per-finding loop (TDD)

1. Read file + existing tests. 2. Write failing test reproducing the bug first.
3. Minimal root-cause fix, no drive-by refactoring. 4. Run scoped package tests.
5. Update snapshots for intended behavior changes with reason recorded.
6. Three failed fix attempts on one finding → stop, question architecture.

## Non-goals

- No new features. No behavior change beyond what a finding requires.
- No full `check:all`/coverage locally; CI owns exhaustive lanes.
- Findings proven wrong on deep inspection are skipped with a recorded reason.

## Verification per batch

Scoped `typecheck`/`lint`, package `vitest`, related snapshot replay, the
batch's own gate (`duplication`, `constraints`/`publint`, `test:gui` for UI).
After batch 8: full `duplication` + `hygiene` + `typecheck` to prove
previously-red gates are green. One Agent Note per batch in the same commit.
Five-line checkpoint after each batch for context hygiene.
