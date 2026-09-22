# Agent Note: Retrieval-aware evolution

Status: implemented

English | [中文](2026-09-22-retrieval-aware-evolution.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §39 asks evolution to modify not only how an agent reasons but also what it retrieves, and to judge that by downstream task success rather than retrieval precision. §23 and §24 give the framing: a memory retrieved and never used, cited, or acted on is not evidence of retrieval quality, and estimating utility from outcomes is the upgrade over similarity alone.

The repository had built neither half. Nothing evolved a retrieval configuration, and nothing coupled a retrieval change to whether its sessions succeeded:

- The only occurrence of the axis was the string `change-retrieval` in `packages/evolution/evolution-optimizer`'s mutation-operator surface, which ships disabled and names a dimension rather than recording one.
- `packages/context/active-memory-context` is where a retrieval configuration actually takes effect per turn — which lane runs, how deep the graph leg expands, what similarity a hit must clear to be injected — and it recorded nothing about the configuration it ran under. Two sessions briefed under different configurations were indistinguishable afterwards.
- The outcome evidence a judgement needs already existed. `packages/skill/evolution-skill-telemetry` keeps, per skill, the sessions that loaded it and the graded outcome of each (`sessionOutcomes`), and `packages/evolution/evolution-feedback` grades each session's failures by whether the failing call was attributable to a tool. Neither store was read by anything that varied retrieval.

So a deployment could tune its recall for months and keep no record of which configuration served which sessions, let alone which configuration served them better.

## Decision

Add one package, `packages/evolution/evolution-retrieval` (`ctx.evolutionRetrieval`), that records retrieval configurations per session and derives their effectiveness from downstream task success.

1. **The record is the §39 dimension vocabulary.** One `RetrievalConfiguration` carries retrieval source, query expansion, lane weights, reranker, MMR, memory scope, graph depth, and the active-memory threshold. Its canonical key is every dimension in a fixed array order, so two callers that build the same configuration with different field order record one configuration, and the key doubles as the attribution key's prefix.
2. **One table, everything derived at read time.** `evolution_retrieval` v1 holds `attributions` keyed by the configuration key and session id joined, holding `{ configKey, configuration, sessionId, at }`. Effectiveness and the ranking are computed on read, for the same reason `dsh-evolution-budget` settles at read time: the outcome evidence lives in two other stores and can change under a row — a session graded after it ran, a failure attributed after the fact — and a stored rate would be a stale second copy of another store's judgement.
3. **The join is the mechanism, not a new metric.** `gradesOf` takes the task class and the outcome from the skill-telemetry store's graded session outcomes, and fails a session on the classes it loaded when the feedback store grades a signal `complete` — a tool-attributed failure rather than an observed one. A session neither store graded contributes nothing at all, following §40's own convention that an ungraded session is not evidence. Recording a metric here instead would have meant a second grader beside the curator's trust pass, disagreeing with it.
4. **Effectiveness is success, and the ranking is scored the way routes are.** `scoreOf` is the beta-prior smoothed success rate scaled by sample confidence, so this store and `dsh-evolution-router` rank a configuration and a route identically. Nothing in the package measures similarity or precision: a configuration that improves recall scores while its sessions fail ranks below one that does not.
5. **The recommendation is gated on the count of graded sessions, per task class.** `minimumSessions` defaults to 5 and rejects a configuration with fewer graded sessions however it scored; the README states why. Below the gate `recommend` returns `undefined`, which is the honest answer rather than the least-bad configuration.
6. **The producer is the injector that runs the configuration, and its write is a side record.** `dsh-active-memory-context` computes the configuration in force once at mount from its resolved config and records it for a session at that session's first `agent/pre-step`, through a structural `RetrievalLedger` seam read with `ctx.get`. The write is not awaited, the session is marked before it returns, and the step's own messages are untouched — so the brief is byte-identical with and without the store mounted, and a store that is unmounted or failing changes neither the search nor the brief.
7. **No `Retriever` interface, and no restructuring of retrieval.** The task's own constraint cites §52: QMD is a provider seam, the repository already has several retrieval providers, and a configuration record that inserts itself between them would be a new abstraction over providers that already work.

## Alternatives considered

- **Record retrieval precision and rank on it.** Rejected: §39 and §23 exist because precision is the proxy that misleads — a lower-similarity memory with higher decision utility should win. Ranking on the thing the mechanism was created to look past would have made the package pointless.
- **Grade the session in this package and store the outcome on the attribution row.** Rejected: two shipped stores already grade sessions, and a third grader here would either duplicate the curator's trust pass or invent a fourth convention for "the session went well". The attribution row records what ran; the grade stays where it was measured.
- **Record only what the injector sets (lane, depth, threshold).** Rejected: the record is the spec's dimension vocabulary, and recording the shipped choice for the dimensions this mount cannot vary (`weights`, `reranker`, `mmr`, `queryExpansion`) is what lets an optimizer record a configuration of its own — one that does vary them — into the same table and be compared against the injector's on equal footing.
- **A hard dependency on the telemetry and feedback packages.** Rejected: `packages/context/active-memory-context`'s graph leg already reads an optional service through a structural seam, and the same discipline here keeps a deployment without one of those stores deriving effectiveness from the other instead of failing to load.
- **Gate the recommendation on the score instead of the count.** Rejected: the confidence factor only scales the score, so a configuration with four graded sessions can outscore a well-measured loser and still be, in the README's words, one afternoon of evidence. The gate is the count; the score orders what clears it.
- **Record per turn rather than per session.** Rejected: a session's outcome is the granularity both evidence stores grade at, so a per-turn attribution would need a per-turn outcome no store records, and would multiply rows that the same grade answers for.
- **Make the injector import this package's configuration type.** Rejected: a type-only import would still be a workspace dependency and a tsconfig reference for one structurally simple shape, and the injector's own file already declares its optional seams structurally. The two sides are reconciled by the §39 vocabulary, and the projection is one exported pure function.

## Consequences

- A new domain, `evolution_retrieval` version 1, with one `attributions` table. Invalid rows fail the domain open loudly, because the recommendation trusts the numbers it reads.
- `dsh-active-memory-context` gains one optional write per session and no other behavior: no model call, no prompt change, no awaited storage on the turn path, and a debug line when the store rejects a write.
- What a configuration achieved is visible through `ctx.evolutionRetrieval.effectiveness(taskClass)` and `recommend(taskClass)`. The recommendation is a record until a mount asks for it as policy: `dsh-active-memory-context` consults it for the turn's task class behind its own default-off `taskAwarePolicy` field ([task-aware retrieval policy](2026-09-22-task-aware-retrieval-policy.md)), and nothing reconfigures the injector on its own, which is the same posture every evolution row in the product profile holds.
- Nothing here reaches a model prompt, a tool schema, or a session event, so the package publishes no invariant companion — the attribution table is the only copy of this state, and there is no second independent observation to check it against.
- The producer's seam is one-directional and optional in both directions: a deployment without this store records nothing, and a deployment with it but without the evidence stores records attributions that derive no effectiveness.

## Deviations from the plan

The plan asked for the store to be populated in the shipped product. The mount row itself lives in `packages/bundle/web-app/cordis.patch.yml` and the package registration in the generated workspace files (`tsconfig.base.json` aliases, `tsconfig.host.json`, the bundle manifest), all of which this task does not own. The producer is complete and enabled behind its seam; the integrator owns the row, the registration, and the `pnpm install` link.

## Fixes found on the way

None. Two suspicions were investigated and dismissed. The first: that the injector would need a real workspace dependency on this package for the record type, which the structural seam made unnecessary. The second: that the `verify-package-readme-model-experience` gate would accept a new package's short-form Model Experience section without an allowlist entry — it does not, and the audit turned up 19 already-committed evolution and skill READMEs in the same state, so the missing family entries were reported to the integrator rather than worked around in `scripts/`.

## Testing

`packages/evolution/evolution-retrieval/tests/retrieval.spec.ts` covers the pure half without a context: the configuration key is stable across field order and separates all eleven one-dimension variants, the grading join takes a graded outcome over a feedback failure and a feedback failure over nothing, one session is counted once per class, the effectiveness fold keeps running rates and the newest instant, one session is attributed to every configuration that served it while an ungraded one is dropped, and the ranking orders by score with a key tie-break and recommends only above the gate.

`packages/evolution/evolution-retrieval/tests/store.spec.ts` boots the real domain over an in-memory backend and pins the behavior that matters: a second record of the same session keeps one row and its first instant and does not double the sample count; effectiveness comes from the stubbed telemetry outcomes and a feedback-attributed failure, and is empty while neither store is mounted; two configurations over one task class recommend the one whose sessions succeeded and the weaker one is not offered; a configuration below the gate recommends nothing even while it scores higher; attributions survive a restart through the zod spec; reads throw before the store starts.

`packages/context/active-memory-context/tests/index.spec.ts` adds three cases: the injector records exactly the configuration in force (escalation `graph-first` as `source: 'graph'`, the configured depth and threshold) and the injected brief is byte-identical to the same scenario without the store mounted; a second step of the same session records nothing more; and a store that rejects the write still leaves the turn briefed, with a debug line.

Both packages hold the per-file 100% coverage gate (retrieval: 85 statements, 43 branches; active-memory-context: 180 statements, 86 branches).

## Left alone

The `change-retrieval` string in `packages/evolution/evolution-optimizer`'s mutation surface is untouched: the operator names an axis an optimizer would vary, and this package records configurations without claiming to generate them. Nothing consumes the recommendation on its own: the injector runs exactly what its config says until a mount turns on `taskAwarePolicy`, which applies the recommended lane, scope, graph depth, and threshold per turn through a pure decision rule ([task-aware retrieval policy](2026-09-22-task-aware-retrieval-policy.md)).

A session that ran under two configurations counts its outcome for both. Splitting an outcome between the configurations that served it needs per-turn attribution that neither evidence store records; the README states the limit rather than approximating it.

The store is host-wide, not scope-keyed: attributions are global rows, and a per-workspace view would need a scope key on the domain, the same limit `evolution-evaluator-health` and `evolution-router` document for their own tables.
