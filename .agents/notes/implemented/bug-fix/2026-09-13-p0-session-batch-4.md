# P0-session fixes batch 4

- Date: 2026-09-13
- Batch: 4 of full-sweep fixes (`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`)

## Code changes

1. `session-persistence-jsonl/src/index.ts`: `readGenerationHeader` warns
   (path only, never header content) when listing skips an unparsable first
   line; skip preserved for availability. New test
   `warns when listing skips an unparsable generation header` (failed pre-fix
   with 0 warn calls, passes post-fix).
2. `session-persistence-jsonl/src/storage.ts`: `enqueueChain` catch documented
   (chain-link swallow only; caller still observes via `next`). Comment only.
3. `session-query/cold-read.ts`: success-path `handle.close()` wrapped like
   the error path — a close failure no longer masks valid read data.
4. `plan-mode/src/index.ts`: `/plan off` switch gains an exhaustive
   `default: assertNever(exit, ...)` over the bound outcome (no double `set()`
   call); shared `@deepseek-ai/dsh-util-values` import plus `dependencies` and
   `tsconfig` reference. `tsc` narrowing is the exhaustiveness proof.
5. `agent-loop/src/index.ts` (4 sites) + `tool-calls.ts` (2 sites): unnamed
   rollback/drain swallows documented with the file's own idiom. Comment only;
   the drain-swallow analysis shows `committed` advances only past fully
   appended results, so no duplicate-result hazard exists.
6. `spill-local/src/store.ts`: `saveTextFile` regenerates the random name on
   `EEXIST` with a bounded (10) attempts and a loud collision error; `path`
   moved inside the loop. New fs-mock harness (`vi.mock` + hoisted injector,
   the `jsonl.spec.ts` precedent) with retry-succeeds and bound-exhaustion
   tests (both failed pre-fix).
7. `session-query/observation.ts`: constructor fail-louds
   (`SESSION_QUERY_INVALID_CONFIG`) on non-positive-safe-integer capacity
   instead of silently installing a degenerate cache; 4-case test added
   (failed pre-fix).
8. `user-approval/src/index.ts`: `overrideOf` keeps a per-session
  append-only scan cursor (`WeakMap`, floor + truncation guard) — each log
   event examined at most once across asks instead of a full O(n) rescan per
   tool call. Test pins 98 reads for 98 appended events (failed pre-fix with
   99). `hasOpenTurn` intentionally untouched (bounded by turn length).

## Triaged without code change (with reasons)

- **disposed fire-and-forget: refuted.** `close()` is idempotent
   (`this.closing ??=`, storage.ts:224) and `releaseHandle` runs inside it
   before settlement, so the teardown effect's openHandles snapshot always
   reaches the same in-flight promise — or there is nothing left to drain.
   No orphan path exists; verified against `emitDisposed` (sync dispatch,
   core/session/src/index.ts:1121) and the live-write contract tests, which
   stay green.
- **timeout-policy hidden default: already conformant.** The config-level
   default resolves with validation at `apply` (index.ts:76-79); the per-call
   `??` is the documented two-level default (tool-declared over plugin
   default, JSDoc 67-70), owned visibly by the plugin.
- **session-query base Config schema: accepted design.** The abstract base
   validates manually to raise the typed `SESSION_QUERY_INVALID_CONFIG`
   taxonomy (a zod schema would throw generic errors); the concrete
   `session-query-sqlite` implementation already owns a zod schema.

## Pre-existing failures (proven unrelated, all recorded)

- plan-mode 3 PTC/SDK-bytes failures: failure text references `run_code` SDK
   bindings (dirty-tree files-api work); my edit is provably behavior-neutral
   (unreachable branch + side-effect-free import).
- jsonl `fails a stale prepared publication`: fails identically with my two
   jsonl files stashed (baseline proof).
- spill-local 3 symlink tests: `EPERM` creating fixture symlinks on Windows
   (test-setup privilege, untouched by this batch).

## Verification

- jsonl.spec.ts: 175 pass + new warn test (1 pre-existing fail above).
- spill-local: 40 pass (3 env fails above); session-query pkg: 102 pass;
  approval: 33 pass; plan-mode: 66 pass (3 pre-existing above).
- `tsc -b` clean: agent-loop, session-query, spill-local,
  session-persistence-jsonl, plan-mode, user-approval.
- `pnpm install` relinked plan-mode's new workspace dep.
