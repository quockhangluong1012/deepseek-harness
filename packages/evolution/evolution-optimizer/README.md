---
description: "Minimal offline skill optimization: trigger-gated mutation over the host LLM, scorer evaluation under isolated DSH_HOME overlays, Pareto pick, staged skill patch (ctx.evolutionOptimizer)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-optimizer

English | [中文](README.zh.md)

## Summary

Search for a better SKILL.md body offline: pass a skill, its corpus scenarios, and a staging identity, and the run draws candidates from the mutation operators you configure, screens and scores them under isolated `DSH_HOME` overlays, checks the private holdout, confirms the winner on repeated paired comparisons, and stages the Pareto winner that beats the baseline. It runs on demand, never per turn, costs one model call per selected operator, and needs a corpus that exercises the skill. Nothing writes a skill directly: approve the staged entry to land it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Call `optimize` with the skill, the corpus scenarios, and the staging identity:

```ts
const report = await ctx.evolutionOptimizer.optimize({
  skill: 'writer',
  scenarios: ['draft-turn', 'revise-turn'],
  scopeId,
  originSessionId: String(session.id),
  signal: invocation.signal,
})
if (report.status === 'staged') console.log('staged as', report.stagedId)
```

### When to choose it

Choose it when telemetry has flagged a skill (see `shouldOptimize` in [`dsh-evolution-scorer`](../evolution-scorer/README.md)) and the corpus has scenarios that exercise it. The optimizer is offline and manual — it runs when `/curator optimize` runs, never on the per-turn path. Reach for the scorer instead when the question is only measurement, and for the curator's consolidation instead when whole skill packages (not one SKILL.md body) need verdicts.

### Mounting it in a profile

The Web composition carries this row and the scorer's [shut off](../../bundle/web-app/cordis.patch.yml), because both need values only a deployment knows: the directory of recorded scenarios, and the agent composition every attempt boots — a named profile, the patch it layers, the source bin, and the repo tsconfig. [`apps/cli/config/examples/evolution-optimize/cordis.yml`](../../../apps/cli/config/examples/evolution-optimize/cordis.yml) is the overlay that turns both on with a checkout's own corpus; apply it with `--patch`, or copy its rows into a profile's `cordis.patch.yml`. An attempt booted through a real `dsh` entry needs `agent.profile`: without one the launcher passes the config file alone, which only a bin with its own config grammar accepts.

### Configuration

The generated [Configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-optimizer) is the exhaustive source for every accepted field.

```yaml
- id: evolution-optimizer
  config:
    maxCandidates: 3
    provider: deepseek-official
    model: deepseek-flash
    agent:
      binScript: /path/to/repo/apps/cli/src/bin.ts
      configPath: /path/to/repo/snapshots/acp/escalation-approved/cordis.yml
      profile: acp
      tsconfigPath: /path/to/repo/tsconfig.json
```

| Field | Default | Meaning |
|---|---|---|
| `maxCandidates` | `3` | Mutation candidates per run |
| `maxInputBytes` | `16384` | Byte budget for one framed mutation request |
| `maxOutputTokens` | `2048` | Output-token cap for one mutation request |
| `provider` | `required` | Provider route for the mutation request |
| `model` | `required` | Model id for the mutation request |
| `triggerMinUses` | `20` | Recorded loads required before a failure rate counts |
| `triggerFailureRate` | `0.3` | Failure share a record must exceed, in 0..1 |
| `holdoutScenarios` | `[]` | Corpus scenarios reserved for the promotion check, never scored during search |
| `budgetTokens` | `0` | Billed tokens one run may spend on candidate scoring; `0` leaves it unbounded |
| `budgetWallTimeMs` | `0` | Wall time in milliseconds one run may spend on candidate scoring; `0` leaves it unbounded |
| `screenScenarioCount` | `0` | Scenarios every candidate is screened on before survivors are scored in full; `0` disables screening |
| `operators` | `['rewrite']` | Mutation operators the run draws candidates from, in request order |
| `confirmationRuns` | `1` | Paired winner-versus-baseline comparisons a promotion must win |
| `skipRepeatedExperiments` | `true` | Refuse a run whose exact hypothesis already has a recorded outcome; `false` pays for the same search again |
| `stagnationWindow` | `5` | Evaluated runs without a promotion that make a skill stagnant and switch the mutation lineup |
| `priorMinTries` | `3` | Candidate-producing runs an operator needs under one failure signature before its record orders the lineup |
| `maxExperiments` | `200` | Experiments one scope keeps, newest first |
| `experimentPageSize` | `20` | Experiments one read returns, newest first |
| `agent.binScript` | `required` | Source bin entry variant attempts boot |
| `agent.configPath` | `required` | Base config or profile patch the entry loads |
| `agent.profile` | unset | Named profile every attempt boots; set it whenever the bin is the real `dsh` entry |
| `agent.tsconfigPath` | `required` | Repo tsconfig resolving unbuilt workspace imports |

