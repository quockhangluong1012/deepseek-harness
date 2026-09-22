# Agent Note: Uncertainty-driven learning

Status: implemented

English | [中文](2026-09-22-uncertainty-driven-learning.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §51 ranks "uncertainty-driven learning" as P2 #25, and §43 defines it: instead of learning only from failures, learn where the system is uncertain — evaluator disagreement, low confidence, unstable outputs across seeds/models, retrieval ambiguity, and conflicting evidence become high-value tasks for additional evaluation, which is an active-learning loop — with §44 adding that strong model disagreement should run investigate → create evidence → improve evaluator or policy, since disagreement can be more informative than random sampling. The harness already computed per-channel disagreement in the scorer (`evaluatorDisagreement`) and recorded verdicts in `evolution-evaluator-health`, but nothing aggregated uncertainty of any kind into work: a split verdict, a hedged judge, or conflicting evidence had no path to becoming a prioritized re-evaluation task.

## Decision

One new package, `dsh-evolution-uncertainty`, holding a durable signal log with a derived task queue:

1. **Signals are durable facts.** `record(input)` stamps the signal with the current instant and stores it under its signal identity in the `evolution_uncertainty` domain (v1), one `signals` table keyed by signal id holding `{ signalId, skill, taskId, kind, score, detail, at }`, with `taskId` nullable for skill-wide signals and `kind` as a zod enum of the canonical §43 order. The boundary holds: this package never recomputes channel disagreement and never re-records verdicts — those stay owned by the scorer and evaluator-health.
2. **The queue is pure.** `priorityOf` takes the strongest signal as the base, adds the configured `corroborationBonus` per distinct kind past the first — independent kinds agreeing a task is uncertain counts more than one loud signal — and caps the total at 1. `queueFor` groups signals by skill and task identity (null task identity is its own skill-wide group), lists each task's distinct kinds in canonical §43 order, and sorts by priority descending, skill ascending, then task identity (null last, then lexical) so the order is deterministic.
3. **The queue re-derives at read time.** `queue(skill?, limit?)` aggregates the filtered signals and caps them at the caller's limit or the configured `queueLimit` (50); `resolve(skill, taskId?)` drops the signals behind one task — without a task identity only the skill-wide signals — and returns the count removed. Configuration is validated with defaults (`queueLimit` 50, `corroborationBonus` 0.15) so an unconfigured mount still runs.
4. **Record-only store.** Nothing here calls a model; the store prioritizes what deserves another look, and running the evaluations stays an operator's job.

## Alternatives considered

- Accumulate the queue inside evaluator-health — rejected: health owns verdicts, while uncertainty has five kinds of which disagreement is only one; a separate store keeps the active-learning loop queryable without touching verdict logic.
- Decay signal strength with age — rejected: §43 ranks tasks by uncertainty value, not recency; a decayed or windowed history needs a retention policy on the domain, which is deferred to Known Limitations.
- Schedule evaluations automatically from the queue head — rejected: §58.12 keeps trust recorded-not-enforced; the store names the highest-value tasks, and scheduling them remains an operator's job.

## Consequences

- Uncertainty is now actionable: `queue('writer')` names the highest-value re-evaluation tasks with corroborated priorities, so a split verdict or conflicting evidence stops decaying silently into the log.
- Corroboration beats loudness by construction: a task several kinds flag outranks a hotter single-kind one, which is the §44 insight (disagreement is more informative than sampling) generalized across all five kinds.
- Configuration changes re-rank priorities at read time without rewriting recorded signals, and `resolve` closes the loop once a task is re-evaluated.

## Deviations from the plan

None beyond routine. The package follows the assigned slice exactly: five §43 kinds, the corroborated queue, the record/signals/queue/resolve surface, and no re-implementation of the scorer or health boundaries.

## Fixes found on the way

Test boot passes `{}` explicitly to `ctx.plugin` because Cordis passes `undefined` config to services with a `static Config` schema (copied pattern). The deterministic tie-order test needed two insertion orders to exercise every comparator arm — skill ascending both ways and task identity both ways — under the per-file 100% branch gate.

## Testing

Pure helpers: strongest-score base, corroboration bonus, the cap at 1, empty input; grouping merge of same skill and task, null-task separation, canonical kind order regardless of signal order, deterministic tie order from both insertion orders, a corroborated task outranking a hotter single-kind one, empty queue. Store: record stamping with the current instant, newest-first listing across a 5ms gap with skill filter and detached copies plus read determinism, queue default cap with override and skill filter, resolve counting with null-task semantics, restart persistence through the zod spec, reads-before-start. 11 pure tests and 6 store tests pass (17 total); the new package is at 100% statements/branches/functions/lines on `src/index.ts`, `src/spec.ts`, and `src/uncertainty.ts` (`src/types.ts` carries no runtime code), and `tsc --noEmit` on the package is clean.

## Left alone

The store prioritizes evaluations, it does not run them: scheduling and running the queue head remains an operator's job (documented in the package's Known Limitations). Scores are trusted producer inputs with no calibration; strength semantics belong to the evaluators, judges, and retrieval diagnostics. `resolve` drops the whole task group; invalidating one signal of one kind needs single-signal deletion on the domain.
