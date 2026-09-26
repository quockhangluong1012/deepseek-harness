# Agent Note: Claims carry evidence, contradiction, and supersession

Status: implemented

English | [中文](2026-09-22-claim-evidence-graph.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §19 asks for memory as a claim/evidence graph rather than a pile of notes, §20 forbids storing a single confidence score in favour of a decomposition that "should rise from independent evidence, not from repeatedly recalling the same memory", and §53 names both halves as the upgrade for Memory ("evidence-backed claim graph + utility feedback") and the Knowledge Graph ("claims/evidence/contradiction/supersession graph"). The repository had built only the recording halves, and the gap was written down in the packages themselves:

- `evolution-graph` stored entities and directed relations, and a relation is *how often one phrase was read from one text*: it records no source, so nothing could be contradicted. Its README recorded the consequence as a current limit — "an edge that a later source contradicts keeps its count".
- `evolution-memory` already graded every extraction into `confirms`/`contradicts`/`new` decisions and wrote them as one artifact's `validationCount`, `refutationCount`, and `confidence`. A fact confirmed ten times by one session therefore looked exactly like a fact confirmed by two, and nothing joined a fact to the evidence for it, the trace it was observed in, the claim it replaced, or the skill that consumes it.
- The extraction path ended at the store: the reviewer's decision batch reached `evolution-memory` and stopped, so no other durable state could derive from a claim being confirmed, contradicted, or corrected.
- `evolution-metrics` declares `memory-utility` unavailable for want of a recall-hit counter and an outcome link.

So a scope could accumulate evidence indefinitely and still be unable to say what it believed, on whose word, or against what.

## Decision

`@deepseek-ai/dsh-evolution-graph` grows a claim/evidence layer beside its relations, and `@deepseek-ai/dsh-evolution-memory` publishes the decision batches that feed it.

1. **The claim layer lives in the graph's per-scope record.** A `Claim` carries `supportedBy` and `contradictedBy` — one evidence entry per source, each with `source`, `quality`, `reliability`, `firstAt`, `lastAt`, and `count` — plus `observedIn`, `supersedes`, `derivedFrom`, `usedBy`, `status`/`retiredBy`, and the belief fields below. `recordClaims` is the write face, `claims` answers a query over the ones that still stand, and `claim` reads one by identity, retired or active. No new domain and no new package: the record gained a zod-defaulted `claims` array, so a graph written before it opens unchanged and the domain stays version 1.
2. **Belief is derived, never supplied.** `deriveBelief` stores the whole §20 decomposition — `confidence`, `evidenceQuality`, `sourceReliability`, `independentSupport`, `contradictionCount`, `recency` — so a consumer can see why a claim is believed rather than only how much. Confidence is the strongest supporting evidence quality times the most trusted supporting source, times the saturating factor `n / (n + 1)` over distinct supporting sources, divided by one plus the distinct contradicting sources. The saturation means further independent sources add less and no count of them alone can reach 1; the division means a contradiction always lowers the claim it lands on.
3. **Re-observation cannot reinforce.** Evidence merges per source: a source already on a claim gains only `count` and `lastAt`, keeping the quality and reliability it first attested with. `independentSupport` therefore counts sources and never reads, which is the feedback loop §20 forbids. The lesson artifact's `validationCount` keeps its documented meaning — times a later extraction confirmed the fact, which is what the UI shows — and belief no longer has anything to do with it: the reviewer's prompt renders only statements, and confidence reads sources.
4. **A `supersedes` retires, it does not edit.** Claim identity is the normalized statement, so a corrected statement is a second claim whose `supersedes` names the first; the retired claim keeps its evidence, its edges, and its place in the record, reads as `status: 'retired'` with `retiredBy` naming its successor, and answers no query. That is what closes the README's "a contradicted edge keeps its count" limitation for claims, while leaving it true of a bare relation edge, which is frequency rather than belief. Retirement is applied after every assertion of a batch, so the order a batch happens to list its claims in cannot decide which one survives.
5. **The producer is the shipped reviewer path, not a command.** `evolution-memory` publishes one `evolution/decisions-applied` event after a decision batch is durable, carrying the scope, the source session, the batch, and the scope's artifacts as they read *before* the write. The graph folds it into assertions: a `new` candidate becomes a claim supported by its own `source` at its evidence kind's quality and its stated confidence; a `confirms` adds support from the session that decided it; a `contradicts` adds contradiction from that session, and one carrying a replacement statement also stands a new claim that supersedes the corrected one. The pre-write artifacts are load-bearing: a `contradicts` keeps the artifact's `id` while replacing its statement, so only the pre-write statement names what a correction corrects. A decision addressing an artifact the batch never held evidences nothing, exactly as the store skipped it.
6. **Nothing new reaches a model.** The claim layer is a pure fold over decisions the reviewer already paid for; it adds no prompt, no call, and no session event. The memory store's event is in-process.
7. **A listener cannot fail the write that published it.** The decision batch is already durable when listeners run, so a throwing consumer is logged and contained exactly as `domain/changed` observers are, and the graph's own fold (which writes to a second domain) logs a warning instead of failing the memory call.

## Alternatives considered

**A claim store of its own — a new domain, or a new package.** Rejected: claims are per-scope, small, and read alongside the same scope's entities, so a third durable copy of scope state would need its own open/close/cap wiring and a second read path for every consumer that needs both. The graph's record is already the scope's knowledge index; claims belong in it.

**A second table in `evolution_graph` rather than a defaulted field of `records`.** Rejected: every query reads the record whole, and splitting claims out would make `read()` two reads for one scope with no benefit, while the defaulted field keeps committed records openable without a version bump.

**Counting sources inside `evolution-memory` — making `validationCount` count distinct sessions.** Rejected: `validationCount` and `refutationCount` are displayed history ("times a later extraction confirmed this fact") and the reviewer never shows them to the model, so reshaping a durable field and a UI counter to fix a belief computation would put the fix in the wrong layer. Belief is computed where §20 puts it, and the store keeps counting history.

**Deriving claims from `domain/changed` instead of publishing a batch event.** Rejected: the record alone cannot attribute a `confirms` to the session that made it, so independent support — the number §20 is entirely about — would be uncountable from the domain snapshot. The event carries the batch, its session, and the artifacts the decisions were resolved against.

**A `/claims` command as the producer.** Rejected: the point of the change is that the shipped reviewer populates the graph without a human asking. The read face stays a service API for whatever renders it next; a command that pushed claims by hand would have been the shape this repository already had too much of.

**Editing a corrected claim in place.** Rejected: identity is the normalized statement, so rewriting a claim's statement would leave `supersedes`, `derivedFrom`, and `retiredBy` addressing a statement the record no longer expresses. A correction is a second claim, and the old one retires — the same trade the artifact store already makes by keeping the artifact's id across a correction.

**Weighting `recency` into the belief.** Rejected: discounting a fact for age alone needs a clock and a half-life nobody has calibrated, and inventing one inside a pure fold would bake an unmeasured policy into every stored confidence. The field is recorded so a consumer, or a later decision with an argument, can weight it; the README states that.

**Dropping a retired claim from the record.** Rejected: a consumer has to be able to see what replaced a claim, which is what `retiredBy` answers. Retired claims stop answering `claims` and stay readable by identity.

**Refusing contradiction at the write, as `evolution-graph`'s caps refuse entities.** Rejected: contradiction is the evidence, not a violation. A claim that a source contradicts stands at a lower belief, and only a superseding claim retires it.

## Consequences

- `ctx.evolutionGraph` gains `recordClaims`, `claims`, and `claim`, and the `maxClaims` cap (default `500`, applied at the write like `maxNodes` and `maxEdges`, and still permitting an update to a claim the scope already holds). A graph record written before this change opens with no claims.
- Populating the claim layer costs no model call: a host that mounts the graph beside `evolution-memory` gets claims from the reviewer's existing batches, and the memory store's decision path is otherwise unchanged.
- A consumer tells a supported claim from a contradicted one by `contradictionCount` and `contradictedBy`, and by the confidence they divided; a replaced one reads `status: 'retired'` with `retiredBy` naming its successor and is absent from `claims` while remaining readable by identity.
- A claim write that fails is logged, not thrown: the lessons it derives from are already stored, and claims are derived state whose loss costs a fold rather than a fact.
- The graph still publishes no invariant companion, and the new event is in-process: it reaches no model prompt.
- The package README records the claim layer's own limits: belief is an ordering rather than a probability and `recency` is unweighted; only the reviewer's decisions fold (a hand-written, UI-patched, or decay-pruned artifact leaves claims as they were); a candidate the store merged into a paraphrase still claims its own statement; a `supersedes` naming a claim that does not exist yet retires nothing; `usedBy` is expressible but has no writer in this repository; and the caps refuse rather than evict.

## Testing

`packages/evolution/evolution-graph/tests/graph.spec.ts` gains a `claim graph` block over the real store. It pins that two independent supports raise belief while re-reading one source — even regraded — moves only its `count`, that one contradicting source contradicting twice stays one contradiction while a second source divides the belief again, that a `supersedes` retires its target whichever order the batch lists the two in, that a self-supersede and an unknown target do nothing and a re-supersede keeps the first retirer, that blank statements and blank sources are dropped, that the `maxClaims` cap refuses new statements while still updating a held claim and a batch that stored nothing reaches no write, and that a query returns active claims best-believed-first under `maxQueryLimit` while a retired claim answers nothing and stays readable by identity.

The producer is pinned end to end with `evolution-memory` and the graph mounted over one in-memory backend: a `new` candidate creates the claim with its source, kind quality, and stated confidence; a confirm from the same session raises `count` and not `independentSupport`; a confirm from a second session raises both; a bare `contradicts` lowers the standing; a `contradicts` with a replacement retires the corrected claim and stands the new one with the correcting session as its support; a decision naming an artifact the batch never held evidences nothing; and a domain closed under the fold logs a warning instead of failing.

`packages/evolution/evolution-memory/tests/decisions-applied.spec.ts` pins the event contract: the batch and its pre-write artifacts publish after the write and carry the artifacts as they read before it, a batch applied without a recorded extraction publishes nothing, a staged `applyDecisions` approval publishes under the entry's origin session, and a throwing listener cannot fail the durable write.

Both suites pass under `vitest run packages/evolution/evolution-graph packages/evolution/evolution-memory` (204 tests, 9 files), and every `src/` file of both packages holds the per-file 100% coverage gate.

## Left alone

Relations keep their counts: a bare edge is frequency, and nothing about the claim layer changes `observe`, `answer`, `expand`, or `find`. The artifact counters keep their documented meaning. `evolution-metrics`' `memory-utility` stays unavailable — `usedBy` is the link the claim layer can express (which skill or policy consumes a claim), but no store yet pairs a recall with an outcome, and that measurement is the metrics package's to add. The `/graph` command, the graph's extraction sweep, the reviewer's prompt, `evolution-dreaming`'s promotion gate, and the controller's wire face are untouched.