The generated [Configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-optimizer) is the exhaustive source for every accepted field.

### Mutation operators

One prompt as the only mutation mechanism converges on one rewrite style, so a run may draw its candidates from a portfolio. Built-ins are `rewrite` (clarity and ordering), `compress` (shortest body that keeps every rule the evidence implicates), `guard` (the missing precondition, refusal, or validation), and `exemplify` (one worked example per implicated rule). `operators` lists the ids to use, in request order; an unknown id fails at load.

`maxCandidates` stays the run's total: the budget is split evenly across the selected operators, with the leading operators taking the remainder, so `maxCandidates: 2` over `['rewrite', 'compress']` is one call each. Each operator is its own model call, so a wider portfolio costs more calls for the same candidate count; the default `['rewrite']` keeps the historical single-call shape. Two operators that return the same body contribute one candidate, credited to the earlier operator, and the staged evidence names the operator that produced the winner.

Every candidate is checked before it is scored against the same commit invariant `skill_manage edit` enforces — parseable frontmatter keeping the skill's own name and a routing description — through the scorer's `checkBehaviorContract`, so one implementation of that invariant serves the write path, the behavior gate, and this loop. A body that would break the skill cannot be landed, so it is not a candidate: it never buys a scoring run over fresh processes. The request states the requirement, so the model can comply instead of paying for refusals; a run whose every candidate was refused reports `no-improvement` and names how many were refused and why.

### Promotion confidence and the experiment ledger

