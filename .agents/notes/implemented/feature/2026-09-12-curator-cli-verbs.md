# Agent Note: Curator CLI verbs — `/curator adopt`, `purge`, `rollback`, `ledger`, `pin`, `unpin`

Status: implemented

English | [中文](2026-09-12-curator-cli-verbs.zh.md)

## Problem

`improvement.spec.md`'s WireCountedTrigger item 4 asked the `/curator` command to expose the curation operations the service already performs. The command stopped at `status` and `run`, so a user could not adopt an agent-created skill, purge expired ones, roll back a recorded pass, read the pass ledger, or pin a skill against purge from the CLI.

## Decision

`packages/evolution/command-evolution/src/index.ts` registers six curator sub-verbs:

- **`/curator adopt <name>`** — calls `curator.adopt(name)`, renders success or error
- **`/curator purge [--dry-run]`** — calls `curator.purge({ dryRun })`, renders purged skills list
- **`/curator rollback --id <id>`** — calls `curator.rollbackPass(id)`, renders restored skills
- **`/curator ledger`** — calls `curator.passes()`, renders pass list newest-first
- **`/curator pin <name>`** — calls `telemetry.setPinned(name, true)`, renders success
- **`/curator unpin <name>`** — calls `telemetry.setPinned(name, false)`, renders success

Argument validation runs BEFORE curator resolution, so malformed input reports usage even when the curator is unmounted — the same behaviour the original `status`/`run` verbs have.

Pin and unpin need only telemetry, not the curator; they resolve it through `ctx.get('evolutionSkillTelemetry')`. Error messages extract `.message` from `Error` instances for clean output. `executeCuratorRun` is inlined rather than kept as a one-line wrapper.

## Alternatives considered

**Resolving the curator before validating arguments.** Rejected: validation-first is what lets a malformed command report usage even when the curator is unmounted, and it keeps the new verbs on the same behaviour the existing `status`/`run` verbs already have.

**Requiring the mounted curator for `pin`/`unpin`.** Rejected: those two verbs touch only `telemetry.setPinned`, so they resolve `ctx.get('evolutionSkillTelemetry')` directly and stay usable in a composition with no curator mounted.

**Keeping `executeCuratorRun` as a one-line wrapper.** Dropped: a wrapper that adds no behaviour is inlined, so the verb dispatches to the pass runner directly.

## Consequences

Six curation operations are reachable from the command surface, and a missing mount reports an error instead of failing silently. The cost is the surface itself: each verb's argument grammar and error path must stay in step with the curator and telemetry services, and 24 new test cases in `command-evolution.spec.ts` pin them.

## Testing

24 new test cases in `command-evolution.spec.ts` cover:

- Arg parsing for each verb (usage errors for missing/excess args)
- Success paths with expected output text
- Error propagation from curator/telemetry service methods
- Missing curator → honest error for curator verbs
