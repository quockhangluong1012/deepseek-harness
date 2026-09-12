---
description: "Durable per-skill use/view/patch telemetry with provenance, pin, and lifecycle state (ctx.evolutionSkillTelemetry), for hosts curating skills during use."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-skill-telemetry

English | [中文](README.zh.md)

## Summary

`dsh-evolution-skill-telemetry` owns the durable per-skill counters behind skill curation: successful model loads, human views, and management mutations, plus creation provenance, pinning, and lifecycle state. Hosts read it synchronously and mutate it through explicit marks; a passive `tools/post-execute` observer counts successful `skill`-tool loads. Bundled and hub skills are excluded from every write. The package also counts repeated produced outputs as skill-creation evidence and records the cost row of a consolidation-scale run before its fan-out. Choose it when curation (staleness, consolidation, deletion) should rest on observed use rather than guesses.

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

Mount the plugin when skill curation needs durable usage evidence. Records are keyed by skill name; an absent record reads as `undefined` and seeds on first mark. Reads are synchronous from validated memory and return detached copies. `markUsed`, `markViewed`, and `markPatched` resolve to `undefined` for bundled and `hub*` sources instead of writing. `markAgentCreated` records background-review authorship and resolves without writing when already present; foreground creates never call it, so their provenance stays user-directed. `markAdopted` claims one agent-created skill into user-directed standing without resetting clocks, rejecting missing records and anything without background-review authorship. `drop` forgets one record, reporting whether one existed. `setPinned` pins or unpins; pins block automatic transitions and managed deletion but never patches. `setState` moves one skill through `active`, `stale`, and `archived`, stamping `archivedAt` on entry and clearing it on exit, with `absorbedInto` naming a consolidation umbrella.

Two surfaces exist beside the counters. `skillCreationEvidence(paths)` counts produced outputs that repeat, grouping by normalized path (case-folded, `/` and `\` alike, trailing separators ignored) and firing at three repeats — the counted trigger for proposing a skill; it never reads or quotes file content, and no vendor-reported repetition number feeds it. `recordConsolidationCost(row)` stores the `{ inputBytes, maxOutputTokens, provider, model, truncated }` row a consolidation-scale run records before its fan-out, and `readConsolidationCost()` returns a detached copy of the latest row or `undefined` when none was recorded.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One durable record per skill name in storage domain `evolution_skill_usage`, version `1`, layout `per-record`, table `records`. Source exclusion is a write-time decision shared with the manage package through `isExcludedSkillSource`: bundled skills ship with the product and hub skills arrive from sharing, so neither is locally curated. The observer delegates the tool chain first and only then counts, so telemetry never changes a load outcome; a failing skill provider falls back to the `custom` source rather than losing the count.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `EvolutionSkillTelemetry` service, marks, and the `tools/post-execute` observer |
| [`src/spec.ts`](src/spec.ts) | Domain declaration: record schema and `defineDomain` spec |
| [`src/types.ts`](src/types.ts) | Public `SkillUsageRecord`, lifecycle state, provenance, repeated-output evidence, and consolidation cost-row types |

### Failure and recovery

A failing write propagates to the caller, except inside the observer, which logs and keeps the tool result. Marks seed the record on first touch and resolve without writing when nothing changes. `read` and `entries` throw before the store starts; every other method needs the open table the same way.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness.spec.md) — the behaviour contract this package implements.
- [Skill package map](../README.md) — the group's packages and their repository position.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-evolution-skill-manage`, whose `skill_manage` tool reports each mutation here and refuses pinned deletions.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the telemetry is a poor fit. They are current package constraints.

- **Machine-local only** — records live under `$DSH_HOME`, never inside the project directory.
- **Only counted flows count** — direct file edits outside `skill_manage` and loads outside the `skill` tool never reach a counter.
- **No per-session breakdown** — counters are global per skill; there is no per-scope or per-session view.
- **Bundled and hub skills are invisible** — excluded sources never seed records, so curation sees only locally owned skills.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