- **`confirmationRuns` turns one good comparison into a repeated one.** The search evaluation already beat the baseline once; each further run scores the baseline and the winner again as a pair under fresh processes, and the promotion stands only if the winner takes every pair. A winner that loses one is refused with `status: 'unconfirmed'` and `confidence: { runs, wins }` recorded, so a stochastic win cannot be promoted on a single reading. The extra pairs are paid for out of the same `budgetTokens` / `budgetWallTimeMs` ceiling as the search.
- **Every run that reached evaluation is a durable row** in the scope's `evolution_experiments` domain: the evidence text, the operators that produced candidates, the search and holdout scenarios, the baseline and winner triples, the confidence tally, the outcome, the reason, the staged id when one was created, the provider and model, the scoring-semantics version the mounted scorer measured under, the lines the promoted body added and removed, and the SHA-256 of the body the run started from and of the body it promoted. Bodies themselves are not stored; the digests identify them, and the counts say how big the edit was. `/curator experiments` prints the counts as `+added/-removed` on promoting rows.
- **An approved promotion is a floor the next winner must clear.** Before anything is staged, the run looks up the strongest *approved* promotion recorded for this skill and compares it with this run's winner — but only when the two were measured under the same scenarios, route, attempt count, and scorer version, since a triple from another configuration says nothing about this one. A scorer change retires every floor it measured: the old rows stay readable, but no new winner is refused by a number from a different evaluator. A winner the approved result dominates is refused with `status: 'regressed'` and the floor named in the report (`floor: { triple, stagedId, at }`), so a change that clears today's baseline but undoes an accepted improvement never reaches the human as a recommendation.
- **A decided experiment is not run twice.** A run whose hypothesis — same skill, same evidence text, same scenarios, same operator lineup, same starting body, same route, same scorer version — already has a recorded outcome returns `skipped` naming the earlier run and what it decided, before any model call. What the ledger remembers is one hypothesis, so a changed skill body, a changed evidence text, a changed route, or a changed scorer is a new experiment; a run that never reached evaluation is not remembered at all, because repeating it is the only way to get the answer it failed to produce. `skipRepeatedExperiments: false` turns the refusal off.
- **Novelty is measured, and what a candidate says that the body did not orders it.** Every candidate's body is compared with the one the run started from: `novelty` is the share of its distinct instruction lines the starting body does not already carry — leading frontmatter dropped, since every candidate restates it — with case and spacing folded and line order ignored, so a reformat or a reshuffle reports zero and a rule the skill never stated reports a real share. It appears on every candidate in the report. Selection uses it as the tie-break below cost and above wall time, in both the screen cut and the winner pick: among candidates that measured the same, the one that states something new is the one that changes what the skill does, while wall time over fresh replayed processes is machine noise. Dominance still rules — a novel candidate is never picked over a cheaper or faster one — so novelty decides between equals, which in this harness means an exact triple tie or a screen tie on pass and tokens.
- **An operator that only restates the body for this failure goes last.** The ledger records which operators produced at least one candidate stating new material (`novelOperators`), and the failure surface counts that as the operator's freshness. Among operators that have never won here, the ones that said something new come before the ones that only ever repeated what the skill already carried — repeating a body cannot repair a failure it already failed — and among the repeaters, the most-tried still leads. This is the §31 pressure the run can act on: a single-shot optimizer cannot reward a candidate twice, but it can stop re-drawing from the operator that keeps saying nothing.
- **The ledger orders the lineup by what repaired this failure before.** A run reads the ledger's record for the failure it is addressing — the evidence text with every run of digits folded to one `#`, so counters that move between readings do not split one failure mode into many — and counts, per operator, the runs that produced a candidate with it and the runs whose promoted candidate it produced. Operators that have won this failure lead the lineup, operators this failure has never seen follow in configuration order, and operators that have only ever lost there come last; ties fall back to configuration order. The order decides who takes the remainder of the candidate budget, which is what `maxCandidates` splits in lineup order. `priorMinTries` is the evidence floor: below it an operator counts as never seen for that failure, so one lucky win cannot reorder anything.
- **A stagnating skill changes its approach instead of repeating itself.** A skill whose most recent `stagnationWindow` evaluated runs all promoted nothing is reported as `stagnant: true`, and the run draws its candidates only from the operators that produced no candidate in that window — the lineup that has not yet failed on this failure mode. When every configured operator has already been tried in the window, diversity is exhausted and the configured lineup stands.
- **The ledger is readable and bounded.** `experiments(scopeId, { skill, limit })` returns the newest rows first, `/curator experiments [skill]` prints them, and each scope keeps `maxExperiments` rows — older ones are dropped as new ones land. A ledger write that fails is reported on the host logger and never turns a promotion that already happened into an error.

-----

<a id="use-this-package"></a>

Selection only ever sees the scenarios the caller names, so a winner is chosen on the same corpus the mutation was written for. Three configuration knobs keep that from becoming overfitting or runaway cost:

- **`holdoutScenarios`** — corpus scenarios the search never scores. The winner and the baseline are both scored on them before anything is staged, and a winner the baseline dominates there is refused (`status: 'holdout-rejected'`, nothing staged). The holdout lives in plugin configuration rather than in the request on purpose: a caller that could name the holdout could also drop a scenario that fails it. And a holdout scenario the skill's own ledger already records as search is refused before anything runs: a task that selected an earlier winner has shaped this skill, so it is not a clean test, and reconfiguring the holdout cannot launder it back into one.
- **`budgetTokens` / `budgetWallTimeMs`** — a ceiling on the candidate scoring one run may buy. The loop stops before the next full evaluation once the ceiling is passed and reports `truncated: true`; the search still selects among the candidates it did score, and a run that spent its budget before scoring any candidate returns `skipped` instead of staging a guess.
- **`screenScenarioCount`** — successive halving. Every candidate is scored on the first N search scenarios, the better half survives (pass state first, then tokens, then wall time), and only survivors get the full scenario set. The screen runs for every candidate even when a budget is set, so the survivors are always ranked on the same subset.

