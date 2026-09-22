# Agent Note: Controlled self-model

Status: implemented

English | [中文](2026-09-22-controlled-self-model.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §42 asks for a controlled self-model — a durable per-skill record of strengths, weaknesses, uncertain areas, failure modes, preferred tools, and evaluator blindspots — and §33 asks for a capability frontier that answers "what should I learn next?". The harness had neither: skills carried no durable self-view across runs, capability pass-rates lived only inside transient evaluation outputs, and nothing ranked capabilities weakest-first. The existing `/frontier` command (2026-09-16-capability-frontier) derives a weakest-first ranking by joining optimizer, telemetry, feedback, and catalog seams at read time — it writes nothing and owns no record, so there is no durable per-skill assessment to consult, persist, or revise.

## Decision

One new package, `dsh-evolution-self-model`, holding a durable record plus a derived frontier:

1. **Assessments upsert whole views with a revision tick.** `mergeModel` replaces every list wholesale — the input is the skill's current whole self-view, not a patch — while the revision ticks one past the previous record (1 for a skill's first assessment) and the instant stamps the write. Whole-view upserts keep the record coherent: it never merges stale and fresh lists at read time.
2. **Observations fold into running pass-rate entries.** `observeCapability` tracks the running pass rate over every observation; confidence is the observation count over `maxObservations` capped at 1; a present failure note leads the newest-first failures capped at `maxFailures`; the observing skill joins the covering set in first-seen order. Both denominators arrive as parameters with a default of 10, so the store passes its validated configuration instead of the pure layer hardcoding a tunable.
3. **The frontier ranks weakest first, deterministically.** `frontierGaps` sorts by pass rate ascending, then confidence ascending (thinner evidence learns first), then fewer covering skills, then the capability name so ties always render the same way; `nextToLearn` returns the first gap or null with no entries.
4. **One record-only domain, no enforcement.** The `evolution_selfmodel` domain (v1) holds a `models` table keyed by skill and a `capabilities` table keyed by capability name. Score, confidence, and failures fold at observe time, so the frontier is a pure sort over stored entries with no configuration dependency. Nothing here calls a model and nothing enforces what the loop must learn (§58.12: trust is recorded, not enforced). Configuration is validated with defaults (`maxObservations` 10, `maxFailures` 10) so an unconfigured mount still runs.

## Alternatives considered

- Reuse the `/frontier` derived join instead of a new store — rejected: the join derives state others own and writes nothing, so it cannot hold a revisable per-skill self-view; the self-model is the durable record the join pattern cannot provide.
- Patch-style assessment merges — rejected: per-field patches need conflict rules for concurrent writers; whole-view replacement keeps one writer's self-view atomic.
- Confidence from the pass rate itself — rejected: a thin 1/1 capability would outrank a measured 9/10; counting observations keeps thin evidence learning first.
- Enforce the learning choice automatically — rejected: §58.12 keeps trust recorded-not-enforced; the frontier names the weakest capability, and scheduling the learning stays an operator's or scheduler's job.

## Consequences

- Every skill now carries a revisable self-view with its known blindspots, and every capability carries its pass rate, evidence weight, failure notes, and skill coverage in one place.
- `nextToLearn()` gives operators and future schedulers a one-call answer to §33's question without mounting optimizer, telemetry, feedback, or catalog seams.
- The `/frontier` command is untouched: it still serves the derived four-seam join, while this package serves the durable record — complementary mechanisms, documented as such in both READMEs.

## Deviations from the plan

None beyond routine. The store aliases the imported `nextToLearn` pure helper as `weakestFirst` so the method and the import never share a call-site name.

## Fixes found on the way

A first draft of the confidence test folded nested observations without passing the custom denominator, so inner folds silently used the default of 10; every nested fold now passes its denominator explicitly. Test boot passes `{}` explicitly to `ctx.plugin` because Cordis passes `undefined` config to services with a `static Config` schema. Indexing the first gap uses `?? null` rather than a non-null assertion to satisfy `noUncheckedIndexedAccess`.

## Testing

Pure helpers: revision from null and from a previous record with wholesale replacement, running pass-rate math (pass then fail is 0.5, recovery toward 2/3), confidence growth to the cap under both default and configured denominators, failure prepend/cap/retention, covering-skill union in first-seen order, the full weakest-first ordering with each tie-break level, empty-frontier and null-next cases. Store: record upsert with revision and stamp, detached copies, skill-ascending assessments, observe create-then-update with the running math, gaps/nextToLearn including the empty store, configured caps, restart persistence through the zod spec, reads-before-start. 10 pure tests and 7 store tests pass; the new package is at 100% statements/branches/functions/lines on every file under `src/`.

## Left alone

The frontier records what to learn, it does not teach it: scheduling or performing the learning stays an operator's or scheduler's job per §58.12 (documented in the package's Known Limitations). `record` replaces every assessment list; partial patches and per-field histories are not tracked. Confidence counts observations, not difficulty; weighting hard cases needs a difficulty signal on observations.
