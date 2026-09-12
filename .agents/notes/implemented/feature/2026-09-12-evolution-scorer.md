# Agent Note: Evolution Scorer — the Metric Triple over Recorded Scenarios

Status: implemented

English | [中文](2026-09-12-evolution-scorer.zh.md)

## Problem

The outer loop needs a way to say whether a change made the harness better, and the repository had no comparable measurement owner. The snapshot suites compare transcripts exactly — the right question for "did this output change?", the wrong one for "is the agent better now?": they assert, then stop, and every scenario that must be scored also had to be re-recorded behind an API key. Meanwhile the three numbers the specification names (pass, billed tokens, wall time) each already had an owner elsewhere: the workspace capture, `ctx.tokenMeter`, and the attempt's own clock. What was missing was one package that composes them over the corpus that already exists.

## Decision

Ship `@deepseek-ai/dsh-evolution-scorer` in the `evolution/` group with one service and one pure function.

`EvolutionScorer` (`ctx.evolutionScorer`, `inject = ['tokenMeter']`) takes a `corpusDir` and an attempt count, and `score({ scenario, agent, run })` plans the scenario off disk, runs it `attempts` times through the caller's runner in the snapshot harness's `replay` mode, and returns `{ status: 'scored', score }` with the metric triple: `pass` plus the changed paths, `tokens`, `wallTimeMs`, and every wall-clock sample. `loadScenarioPlan` resolves the ACP input script, the highest recorded session-fixture generation (and its children) through the harness's own fixture reader, and the optional `replay.override.json`, `workspace/`, and `workspace.expected/` sidecars.

The reduction is pure and separately exported: `scoreRun` compares each attempt's final workspace against the expected capture — or against that attempt's own initial state when the scenario ships no expectation — passes only when every attempt matches, and reports the first divergent attempt's paths so a failure names files rather than a verdict. `diffWorkspace`, `medianOf`, `measureRunTokens`, and `loadScenarioPlan` are exported beside it so specs drive the arithmetic without spawning a process.

Billed tokens come from `ctx.tokenMeter.measure` and nowhere else: each harvested session log is read by `llm-replay`'s fixture reader, rebuilt as a `Session`, and measured, and the run's number sums every harvested session. The process runner is the harness's own `runScenario`, re-exported as `processScenarioRunner`; the scorer adds no subprocess machinery of its own.

Replay stays the harness's, too. The plan forwards `replay.override.json` and the recorded child fixtures through the harness's own environment wiring, so first-call-order script binding, the override sidecar, and the end-of-run `assertConsumed` check all run inside the booted subprocess exactly as they do for the snapshot suites — the scorer neither re-implements nor duplicates them.

Skip semantics are the honest half of the waiver: a scenario directory the corpus lacks, a scenario without a recorded session fixture, and a scenario without `input.json` each return `{ status: 'skipped', reason }` without running anything. Only a `corpusDir` that does not exist throws, because that is a misconfiguration rather than a scenario the recording phase never produced. Nothing in the package writes: the runner is only ever called with `mode: 'replay'`, so no code path records a fixture and no API key is consulted anywhere.

Corpus planning infers the workspace expectation from the presence of `workspace.expected/` rather than reading `snapshot.yml`, because the snapshot fixture guard already enforces that the directory exists exactly when the manifest declares a final workspace, so the two decisions cannot disagree.

## Alternatives considered

- **Asserting through the snapshot suite instead of a new package.** Rejected: the suite's `expect(...).toEqual(...)` comparisons discard the numbers under test. A score has to be a value a caller can compare across runs, not an assertion that aborts.
- **Scoring from `snapshot.yml`'s `workspace.final` flag.** Rejected: the suite's fixture guard ties that flag to the `workspace.expected/` directory, so reading the directory is the same decision with one fewer parser and one fewer failure mode.
- **Re-counting text for tokens.** Rejected outright: the specification names `tokenMeter.measure`, and the meter already owns route pricing, provider usage anchors, and image pricing. Rebuilding each harvested log into a `Session` keeps that fold authoritative; the spec covering the `text-turn` fixture asserts the recorded provider usage (3091 input + 23 output) rather than a text-length proxy.
- **Booting the ACP subprocess inside this package's own specs.** Rejected: that is the snapshot suites' tier, and running it under the coverage gate would trade minutes of Windows startup for no additional signal. The service spec supplies a recorded runner and still exercises the real plan, the real workspace captures, and the real meter; `processScenarioRunner` remains a one-line binding to the harness.
- **Letting `ctx.evolutionScorer` own the corpus configuration only.** Rejected: an agent composition cannot be expressed in `cordis.yml` (it names script paths and a tsconfig), so the runner and composition arrive per request, which also lets a headless corpus supply its own runner without a second scorer.
- **Reusing the harness's canonical-log normalization and redaction for the score.** Rejected: the metric triple has no transcript component. Normalizing stdout, re-redacting ids, and diffing canonical logs answers "did the transcript change?", which the snapshot suites already own; the workspace diff is this package's whole pass criterion, so it captures only the fixture inventory, the capture, and the meter.
- **A Pareto or GEPA surface here.** Deferred by the specification; the triple is the unit those layers would consume.

## Consequences

An improvement claim is now a number: two runs of the same scenario produce comparable `pass`, `tokens`, and `wallTimeMs` values, and the samples stay on the record so a reader can see the spread behind the median. Scenarios the corpus does not cover cost nothing — they skip with a reason instead of failing a run or demanding a key. The cost is coupling: this is the first product package that depends on `@deepseek-ai/dsh-session-snapshot` and `@deepseek-ai/dsh-llm-replay`, which is deliberate (the corpus, the fixture reader, and the ACP runner are exactly the surface being scored) but does mean the scorer's runtime graph includes the snapshot harness. Wall time is a single-host wall clock, so it is a comparison signal, not a performance gate; `benchmarks/` keeps that role.

## Testing

`tests/workspace.spec.ts` covers the entry diff across every captured kind, path ordering, and a same-path kind change. `tests/score.spec.ts` covers pass and fail against an expected capture, the per-attempt initial-state fallback, first-divergence reporting, and medians over injected timings and token samples. `tests/statistics.spec.ts` covers odd, even, single, and empty samples. `tests/scenario.spec.ts` covers the missing corpus, unknown scenario, fixture-less scenario, script-less scenario, and a fully resolved plan with the highest fixture generation and children. `tests/scorer.spec.ts` drives the service over a corpus written to disk with every attempt in `replay` mode, and asserts the recorded fixture's provider usage (3114 tokens) as the run's billed number. Per-file 100% holds on statements, branches, functions, and lines.

[Some lines truncated to 768 chars]
