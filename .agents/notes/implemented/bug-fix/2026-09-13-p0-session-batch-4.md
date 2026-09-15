# Agent Note: P0-session fixes batch 4

Status: implemented

English | [中文](2026-09-13-p0-session-batch-4.zh.md)

## Problem

The full-sweep review recorded in `docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md` raised findings across the session surface, and batch 4 of that sweep — dated 2026-09-13 — dispositioned them. Eight findings landed as code changes, three were declined for the reasons recorded under Alternatives considered, and the batch also hit pre-existing failures it proved unrelated to its own edits (see Known gaps).

## Decision

Eight findings landed as code changes:

1. `session-persistence-jsonl/src/index.ts`: `readGenerationHeader` warns (path only, never header content) when listing skips an unparsable first line; the skip is preserved for availability. New test `warns when listing skips an unparsable generation header` (failed pre-fix with 0 warn calls, passes post-fix).
2. `session-persistence-jsonl/src/storage.ts`: the `enqueueChain` catch is documented (chain-link swallow only; the caller still observes via `next`). Comment only.
3. `session-query/cold-read.ts`: the success-path `handle.close()` is wrapped like the error path, so a close failure no longer masks valid read data.
4. `plan-mode/src/index.ts`: the `/plan off` switch gains an exhaustive `default: assertNever(exit, ...)` over the bound outcome (no double `set()` call), with the shared `@deepseek-ai/dsh-util-values` import plus its `dependencies` and `tsconfig` reference. `tsc` narrowing is the exhaustiveness proof.
5. `agent-loop/src/index.ts` (4 sites) and `tool-calls.ts` (2 sites): unnamed rollback and drain swallows are documented with the file's own idiom. Comment only; the drain-swallow analysis shows `committed` advances only past fully appended results, so no duplicate-result hazard exists.
6. `spill-local/src/store.ts`: `saveTextFile` regenerates the random name on `EEXIST` with a bounded (10) number of attempts and a loud collision error; `path` moved inside the loop. New fs-mock harness (`vi.mock` plus a hoisted injector, the `jsonl.spec.ts` precedent) with retry-succeeds and bound-exhaustion tests (both failed pre-fix).
7. `session-query/observation.ts`: the constructor fail-louds (`SESSION_QUERY_INVALID_CONFIG`) on non-positive-safe-integer capacity instead of silently installing a degenerate cache; a 4-case test was added (failed pre-fix).
8. `user-approval/src/index.ts`: `overrideOf` keeps a per-session append-only scan cursor (`WeakMap`, floor plus truncation guard) — each log event is examined at most once across asks instead of a full O(n) rescan per tool call. The test pins 98 reads for 98 appended events (failed pre-fix with 99). `hasOpenTurn` is intentionally untouched (bounded by turn length).

## Alternatives considered

**Drain the disposed fire-and-forget teardown.** Refuted: `close()` is idempotent (`this.closing ??=`, storage.ts:224) and `releaseHandle` runs inside it before settlement, so the teardown effect's openHandles snapshot always reaches the same in-flight promise — or there is nothing left to drain. No orphan path exists; verified against `emitDisposed` (sync dispatch, core/session/src/index.ts:1121) and the live-write contract tests, which stay green.

**Validate the timeout-policy default at the call site.** Already conformant: the config-level default resolves with validation at `apply` (index.ts:76-79), and the per-call `??` is the documented two-level default (tool-declared over plugin default, JSDoc 67-70), owned visibly by the plugin.

**Replace the session-query base `Config` schema with one zod schema.** Accepted design: the abstract base validates manually to raise the typed `SESSION_QUERY_INVALID_CONFIG` taxonomy (a zod schema would throw generic errors), and the concrete `session-query-sqlite` implementation already owns a zod schema.

## Consequences

An unparsable generation header now surfaces as a path-only warning while listing keeps skipping the line for availability, and a failed close on the cold-read success path can no longer mask valid read data. The jsonl enqueue chain still swallows chain-link failures with the caller observing through `next`, and `/plan off` is exhaustively checked over the bound outcome instead of relying on the compiler's silence. A non-positive-safe-integer capacity fails loud as `SESSION_QUERY_INVALID_CONFIG` rather than installing a degenerate cache, `spill-local` bounds its random-name retry at 10 attempts with a loud collision error, and `user-approval` examines each log event at most once per session — which is what makes 98 reads for 98 appended events correct — while `hasOpenTurn` stays bounded by turn length. The three failures recorded under Known gaps are carried over unchanged and are not caused by this batch.

## Known gaps

- plan-mode 3 PTC/SDK-bytes failures: failure text references `run_code` SDK bindings (dirty-tree files-api work); the batch edit is provably behavior-neutral (unreachable branch plus side-effect-free import).
- jsonl `fails a stale prepared publication`: fails identically with the two jsonl files stashed (baseline proof).
- spill-local 3 symlink tests: `EPERM` creating fixture symlinks on Windows (test-setup privilege, untouched by this batch).

## Verification

- jsonl.spec.ts: 175 pass + new warn test (1 pre-existing fail above).
- spill-local: 40 pass (3 env fails above); session-query pkg: 102 pass; approval: 33 pass; plan-mode: 66 pass (3 pre-existing above).
- `tsc -b` clean: agent-loop, session-query, spill-local, session-persistence-jsonl, plan-mode, user-approval.
- `pnpm install` relinked plan-mode's new workspace dep.
