---
description: "Verifier-first candidate admission: the cheapest-first ladder of schema, invariant, simulation, evaluator, and human rungs, stopping at the first rung that decides (ctx.evolutionVerifiers)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-verifiers

English | [中文](README.zh.md)

## Summary

`dsh-evolution-verifiers` makes the environment judge as much as possible (§12): a cheapest-first five-rung ladder over a candidate skill body, stopping at the first refusal. Levels 0 and 1 are deterministic, always available: the frontmatter invariant `skill_manage edit` enforces, then name and instruction invariants. A failing candidate never spends a simulator, judge model, or human: the spec's deterministic-first rule. Levels 2 to 4 (simulator, evaluator model, human) are caller-mounted seams; an unmounted rung abstains, and an all-abstaining ladder reports abstention, not unearned approval, and it calls no model.

`dsh-evolution-curator` uses it as the admission gate for a consolidation patch body.

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

Mount the plugin and call `verify`, or call the pure `runVerifierLadder` where no host is needed.

```ts
const verdict = await ctx.evolutionVerifiers.verify({
  name: 'leaf',
  body: candidateSkillFileText,
  // Levels 2 to 4 are the seams this host mounts. An omitted seam abstains.
  simulation: async () => ({ status: 'passed', reason: 'the recorded replay held' }),
  evaluator: async () => ({ status: 'passed', reason: 'the judge approved the rewrite' }),
  review: async () => ({ status: 'passed', reason: 'operator approved' }),
})
if (verdict.status === 'failed') {
  console.log(`refused by level ${verdict.decidedBy}: ${verdict.reason}`)
}
```

`verify(request)` returns a `VerifierVerdict`. It is `failed` — naming the `decidedBy` level and that rung's reason — when a rung refused, and every rung above it is then never consulted. It is `passed` when all five rungs passed. It is `abstained`, with `decidedBy: null`, when nothing failed and at least one rung abstained, and its `reason` names each abstaining rung. `rungs` carries every consulted rung in the order it ran, so a caller that must act on an incomplete ladder can see exactly which rung is missing.

Each rung reports one `VerifierJudgment`: `passed`, `failed`, or `abstained` with a reason. A mounted seam that throws propagates — an unavailable simulator fails the verification instead of being counted as an abstention — while a mounted seam that cannot judge this candidate returns `abstained` itself.

### The ladder (§12)

| Level | Rung | `verdict.decidedBy` when it refuses | Decides |
|---|---|---|---|
| `0` | schema | `0` | Frontmatter parses and keeps the skill's own name with a routing description — the invariant the skill manager enforces on edit |
| `1` | invariant | `1` | The name is legal kebab-case and the text after the frontmatter carries instructions |
| `2` | simulation | `2` | A mounted domain simulator or tool execution that replays the candidate |
| `3` | evaluator | `3` | A mounted evaluator model that judges the candidate |
| `4` | human | `4` | A mounted human decision, e.g. the recorded approval path |

Levels 0 and 1 are decided from the candidate alone, so they run in-process and cannot be unmounted. Levels 2 to 4 are consulted only after every cheaper rung passed.

### Configuration

None — the ladder takes no deployment choices.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The ladder is one pure pass over a fixed rung list, and the two halves are split by who owns the judgment. `ladder.ts` owns the ordering, the short-circuit, and the verdict shape: `verifySchema` and `verifyDeterministic` are the two rungs the package can decide itself, and `runVerifierLadder` walks `[0, 1, 2, 3, 4]`, records each rung's judgment, and returns the moment one refuses — so the consult order *is* the cost order, and a refusal at level 0 provably never reaches level 2.

A seam is a zero-argument function returning a judgment, not a service lookup inside the package: the caller knows whether it has a simulator, a judge model, and a human decision, and the ladder only knows their order. That keeps the package free of any host dependency beyond the frontmatter invariant, and it is why an unmounted rung is an abstention with a reason the host can act on rather than a silent pass. The pass credit goes to level 4 — the deepest rung — because a verdict that reached the human rung is the only one whose evidence ran the whole ladder.

### Consumers

`dsh-evolution-curator` routes its consolidation `patch` gate through the same ladder (`applyConsolidation`): a body failing level 0 or 1 is refused with the deciding level in `ConsolidationReport.refusals` and counted in `skipped`, and a body the deterministic levels passed is committed — the curator mounts no higher rung, so its report states that decision rather than a verification it did not run.

### Failure and recovery

A rung that refuses is terminal, and the ladder makes no judgment of its own beyond the two deterministic rungs: it never turns an abstention into a pass, and it never invents a reason a rung did not give. A seam that throws fails the whole verification, so a host whose simulator is down learns that instead of reading a quiet abstention. No invariant companion is published: nothing here writes durable state, so there is no second observation to check against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §12 — the verifier-first ladder and the rule against an LLM judge where a deterministic verifier exists; §46 for evaluator-gaming defense, to which the deterministic rungs are the first answer; §50 for the VERIFIERS stage in the pipeline.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-curator`](../evolution-curator/README.md) — the consumer that routes its consolidation patch admission through this ladder.
- [`dsh-evolution-scorer`](../evolution-scorer/README.md) — the behavior gates (contract, routing, replay) that judge a candidate against its baseline, a comparison this ladder does not make.
- [`dsh-evolution-skill-manage`](../../skill/evolution-skill-manage/README.md) — the package whose `splitFrontmatter`/`validateSkillHead` invariant level 0 reuses rather than re-implements.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package registers nothing model-facing and reads nothing a model wrote. A level 3 seam a caller mounts may itself call a model; that request belongs to the caller.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering a verdict into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the ladder is a poor fit. They are current package constraints.

- **The upper rungs are only as good as the seams mounted** — the package runs no simulator, no judge model, and no human prompt itself, so a deployment that mounts nothing admits candidates on the deterministic rungs alone; the verdict says `abstained` precisely so that is visible rather than implicit.
- **A pass is not a promotion** — the ladder answers whether a body may be admitted; nothing here makes a skill visible to the model or changes a lifecycle state.
- **No baseline comparison** — the ladder judges one body on its own evidence. A candidate that regresses against the revision it replaces is the scorer's replay gate's question, not this ladder's.
- **Deterministic rungs are structural** — they decide syntax, naming, and the presence of instructions, not whether the instructions are correct; a well-formed body that instructs the wrong thing passes them.
- **No durable record** — a verdict is returned and not stored, so a host that needs the admission history keeps it itself; the curator records refusals in its report and its ledger entries.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Level 0 reuses `splitFrontmatter`/`validateSkillHead` from `dsh-evolution-skill-manage` rather than re-deriving the frontmatter rule, so the ladder and `skill_manage edit` can never disagree about what a committable body is. That is also why this package's only host dependency is that one. The rung list in `runVerifierLadder` is data — two literal rungs plus the three seams — and `VERIFIER_LEVEL_NAMES` is a `Record<VerifierLevel, string>`, so adding a level fails to compile until the rung is named. A caller wiring a level 3 seam from an existing evaluator composes the judgment itself, because the seam contract is a judgment rather than a transcript.

</details>
