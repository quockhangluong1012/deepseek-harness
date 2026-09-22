---
description: "Automatic curriculum from measured capability gaps: proposes training and evaluation tasks from the most decisive failure gists of each tracked skill, with a durable proposal store (ctx.evolutionCurriculum)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-curriculum

English | [中文](README.zh.md)

## Summary

`dsh-evolution-curriculum` turns measured capability gaps into proposed training and evaluation tasks and keeps the proposals durable. A gap is one tracked skill's distinct failure gists, read from the compressed learning traces of the sessions that loaded it; the derived task states the recurring failure a run should reproduce and recover from. Nothing here calls a model — the gap evidence IS the curriculum signal. The host command `command-evolution` reads it through `/curriculum`.

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

Mount the plugin with the storage domain; measuring gaps additionally needs the telemetry and trace stores, and without either `gaps()` measures nothing.

```ts
const gaps = await ctx.evolutionCurriculum.gaps()
const staged = await ctx.evolutionCurriculum.propose(gaps)
for (const proposal of staged) {
  console.log(`${proposal.capability}: ${proposal.task}`)
}
```

`gaps()` joins the mounted seams: for every tracked skill with sessions, the distinct failure gists of its compressed trace rows. `propose(gaps)` stages one grounded task per gap that clears the evidence floor, skipping any already-open proposal for the same capability and task. `proposals()` lists every staged task, open first then retired; `retire(id)` retires one deliberately. The `/curriculum` command measures, stages, and lists in one step, and accepts `retire <id>`.

### Configuration

The evidence floor is a validated `Config` member changeable from `cordis.yml`.

```yaml
- name: '@deepseek-ai/dsh-evolution-curriculum'
  config:
    minGists: 1
```

| Field | Default | Meaning |
|---|---|---|
| `minGists` | `1` | Distinct failure gists a capability needs before a task is proposed |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-curriculum) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

`deriveTasks` is pure: one task per gap that carries failure evidence, most evidence first, citing at most three gists and clipped to a bounded task text. The task names the capability, the recurring failure, and the session count the evidence was observed across — a run can reproduce the failure and recover from it, which is the training loop the curriculum feeds.

The store is a per-proposal domain: `evolution_curriculum` version 1 with one `proposals` table keyed by proposal identity, holding `{ id, capability, task, sourceSessions, gists, at, state }`. Staging deduplicates against open proposals by `capability + task`, so re-running a pass never grows duplicate tasks. Proposals survive restarts and are retired only deliberately.

### Failure and recovery

An absent id on `retire` rejects loudly; an already-retired proposal resolves without writing. A missing telemetry or trace seam measures no gaps rather than failing a pass. Reads throw before the store starts.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §10 and §33 — the automatic-curriculum and capability-frontier mechanism families this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-trace`](../evolution-trace/README.md) — the trace store whose compressed rows supply the failure gists.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-curriculum) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering a task into a training prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Tasks are derived, not generated** — the task text restates the failure evidence; there is no model-based task author, and no capability classifier beyond the skill the evidence was correlated with.
- **Host-wide, not scope-keyed** — proposals are global; a per-scope curriculum needs a scope key on the domain.
- **No executor** — nothing runs a proposed task yet; the evaluation and shadow/canary work (P1) owns consuming the proposal list.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The gap measurement reuses the same join the curator survey makes (skill sessions → failure evidence) so both consumers see the same evidence shape. The proposal dedup key is `capability + task`, so a change to the derivation wording retires nothing but stages fresh tasks.

</details>