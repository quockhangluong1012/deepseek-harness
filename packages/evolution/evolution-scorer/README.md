---
description: "Measured improvement scoring over the recorded-session corpus: pass from the workspace diff, billed tokens from the host token meter, and median wall time over fresh-process attempts (ctx.evolutionScorer)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-scorer

English | [中文](README.zh.md)

## Summary

`dsh-evolution-scorer` turns a recorded scenario into the three numbers an improvement decision needs: pass, from comparing the workspace against `workspace.expected/` or the attempt's own starting state; billed tokens, from the host token meter; and wall time, the median over N fresh-process attempts. It scores fixtures already on disk in the keyless replay tier, so no API key is needed and nothing is recorded — an unknown scenario, or one without a recorded session fixture, reports an honest skip. Use it to compare a change against a baseline; the snapshot suites remain the tool for exact transcripts.

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

Mount the plugin with the corpus root, then score a scenario by name:

```ts
const outcome = await ctx.evolutionScorer.score({
  scenario: 'text-turn',
  agent: { binScript, configPath, tsconfigPath, profile: 'acp' },
  run: processScenarioRunner,
})
if (outcome.status === 'scored') console.log(outcome.score.pass, outcome.score.tokens, outcome.score.wallTimeMs)
```

### When to choose it

Choose it when a change should be judged by measurement rather than by an exact transcript: the scorer reports a comparable triple across the recorded corpus and tolerates the scenarios that corpus does not contain. The process runner is the snapshot harness's ACP tier, which boots the real agent against recorded model output; a corpus driven another way (the headless `snapshots/session` suite) supplies its own runner of the same shape. Reach for [`dsh-session-snapshot`](../../test-support/session-snapshot/README.md) instead when the question is whether a transcript or normalized stdout changed, and for `benchmarks/` when the question is a throughput budget rather than one scenario's outcome.

### Configuration

The corpus root is required; the attempt count is a validated member changeable from `cordis.yml`.

### Trigger and skill evaluation

`shouldOptimize(usage, thresholds)` is the pure trigger that decides whether one skill's recorded outcome warrants an optimization run: at least `triggerMinUses` loads with a failure share over `triggerFailureRate`, where the share is `failureCount / (useCount + failureCount)` — the rate the telemetry record documents. `evaluateSkill({ skill, scenarios, agent, run })` scores each named scenario through the existing `score` and aggregates the optimizer triple: `pass` holds only when every scenario passes, and tokens and wall time sum the per-scenario medians. One skipped scenario skips the whole evaluation with its reason, because optimizing on a partial evaluation would select on evidence that is not there; a skill naming no scenarios skips the same way.

### Behavior evaluation

`evaluateBehavior({ baseline, candidate, candidateBody, catalog, positiveQueries, negativeQueries, routingTopK?, vectors? })` judges one skill revision through three gates, cheapest first. The contract gate (`checkBehaviorContract`) refuses a body that would break the skill's frontmatter, reusing the exact invariant the skill manager enforces on edit. The routing gate (`checkBehaviorRouting`) runs positive and negative trigger queries through the real selector: every positive must rank the candidate inside `routingTopK` (default 3), every negative must keep it outside, over a catalog carrying each entry's revision key so a report never mixes revisions. Catalog entries may also carry frontmatter `requires`: a candidate whose prerequisites are absent from the catalog scores zero in the same selector and fails every positive, because routing to it could never work. A failed cheap gate stops the evaluation with `status: 'gated'` before any fresh process boots. Otherwise both replay compositions run over the same scenarios and the replay gate (`compareBehaviorReplay`) approves only when the candidate regresses nothing the baseline passed — parity on a scenario both fail is not a regression, because the gate judges "no worse" while selection judges "better". `approved` is true only when every gate passed: only replay evidence approves.

```yaml
- name: '@deepseek-ai/dsh-evolution-scorer'
  config:
    corpusDir: /path/to/repo/snapshots/acp
    attempts: 3
```

| Field | Default | Meaning |
|---|---|---|
| `corpusDir` | `required` | Absolute corpus root holding one directory per recorded scenario |

