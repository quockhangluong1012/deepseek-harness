# Agent Note: Skill drift and recall utility

Status: implemented

English | [中文](2026-09-22-skill-drift-and-recall-utility.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §22 (staleness and concept drift), §23 (relevance feedback loop), and §24 (memory utility learning) name three mechanisms this repository had built only as records, and two of them not even as records.

§22 asks a system to notice that an old skill is no longer valid, from time decay, a recent failure spike, a task-distribution shift, tool and version changes, low retrieval utility, and conflicting newer evidence, and to move the skill `active → suspect → stale → archived` rather than trusting it forever. The curator moved skills on elapsed time plus three failure rules, and every one of those movements landed on `stale` directly: a single pass of evidence retired a skill as if a month had passed. The `suspect` rung the specification names did not exist in the lifecycle union at all. Nothing measured a tool or version change, a task-distribution shift, or a skill's retrieval utility, so those signals could never move anything.

§23 asks retrieval quality to be learned from use: `memory retrieved → used? → cited? → affected decision? → helped outcome?`. The reviewer attached a ranked recall as an ordinary context item labelled `Recall: <id>`, and that was the whole record. Nothing counted a recall, nothing tied one to what happened afterwards, so a memory with lower embedding similarity could never outrank a more similar, useless one.

§24 derives `memory_utility = relevance × decision_impact × outcome_gain × source_quality`, and `evolution-metrics` reported `memory-utility` as structurally unmeasurable, its `unavailableReason` reading "no recall-hit counter and no outcome linkage exist". The `conflicting-evidence` uncertainty kind and each artifact's `refutationCount` existed and drove no lifecycle transition: both are per scope and per artifact, and no stored field links either to a skill.

A further defect surfaced while reading the telemetry domain: `failureCount` and `lastOutcome` were written by `markFailed` and read by three curator rules, but were never declared in the domain's record schema — which re-parses every stored record on open. Both counters were therefore dropped on the next start of any host, silently zeroing the failure-rate rule and the staged-candidate rate.

## Decision

1. **`suspect` is a member of the shared lifecycle union**, declared in `evolution-skill-telemetry` and defaulted in the record schema (`state` gains `.default('active')`), so a version-2 record written before the rung existed opens unchanged instead of failing the domain open. Entering `suspect` stamps `suspectAt`, leaving it clears the stamp, and `SkillUsageRecord` declares the field. `CuratorTransition` and `RollbackRestored` inherit the member through the union they already carry, so no second vocabulary was added.

2. **Evidence and idleness move a skill on one ladder, not two.** `decideTransition` keeps its single implementation; what changed is where each kind of movement lands. Idleness moves `active → stale` and `suspect or stale → archived`; evidence moves `active → suspect`. `suspect` ages into `stale` on the same idle threshold `active` does, and a load newer than the instant the skill became suspect returns it to `active` — that comparison is what makes a clean load answer the evidence, and why an *older* clean load cannot.

3. **The four derivable §22 signals live in one pure module**, `packages/evolution/evolution-curator/src/drift.ts`, over records the profile already holds: `failureSpike` (a decisive `trigger_review` grading attributed to the skill, unanswered by a newer load, inside `driftWindowDays`), `conflictingEvidence` (a `conflicting-evidence` uncertainty signal recorded after the skill's last load or patch), `lowUtility` (the §40 library-relative excess at or below `lowUtilityFloor`), and `versionChange` (a recorded lineage envelope whose dependency versions differ from the envelope before it, after the skill's last use or patch). Every signal contributes to the transition reason as `drift: <names>`, and any one of them is enough. The two new thresholds are `Config` fields: a deployment that wants a wider failure window or a slack utility floor changes configuration, not code.

4. **The lineage and uncertainty stores are structural seams, not dependencies.** The curator declares the three fields it reads (`RecordedExperiment`) and a `signals` shape locally and guards with `typeof Reflect.get(...) === 'function'`, the pattern `evolution-memory` already uses for its optional heartbeat and embeddings seams. An unmounted store makes its own signal quiet and leaves the rest working — the curator gained no dependency on either package.

5. **The recall ledger is kept where the recall already lands.** `RECALL_LABEL_PREFIX` moved to `src/recall.ts` beside the ledger vocabulary it now keys, `addContextItem` appends one row when a label carries the prefix, `applyExtractionDecisions` binds every recall still awaiting a decision to the batch that landed with a recorded extraction, and `recordRecallOutcome` grades the newest recall of a memory still awaiting an outcome — refusing loudly when there is none rather than grading twice. `recalls()` reads the ledger across scopes; `recallUtility()` derives §24's product per memory.

6. **Two §23 links are named, not invented.** Whether an injected item was *used* and whether it was *cited* have no writer anywhere in the repository, so the ledger records retrieval, the decision batch, and the outcome, and both the README and the metric caveat say which links are missing. §24's `source_quality` factor has no recorded source for a recalled memory for the same reason, so the utility is that three-factor product.

7. **`memory-utility` became a measurement.** `evolution-metrics` reads `ctx.evolutionMemory.recallUtility()` and reports the mean utility of the recalled memories; with no store mounted, or no recall recorded, it stays unmeasurable and names exactly the missing record instead of reporting a zero.

## Alternatives considered

- **A second transition ladder for evidence.** Rejected: two functions deciding one skill's next state could disagree, and the existing ladder already threads idleness and failure evidence together. Routing evidence to `suspect` inside `decideTransition` keeps one ordering to reason about.
- **Evidence moving `active` straight to `stale` on a strict enough threshold.** Rejected as a misreading of §22: the rung exists so that evidence *questions* a skill without retiring it, and the demand requirement — a suspect skill ages out only on idleness — is only expressible if the state exists.
- **Adding `used` and `cited` as recorded links.** Rejected: nothing observes whether an injected item was read, and inventing a writer in the memory store would fabricate evidence about a model's attention. The ledger records what the profile records.
- **Reading the claim graph's contradicted claims and each artifact's `refutationCount` directly.** Rejected: both are per scope and per artifact, and linking either to a skill needs a field no record carries. The per-skill `conflicting-evidence` uncertainty signal is the link that does exist, and the README states the limitation instead of approximating it.
- **Deriving a task-distribution shift from `evolution-meta`'s `taskClass`.** Rejected: that key is the optimizer's skill under test, not a task class, and skill usage records sessions rather than the tasks those sessions asked for. No task-class axis exists on skill usage, so the signal is not derived at all and the gap is documented as current.
- **A `suspect → stale` transition on the next pass regardless of idleness.** Rejected: a pass cadence would then decide a lifecycle, so a host that ticks hourly would retire a skill in an hour. Ageing on `staleAfterDays` keeps the two ladders' thresholds comparable.
- **A separate `evolution-drift` package.** Rejected: the signals are read by the curator's pass and by nothing else, and the rules are pure functions tested without a context — a package would add a profile row and a README pair for one import.
- **Reporting a zero for `memory-utility` when no memory has an outcome.** Rejected: zero is "measured, and worthless", and the factors that are missing are not measured at all. The reading stays a four-factor product with three measured factors, and the caveat names the fourth.

## Consequences

- A skill can now sit in `suspect`: the status line under `command-evolution`, the survey, the purge path, and `/curator` rendering all see a fourth state. `command-evolution`'s `/curator status` counts states through a narrowed `'active' | 'stale' | 'archived'` parameter and therefore under-reports until it is widened (reported to the batch owner; that package is out of this change's edit scope).
- `SkillUsageRecord` gains `suspectAt`, and `state` gains a defaulted member. Every consumer that switches on the union must handle four states; the two that switch today (`consolidate`, which archives, and the purge path, which selects `archived`) compare for equality and are unaffected.
- The recall ledger is a new defaulted field on the `evolution_memory` record, so the domain stays version 2 and a committed record opens with an empty ledger. It is deliberately outside the brief digest: retrieval is not context the brief renders.
- The curator's pass now reads the uncertainty and lineage stores when they are mounted, so a pass's evidence is fuller in a composed host than in a bare one, and a store that throws is contained by the same optional-seam guard as the rest.
- `recordRecallOutcome` is the one new writer a caller must supply: nothing grades a recall on its own, so the loop is complete only when a pass — the curator's is the natural one — reads an outcome and records it.
- `evolution-metrics` now depends on `@deepseek-ai/dsh-evolution-memory` as a peer and a dev dependency with the matching tsconfig reference. Tests resolve it through the repository's tsconfig paths; an install and the typecheck need that manifest change to land.

