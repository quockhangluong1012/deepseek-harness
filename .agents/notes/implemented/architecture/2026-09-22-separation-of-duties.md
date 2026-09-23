# Agent Note: Separation of duties for the evolutionary roles

Status: implemented

English | [中文](2026-09-22-separation-of-duties.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §53's Multi-Agent row asks for "separation of duties + specialist roles", and the repository had recorded only the model half of it. `evolution-model-routes` reads §28's topology as routes — which provider/model serves each role, with `conflicts` naming a route that both produces work and judges it — and `evolution-evaluator-strategy` reads §28's independence rule as models: `judgeIndependence` calls a verdict from the candidate's own model `same-model` and counts it toward no corroboration. Both compare models, and §26 gates its Level 3–5 meta-evolution on strong governance, whose weakest point is a decision that cannot be attributed to a distinct identity.

Identities are a different axis. Two routes can be two models and still be one actor: one operator running two models, one agent filling two roles. §53's separation of duties is about that actor, and nothing recorded which identity filled which evolutionary role of a run, so nothing could refuse a decision on that ground. A candidate could be proposed and promoted by one identity, and the stores would report a clean, independent-looking promotion. Once such a refusal is written it must not be satisfiable by absence: a run that recorded neither identity is not thereby separated.

## Decision

1. **Duties are recorded on the store that already owns the role topology, and the roles gain no personas.** `evolution-model-routes`'s domain takes a third table, `duties`, keyed by run+role and holding `{ runId, role, identity, at }`; `recordDuty({ runId, role, identity })` writes one fill and replaces a role re-recorded in the same run, and `duties(runId)` lists one run's fills in §28 topology order. The five roles are the ones `EVOLUTION_ROLES` already names; no agent persona is defined and no model is called.
2. **The rule is pure, and it is the one §53 states.** `separationOfDuties(duties, runId, decision)` (`src/duties.ts`) resolves the role pair `SEPARATED_DUTIES` assigns — `promotion` pairs candidate generation with promotion review, `verdict` pairs candidate generation with evaluation — reads the two recorded identities, and returns `{ allowed: true }` or a refusal. `same-identity` carries the identity and both roles: `identity 'agent-a' filled both candidate-generation and promotion-review for run 'run-1'`. `unknown-identity` names the role that has no record. The rule takes the duties as an argument, so §53's policy is a unit test rather than a host fixture.
3. **An unrecorded role fails closed.** A missing row and an empty identity both read as unrecorded and refuse as `unknown-identity`, because the question the rule answers is whether two identities were shown to differ, and absence shows nothing. `judgeIndependence` reads the same emptiness the other way — an empty judge model is not a self-judged verdict — and that is the difference between annotating a recorded verdict and refusing a decision.
4. **The refusal is the store's own check, and the promotion path enforces it.** `checkDuties(runId, decision)` is that rule over the store's own rows. `/canary promote <id>` in `dsh-command-evolution` consults it before advancing: the command records the invoking session as `promotion-review`, `/curator optimize` records the session that proposed the candidate as `candidate-generation` under the staged write's identity, and a promotion whose two fills are the same session (or whose proposer is unrecorded) is refused with the reason rendered to the operator. The actuator's rollout monitor (`canary.advance(id, 'promoted')`) still records no identity — a heartbeat loop has no session to name — so §49's `auto-promote` risk route governs that path instead.
5. **The duty key is path-safe and injective.** `dutyKey(runId, role)` joins the two with `_`, which no role literal carries, so no two (run, role) pairs can collide and the key satisfies the per-record layout's `[a-zA-Z0-9_-]+` key rule. The existing `routeKey` joins provider/model with `\0` and does not satisfy it — see "Fixes found on the way".
6. **The domain stays at version 1.** A table added to a per-record domain reads as empty in an existing unit, and no version-1 record changes shape, so no `compatibleVersions` entry is needed for the added table.
7. **Nothing here reaches a model prompt, so there is no new session event.** The identities are whatever a caller records; the store observes no session, no agent, and no operator, and it calls no model.

## Alternatives considered

- **One record per run holding a role→identity map.** Rejected: recording one role would be a read-modify-write over the row, so two concurrent fills of different roles in one run could lose one, and the partial-record schema a role map needs is more machinery than a composite key the package already uses for `routes`.
- **Reading an unrecorded role as distinct.** Rejected: it makes the refusal satisfiable by omission — the failure mode §53's rule exists to catch — and it would let a deployment that never records a duty promote on evidence that looks separated.
- **Making `conflicts()` refuse.** Already rejected for the route reading in `2026-09-22-judge-independence-and-defenses.md`: an operator's pin outranks the topology by design. Route conflicts and duty conflicts are also different questions — two distinct models can be one identity, and two identities can share one model.
- **Enforcing inside the promotion paths in this change.** Not available: both call sites live outside this package and carry no identity for either role, and synthesizing one from the promotion itself would record the promoter as its own reviewer or as a stranger, neither of which is evidence.
- **A governance package of its own.** Rejected: the role vocabulary and the run's route record already live in `evolution-model-routes`, and a second store would fork `EVOLUTION_ROLES` and give the topology two owners.
- **Hashing or escaping the duty key.** Rejected: nothing parses the key back, roles are a closed vocabulary without the separator, and hashing would hide the run identity in the medium where an operator has to read it.
- **A schema-migration version bump.** Rejected: the added table is absent, not stale, in a version-1 unit, so discarding readable `routes` and `evidence` records would cost evidence for nothing.

## Consequences

- `evolution_model_routes` now holds a `duties` table beside `routes` and `evidence`; a restart reads the fills back through the same zod spec, and each fill is one durable write with no read-modify-write window.
- `checkDuties` returns a verdict rather than throwing: the caller that takes the decision renders the refusal, and `same-identity`'s reason is written to be the sentence an operator sees.
- The refusal is enforced on the operator promotion path and remains advisory on the actuator's rollout monitor, which has no session to name as a judging identity. §58.12's record-not-enforced boundary therefore holds for that path alone, and a deployment that never calls `recordDuty` gets `unknown-identity` for every run rather than a guessed verdict.
- The role half of a duty key is path-safe by construction; a run id still has to be path-safe, and the per-record JSON layout rejects an unsafe one loudly at write rather than dropping the record.
- `verdict` is recorded and checkable for the evaluation half of §53 without changing `evolution-evaluator-strategy`, which keeps its model-level `judgeIndependence` reading of a recorded verdict.

## Testing

`packages/evolution/evolution-model-routes/tests/duties.spec.ts` pins the rule without a context: both decisions allowed on distinct identities and refused on one identity with the reason naming both roles, both directions of the unknown refusal, an empty identity reading as unrecorded, another run's duties not counting, and the key format. `tests/store.spec.ts` drives the real store: one identity per role per run in topology order, a re-recorded role replacing its identity rather than adding a row, another run's fills staying out, the unknown-then-conflict-then-allowed sequence a promotion walks, the evaluation pair read for `verdict`, persistence across a restart through the zod spec, and the reads throwing before the store starts. Every branch of `src/duties.ts` is covered.

Both `README.md` and `README.zh.md` gained the duty API, the §53 section, and the two limitations, and the pair is re-recorded.

## Fixes found on the way

Not fixed, and worth its own change: `routeKey`/`assignmentKey` in this package join provider/model with `\0`, which the per-record layout's `[a-zA-Z0-9_-]+` key rule rejects, and the base profile runs `storageDomain` on `backend: json`. Booting the real store over `JsonStorageBackend` shows `observe` and `pin` both failing with `per-record key 'candidate-generation\0p\0m' is not path-safe`; the optimizer swallows that as a warning, so route evidence records nothing on a JSON-backed host. `evolution-evaluator-strategy`'s `strategyKey` has the same shape. The new `duties` table does not, which is why its key format differs from its sibling's. A fix needs an encoding decision — a safe separator alone is not enough, since a model id like `llama-3.1-70b` contains characters the layout rejects.

## Left alone

Nothing here changes what a session sees, admits a benchmark task, or starts an evaluation: the store records fills and answers a check that no caller reads yet, and the actuator's loops are untouched. The group README row for this package and the generated Cordis API catalog still describe the pre-duties surface; both are outside this change's ownership and the catalog is a generator's output.
