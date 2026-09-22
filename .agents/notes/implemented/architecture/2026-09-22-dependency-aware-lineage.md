# Agent Note: Dependency-aware lineage

Status: implemented

English | [中文](2026-09-22-dependency-aware-lineage.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §34 states that every evaluation result must record dependency versions, because changing the evaluator can invalidate historical metrics and changing retrieval can make old usage metrics incomparable; §36 asks that when performance improves, the record say which change caused it; §48 requires evolutionary experiments to be reproducible. Two earlier notes closed parts of this loop on the optimizer's own ledger — [Dependency-aware evolution](2026-09-16-dependency-aware-evolution.md) stamped the scorer version onto experiment keys, and [Artifact lineage and causal attribution](2026-09-16-artifact-lineage.md) recorded edit-size counts — but neither left a standalone record of the full dependency set an experiment ran under, no check compared two results for apples-to-apples before trusting a metric delta, no ablation said which of two changes caused a gain, and no seed record made a run replayable.

## Decision

One new package, `dsh-evolution-lineage`, holding durable dependency-versioned experiment envelopes with comparability and attribution:

1. **Every evaluated candidate is an envelope.** `record` stores the hypothesis, candidate, operator, tasks, measured triple, outcome, regressions, rejected reason, lessons, the seven dependency versions (prompt, skill, retriever, evaluator, model, tool, env), and the seeds under its experiment identity, stamped with the recording instant.
2. **Comparability derives at read time.** `compare` reports the configured compared keys whose versions differ — default skill, evaluator, retriever, model — and holds exactly when none changed; an undefined version against a recorded one counts as changed, so an experiment measured under an unknown dependency never silently compares. Comparisons are recorded facts, never gates (§58.12).
3. **Attribution is pure.** `attributeImprovement` credits a two-factor ablation from its four arms: the joint arm must pass for any credit at all, both single arms passing credits both changes, one passing credits it, and neither passing alone credits the interaction — neither change reproduces the joint gain on its own, so no single arm earns it.
4. **Every envelope replays.** `replay` returns the detached envelope whose seeds reproduce the run (§48). One durable domain, `evolution_lineage` v1, holds one `experiments` table keyed by experiment identity; invalid rows fail the domain open loudly.

## Alternatives considered

- Extend the optimizer ledger with the full dependency set — rejected: the ledger records per-run outcomes under the optimizer's governance; the envelope store is the cross-run comparability home with its own compared-keys configuration, and the optimizer package already owns its staged-write governance to other stores.
- Derive comparability from the population store's parentage — rejected: parentage says which candidate descended from which, not under which dependency versions each was measured; lineage answers descent, envelopes answer measurement conditions.
- Enforce incomparability as a promotion gate — rejected: §58.12 keeps trust recorded-not-enforced; the store reports the verdict, and refusing an incomparable promotion remains an operator's job.
- Three-way and factorial ablation — rejected: two factors cover the single-change discipline §36 wants; larger designs add arms without a current consumer.

## Consequences

- Metric deltas are now trustworthy: `compare` names exactly which dependency moved before an operator trusts that a win means a better skill rather than a new evaluator.
- Improvements are attributable: the ablation verdict says whether one change, both, or only their interaction reproduces the joint gain.
- Experiments replay: seeds ride the envelope, so any recorded run reproduces from its record.

## Deviations from the plan

None beyond routine. The compared-keys default (skill, evaluator, retriever, model) follows the §34 dependencies the harness actually versions today; prompt, tool, and env ride the envelope so they join comparability by configuration when a version surface exists.

## Fixes found on the way

The `Config` schema's `z.enum(DEPENDENCY_KEYS)` needs the `as const` tuple; a plain `readonly DependencyKey[]` is rejected by zod's enum signature. Test boot passes `{}` explicitly to `ctx.plugin` because Cordis passes `undefined` config to services with a `static Config` schema, the same precedent as the stagnation and islands stores.

## Testing

Pure helpers: canonical key order, identical records, undefined-vs-string both ways, given-order reporting, key scoping, comparable true/false with scoping, and all five attribution outcomes (none on joint failure, both, a, b, interaction). Store: recording instant, newest-first listing with the experiment-id tie-break, skill filter, detached copies, envelope found and unknown, compare comparable plus changed-keys plus outside-keys-stay-comparable plus unknown either way, replay detached with seed integrity and unknown, restart persistence through the zod spec, reads-before-start. 11 lineage tests and 8 store tests pass; the new package is at 100% statements/branches/functions/lines.

## Left alone

The store records comparability, it does not enforce it: refusing an incomparable promotion remains an operator's job per §58.12 (documented in the package's Known Limitations). Attribution covers two-factor ablation only; three-way and factorial designs are deferred. A retired comparison stays incomparable until an operator records a fresh envelope — no automatic re-measurement.