The Web composition carries this row [shut off](../../bundle/web-app/cordis.patch.yml): which corpus a deployment scores against is its own data, and the row without one could only fail at the first evaluation. [`apps/cli/config/examples/evolution-optimize/cordis.yml`](../../../apps/cli/config/examples/evolution-optimize/cordis.yml) enables it together with the optimizer, using a checkout's own corpus and the profile its attempts boot.
| `attempts` | `3` | Fresh-process attempts per score; the median is taken over their samples |
| `triggerMinUses` | `20` | Recorded loads required before a failure rate triggers optimization |
| `triggerFailureRate` | `0.3` | Failure share a skill must exceed to trigger optimization |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-scorer) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Scoring is a plan, N process attempts, and a reduction. `loadScenarioPlan` reads a scenario directory without running it: the ACP input script, the highest recorded session fixture generation (with its child fixtures), and the optional `replay.override.json`, `workspace/`, and `workspace.expected/` sidecars. Each attempt then calls the caller's runner in the harness's `replay` mode, which never writes a fixture. The reduction is pure: `scoreRun` compares each attempt's final workspace against the expected capture, and against the attempt's own initial state when the scenario ships no expectation; `pass` is that comparison holding for every attempt, and a failure reports the first divergent attempt's changed paths. Tokens and wall time are medians across attempts, with every wall-clock sample carried on the record.

### Token accounting

Billed tokens come from `ctx.tokenMeter.measure` and nowhere else. Each harvested session log is read by `llm-replay`'s fixture reader — the same reader that validated it as a replay source — rebuilt as a `Session`, and measured; the run's number sums every harvested session, so a nested run bills its children too.

### Skip semantics

A scenario directory the corpus does not contain, one without a recorded session fixture, and one without `input.json` each report `{ status: 'skipped' }` with the reason, without running anything. Only a `corpusDir` that does not exist fails loud: that is a misconfiguration, not a scenario the waived recording phase never produced.

### Scoring-semantics version

`SCORER_VERSION` names what a triple means. `EvolutionScorer.version` carries it, and the optimizer stamps it on every experiment row, so a scoring change retires the old floors and repeat-matches instead of comparing across them. Bump the constant with any change to what counts as pass, what counts as billed, or how the median reduces — the ledger treats the bump as a new evaluator, and the old rows stay readable but incomparable.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `EvolutionScorer` service, configuration, and the attempt loop |
| [`src/scenario.ts`](src/scenario.ts) | Corpus planning: input script, fixtures, sidecars, and skip reasons |
| [`src/score.ts`](src/score.ts) | Pure reduction of attempts into the metric triple |
| [`src/workspace.ts`](src/workspace.ts) | Workspace comparison over captured entries |
| [`src/sessions.ts`](src/sessions.ts) | Token-meter accounting over harvested session logs |
| [`src/statistics.ts`](src/statistics.ts) | Median over per-attempt samples |
| [`src/runner.ts`](src/runner.ts) | The process-level runner a composition passes in |
| [`src/behavior.ts`](src/behavior.ts) | Behavior gates: contract check, trigger-query routing, and replay comparison |
| [`src/types.ts`](src/types.ts) | Public request, plan, attempt, and record types |

No invariant companion is published: the scorer owns no durable state, so there is no second independent observation to check.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness.spec.md) — the behaviour contract this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [Snapshot harness](../../test-support/session-snapshot/README.md) — the corpus plan, workspace capture, and ACP runner this package scores.
- [Keyless LLM replay](../../test-support/llm-replay/README.md) — the fixture reader and replay adapter behind every attempt.
- [Token meter](../../llm/token-meter/README.md) — the measurement this package reports as billed tokens.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-scorer) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

None, as scoring reads recorded fixtures and reports numbers without registering any prompt, schema, or result text.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when scoring is not the right comparison. They are current package constraints.

- **Replay tier only** — every attempt runs the keyless recorded-session tier; a live-API comparison needs a runner of the same shape, and no recording path exists here.
- **ACP runner only** — the shipped runner is the snapshot harness's ACP tier, so corpora driven another way (the headless `snapshots/session` suite) need their own runner.
- **Median over one host** — wall time is a single-process wall clock on the scoring host, not a CPU budget; `benchmarks/` owns perf gates.
- **Whole-run tokens** — the token number sums every harvested session, so a nested run's context is counted on each session that carries it.
- **No Pareto or fan-out** — GEPA fan-out stays deferred by the specification; pairwise baseline-vs-candidate replay over the same scenarios is what `evaluateBehavior` compares.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