Both scenario lists are validated before any model call: a name repeated inside either list, or listed in both, throws instead of running. The ledger is checked the same way — a holdout name the skill already searched throws — so contamination fails loud at the earliest resolvable point. Reusing a scenario for search across runs stays ordinary practice; only promoting search history into holdout is refused.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/pareto.ts` is the pure selector: dominance on (pass, tokens, wallTimeMs), the nondominated frontier, the survivor cut a screen promotes, and the winner that must dominate the re-scored baseline. `src/mutate.ts` owns the operator portfolio and frames one request per operator (the operator's instruction plus a byte budget that halves the evidence, never the skill body) and parses the JSON-array answer into distinct bodies — every one of which `src/index.ts` then puts through the scorer's `checkBehaviorContract`, so a body that could not be landed is refused before it costs a scoring run. `src/evaluate.ts` stages each body into a fresh `DSH_HOME` overlay and scores it through `evolutionScorer.evaluateSkill` with a runner that layers the overlay home into the attempt environment; the overlay is removed when scoring settles. `src/surface.ts` is the failure surface: the signature one evidence text folds to, the per-operator try and win counts one scope's rows hold for it, and the ordering that prior imposes on a lineup. `src/experiments.ts` is the ledger vocabulary: the durable row schema, retention, paged reads, the experiment key and the repeat lookup, and the prose a repeat refusal quotes. `src/index.ts` orchestrates: scenario validation, strategy selection from the ledger, repeat refusal, trigger gate, baseline re-score under the same harness, the screen, the budgeted full evaluations, the Pareto pick, the holdout check, the confirmation pairs, one `stageWrite` with `kind: 'skill'`, `op: 'patch'`, and the ledger row. `src/experiments.ts` owns the domain declaration, the durable row schema, and the two pure selectors (`experimentPage`, `staleExperiments`) the read path and retention use. `src/contamination.ts` is the holdout guard: the recorded search scenarios one skill's holdout must not repeat. `src/lineage.ts` counts the changed components: added and removed lines between the starting body and the winner, order-sensitively, so the ledger records how big each promotion's edit was.

No invariant companion is published because the experiments domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- The metric triple and the trigger live in [`dsh-evolution-scorer`](../evolution-scorer/README.md); the optimizer reuses both without copying.
- The staged skill protocol (write with skill_manage, then approve) is documented in [`dsh-command-evolution`](../command-evolution/README.md).
- The mutation call's `purpose: 'evolution-optimize'` attribution is declared in [`dsh-llm`](../../llm/llm/README.md).

-----

<a id="model-experience"></a>
## Model Experience

### Mutation request

#### What the model sees

One user message per selected operator, opening with the fixed header `You improve one skill package in a single pass.`, that operator's instruction line, the reply-format line naming the requested body count, and the closing `No prose outside the array.` — followed by the skill name, the complete current `SKILL.md` body, and the failure evidence. The request declares no tools, and the answer must be a JSON array of complete replacement bodies.

#### Token effect

Capped: one request per operator that received candidates — `maxCandidates` split across the lineup, so the run never exceeds that many requests — each bounded by `maxInputBytes` of framing and `maxOutputTokens` of completion. Scoring adds no model call: every attempt replays recorded fixtures.

#### KV Cache effect

Independent of live requests: each mutation call is a fresh single-message exchange with its own prefix, so it cannot invalidate provider cache reuse on a conversation. The run's calls are independent of each other too, because each opens with its own operator instruction.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Replay measures executable content** — a variant that only rewords prompts may score identically to the baseline, because keyless replay fixes the model script and only tool results vary. A prompt-only rewrite that changes nothing measurable reports `no-improvement`; that is the harness telling the truth, not a missed optimization.
- **One SKILL.md body per run** — the overlay serves only the variant body; sibling package files (scripts, references) are absent from it, so a variant that depends on rewritten siblings can mis-score. Sibling-aware overlays wait for a skill that needs them.
- **No corpus mining** — scenarios arrive explicitly per run; turning sessions into fixtures plus authored drivers is still an open design (see the Batch 5 note).
- **The holdout is only as private as its configuration, but not launderable through it** — the optimizer refuses a search scenario that is also a holdout scenario, and a holdout scenario the skill already searched, but nothing stops an operator from listing every scenario in both places and calling it a split; the corpus partition is a deployment decision, not an enforced one.
- **A portfolio multiplies model calls** — every selected operator is a separate mutation call, so `operators: ['rewrite', 'compress', 'guard', 'exemplify']` with `maxCandidates: 4` is four calls for four candidates instead of one call for four. Widen the portfolio deliberately.
- **Screening trades measurement for cost** — a candidate promoted on the short subset is judged there by pass state, tokens, and wall time, so a candidate that only wins on the scenarios the screen skipped can be cut before it is measured on them.
- **The floor only exists after a human approves** — a staged entry nobody has decided counts for nothing, and the run that would have promoted the floor's own body is the run that recorded it; a rejected promotion leaves no floor behind.
- **A floor is only comparable to its own conditions** — the same scenarios in any order, the same provider and model, the same attempts per scenario, and the same scorer version. Changing any of them removes the floor rather than comparing incomparable numbers.
- **Novelty is textual, so a semantic rewrite that reuses the same lines reports zero** — the measure is line-level on the candidate's own body, which is what a skill is made of, but two bodies that say the same thing in different words share no lines and read as fully novel. It is also measured against this run's starting body only: the ledger stores body digests, never bodies, so novelty against the promoted history is not available to a later run.
- **The prior is per failure signature and per scope** — it learns which operator repairs a failure mode, not which skill an operator suits, and a signature folds magnitudes away, so two genuinely different failures that differ only in their numbers share one record. A run's promotion credits the operator whose candidate won, never a candidate that merely looked better.
- **A repeated experiment is invisible to the guard when it produced no candidate** — an operator whose model call yielded nothing usable, including only bodies that would break the skill, is not recorded as having produced one, so the next run may retry it; and a run that skipped before scoring records no baseline, so it is never the reason a later run is refused.
- **The admission gate checks frontmatter, not behavior** — a candidate is refused only when it could not be landed at all; whether it routes where it should is the scorer's behavior gate (`evaluateBehavior`), which the optimizer does not run, so a well-formed body that hijacks another skill's triggers still reaches the human as a recommendation.
- **Stagnation is a switch, not a cure** — it changes which operators are drawn from, using the lineup the recent window did not exercise; it does not widen beyond the configured `operators`, invent new scenarios, or change the model. `stagnationWindow: 1` makes one failed run enough.
- **The ledger records runs, not approvals** — a row records that a promotion was staged; whether a human later approved or rejected it lives in the scope's own staged-entry resolutions, so counting accepted improvements means reading both.
- **Confirmation repeats the comparison, not the search** — `confirmationRuns` re-scores the same winning body against the same baseline over the same scenarios; it does not resample scenarios, seeds, or model routes, so it rules out a lucky reading of one comparison rather than a lucky corpus.
- **An attempt's overlay home is the harness's, not the environment's** — a variant is scored inside a temporary `DSH_HOME` holding the staged SKILL.md, and that home reaches the runner as `homeDir`; passing it through the child environment would leave the recorded-replay harness building its own home and scoring the live skills instead.
- **A truncated run is not a complete search** — with a budget set, `truncated: true` means the winner was chosen among the candidates that fit, not among all of them; raise the budget or lower `maxCandidates` instead of reading the report as a full comparison.