## Deviations from the plan

The plan was §22–§24 read as one unit of P1–P3 mechanism families. Two things were done differently from the first sketch. Instead of a `suspect` revival judged against `lastUsedAt`, the telemetry store stamps `suspectAt`: without it, a skill that became suspect on evidence would revive on the very next pass, because its last load was clean and older than the failure — the stamp is what makes "a load answered the question" decidable. And `failureCount`/`lastOutcome` were added to the record schema rather than left alone, because reading the domain revealed they had never been declared there and were being dropped on every reopen; that is a fix, not a feature, and it is listed below.

## Fixes found on the way

- `packages/skill/evolution-skill-telemetry/src/spec.ts` now declares `failureCount` and `lastOutcome`. Both were written by `markFailed` and read by the curator's trust-failure and failure-rate rules, and the domain re-parses every record it opens, so both counters were silently dropped on the next start. The regression test that pins this fails without the schema change.
- The curator's `recordTrust` read the feedback store per skill while the new drift signal needed the same list; both now read it once through `signalsFor(name, usage)`, and a store that throws still leaves the trust pass treating the skill as unattributed rather than failing the pass.

## Testing

`packages/evolution/evolution-curator/tests/drift.spec.ts` covers the pure rules without a context: the reason builder's empty case, each signal's firing and quiet case, the version rule's envelope ordering, its fewer-than-two-envelopes and already-covered cases, the skipped `skill` key, and the newest-patch comparison.

