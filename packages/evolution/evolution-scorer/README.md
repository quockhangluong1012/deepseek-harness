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

```yaml
- name: '@deepseek-ai/dsh-evolution-scorer'
  config:
    corpusDir: /path/to/repo/snapshots/acp
    attempts: 3
```

| Field | Default | Meaning |
|---|---|---|
| `corpusDir` | `required` | Absolute corpus root holding one directory per recorded scenario |
| `attempts` | `3` | Fresh-process attempts per score; the median is taken over their samples |

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
- **No Pareto or fan-out** — pairwise variant ranking and GEPA fan-out stay deferred by the specification.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
