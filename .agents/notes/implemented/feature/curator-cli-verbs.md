# Curator CLI Verbs — `/curator adopt`, `purge`, `rollback`, `ledger`, `pin`, `unpin`

**Implemented:** 2026-09-12
**Source:** `improvement.spec.md` — WireCountedTrigger item 4

## What changed

Added 6 new curator sub-verbs to `packages/evolution/command-evolution/src/index.ts`:

- **`/curator adopt <name>`** — calls `curator.adopt(name)`, renders success or error
- **`/curator purge [--dry-run]`** — calls `curator.purge({ dryRun })`, renders purged skills list
- **`/curator rollback --id <id>`** — calls `curator.rollbackPass(id)`, renders restored skills
- **`/curator ledger`** — calls `curator.passes()`, renders pass list newest-first
- **`/curator pin <name>`** — calls `telemetry.setPinned(name, true)`, renders success
- **`/curator unpin <name>`** — calls `telemetry.setPinned(name, false)`, renders success

## Design notes

- Arg validation happens BEFORE curator resolution so malformed input reports usage even when the curator is unmounted (same as the original `status`/`run` behavior)
- Pin/unpin only need telemetry, not the curator — resolved via `ctx.get('evolutionSkillTelemetry')`
- Error messages extract `.message` from `Error` instances for clean output
- `executeCuratorRun` was inlined (ponytail: one-line wrapper → no behavior added)

## Tests

24 new test cases in `command-evolution.spec.ts` covering:
- Arg parsing for each verb (usage errors for missing/excess args)
- Success paths with expected output text
- Error propagation from curator/telemetry service methods
- Missing curator → honest error for curator verbs