The same package's `curator.spec.ts` boots the curator over real stores and pins the behavior that matters: a skill with a recent failure spike and a `conflicting-evidence` signal reaches `suspect` while a quiet skill of the same age stays `active`; low measured utility and a changed dependency version each reach `suspect` on their own; a suspect skill ages into `stale` only on idleness and returns to `active` on a load newer than the instant it became suspect; and the three former evidence movements now land on `suspect`.

`packages/evolution/evolution-memory/tests/recall.spec.ts` covers the label reader's rejection cases, the ledger folds (prepend-and-cap, bind-once, grade-the-newest), the utility arithmetic, and — over the real store — that a recall is counted as the recalled item lands and only for recall labels, that a decision batch binds awaiting recalls once, that grading refuses a memory with nothing awaiting an outcome, and that a recall survives its item's removal. Its utility test pins the acceptance case directly: two memories recalled once each, one with a later clean outcome and one without, so the recorded outcome is the only difference and it raises the first above the second.

`packages/evolution/evolution-metrics/tests/metrics.spec.ts` mounts the memory store and asserts `memory-utility` names the missing record with no recall, reports `0` for a recall nothing followed, and reports `relevance × decision impact × outcome gain` once a batch and a clean outcome landed — with the caveat naming the links that are not recorded. `packages/skill/evolution-skill-telemetry/tests/telemetry.spec.ts` pins the suspect stamp's lifecycle, the failure counters' survival across a reopen, and the schema default.

## Left alone

§22's task-distribution shift is not derived: skill usage has no task-class axis, and inventing one from session ids would be a guess. The two per-scope sources §22 names — the claim graph's contradicted claims and the memory store's `refutationCount` — still drive no transition of their own, and reach the ladder only as the per-skill uncertainty signals that exist. §23's `used` and `cited` links have no writer, and §24's `source_quality` factor has no recorded source, so the utility is a floor rather than a full §24 measurement; the ledger is additive if a later change records any of them. Nothing new reaches a model prompt: the drift signals and the recall ledger are reads and durable rows, so §58.12's recorded-not-enforced boundary holds.
