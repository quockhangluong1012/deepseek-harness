---
description: "Island evolution: durable per-skill evolution lanes with an objective each, migration recording between islands, and schedule-based migration due checks (ctx.evolutionIslands)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-islands

English | [中文](README.zh.md)

## Summary

`dsh-evolution-islands` keeps durable per-skill evolution lanes, each carrying one of §7's objectives — conservative, performance, cost, novelty, adversarial — plus the migration records that move candidates between islands and the schedule view that flags migrations due on a cadence. Islands preserve diversity: without them the harness converges on the first "pretty good" skill and stops discovering alternatives. The optimizer advances an island's generation tick through the optional store seam, and the host command `command-evolution` registers islands, records migrations, and reads the schedule through `/islands`. Nothing here calls a model.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the storage domain. An operator registers the lanes of a skill's evolution job, the optimizer advances ticks while the store is mounted, and migrations move strong candidates between islands on the schedule.

```ts
await ctx.evolutionIslands.register({
  islandId: 'stable',
  name: 'Stable lane',
  objective: 'conservative',
  skill: 'writer',
})
await ctx.evolutionIslands.migrate({
  fromIslandId: 'stable',
  toIslandId: 'diverse',
  candidateId: 'staged-0',
  reason: 'schedule',
})
const schedule = ctx.evolutionIslands.schedule('writer')
```

`register(input)` creates an island with a zero generation; a duplicate island id rejects loudly. `advance(skill)` records one generation tick on the skill's head island (the newest registered) and is a no-op until an operator registers one. `migrate(input)` records one move between two islands, rejecting unknown islands and cross-skill moves; a candidate may migrate repeatedly and every move stays on record. `islands(skill?)` and `migrations(skill?)` list rows newest first; `schedule(skill?)` renders each island with its last migration and whether a scheduled migration is due under the configured cadence. The `/islands` command registers islands, records schedule migrations, and lists both views.

### Configuration

The store's deployed choice, with a default suitable for an ordinary cadence; it is validated with a default so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `migrationCadence` | `86400000` (one day) | Scheduled-migration cadence, in milliseconds. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The domain is `evolution_islands` version 1 with two tables: `islands` keyed by island identity and `migrations` keyed by a fresh migration identity (a candidate may migrate repeatedly). Each island row holds `{ islandId, name, objective, skill, generation, lastActivityAt, at }`; each migration row holds `{ migrationId, fromIslandId, toIslandId, candidateId, skill, reason, at }`.

Schedule logic is pure. `migrationDue` anchors an unmigrated island at its registration instant and a migrated island at its last migration, then compares against the cadence. `headIsland` picks a skill's newest-registered island; equal registration instants keep the input order, so a same-millisecond batch resolves to the island the caller sees first. `advance` bumps the head's generation and last-activity instant — the recorder seam's only write, mirroring how the population store auto-numbers generations.

### Failure and recovery

A duplicate island id, an unknown island in a migration, and a cross-skill migration all reject loudly; reads throw before the store starts. `advance` on a skill with no island returns `undefined` instead of failing, so the recorder seam stays a no-op until an operator defines the lanes.

No invariant companion is published because the domain tables are the only copies of this state, so there is no second independent observation to check them against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §7 — the island model and diversity preservation this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the producer whose staged writes advance island ticks through the optional recorder seam.
- [`dsh-evolution-population`](../evolution-population/README.md) — the sibling store whose candidates are the migration traffic between islands.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering island facts into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Records migrations, does not execute them** — the schedule flags due migrations (§58.12: trust is recorded, not enforced); moving a candidate between islands remains an operator's job.
- **One head per skill** — a generation tick lands on the newest island only; parallel ticks across all of a skill's lanes are not tracked.
- **Objectives are labels, not policies** — the five §7 objectives are recorded vocabulary; no lane yet steers mutation operators, seeds, or evaluators differently.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The optimizer advances through the optional store so a deployment without the islands package sees zero behavior change; the failing-store path logs a warning rather than failing an optimization. Migration identities are generated fresh so a candidate's repeated moves never collide in the table.

</details>
