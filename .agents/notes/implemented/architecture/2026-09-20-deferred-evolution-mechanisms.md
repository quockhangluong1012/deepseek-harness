# Agent Note: Staged candidate store, capture contract, skill ranking, and behavior evaluation

Status: implemented

English | [中文](2026-09-20-deferred-evolution-mechanisms.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §58.1 rows 9–12 deferred four mechanisms for lack of a production signal, and the signal has since arrived: staged skill proposals duplicated on every repeat, a blocked approval vanished the moment it was rejected, skill approval admitted procedure-only evidence, the catalog had no ranking at all, and the scorer had no baseline-vs-candidate comparison and no routing check.

## Decision

Four mechanisms, each owned by the package that already owns its seam:

1. **Candidate store** (`dsh-evolution-memory`). `StagedWrite` carries `mergeKey`, `recurrence` (from 1), `blockedReason`, and `neededEvidence`; `StagedResolution` carries the entry's `mergeKey` and `recurrence`. `stageWrite` accepts an optional `mergeKey`: re-staging the same key in the same scope while an entry is pending bumps its `recurrence` instead of appending a duplicate, so a repeatedly proposed candidate is remembered rather than silently retried. `blockStaged` marks a pending entry with a reason and the missing evidence while keeping it pending; approving or rejecting clears the block by removing the entry. All new durable fields are zod-defaulted, so committed records open unchanged.
2. **Capture contract** (`dsh-evolution-memory/src/capture-contract.ts`). `validateCaptureContract` admits a contract only with a non-empty `capability`, at least one `procedureRef`, at least one `validationRef` disjoint from the procedure refs, and non-empty `validationSummary` and `limitations`; every refusal names the missing evidence. `approveStaged` on a skill entry without a valid contract keeps the entry staged with `blockedReason: 'capture-contract'`, records the issues in `neededEvidence`, and rejects with `evolution/staged-blocked` — the same keep-staged-and-propagate shape a cap rejection already uses. `supplyStagedContract` attaches a fully valid contract to a pending skill proposal and lifts the block; the entry still needs an explicit approval. The reviewer stages skill proposals with `skillProposalMergeKey` (same normalization as `skillCreationEvidence`, order-independent), so repeats bump recurrence while admission evidence is still missing. `/skills approve` and `/journey` surface the block and its evidence.
3. **Skill ranking** (`dsh-skill/src/rank.ts`). `rankSkills` is a BM25 rough rank over name, description, and `whenToUse` (Robertson `k1`/`b` defaults, unicode tokens), re-ranked by embedding cosine similarity when the caller supplies vectors and by downstream utility when it supplies `SkillRankSignal`s — a structural shape mapped from telemetry, so no package dependency follows the signal. The ranker is pure and synchronous with no model calls; its one production consumer is the behavior routing gate, which is exactly the offline selector it was built for. There is no rank cache to go stale: ranks compute per call over caller-supplied revision keys, and the registry's revision-keyed collection cache already invalidates on skill evolution. The per-turn catalog keeps its static order until a measured retrieval miss justifies wiring ranking into the model-visible path.
4. **Behavior evaluation** (`dsh-evolution-scorer/src/behavior.ts`, `EvolutionScorer.evaluateBehavior`). Three gates, cheapest first: `checkBehaviorContract` refuses bodies that break the skill frontmatter (the exact invariant `skill_manage edit` enforces, one implementation); `checkBehaviorRouting` runs positive and negative trigger queries through the real selector, requiring positives inside `routingTopK` and negatives outside, over a catalog carrying each entry's revision key; `compareBehaviorReplay` approves only when the candidate regresses nothing the baseline passed, where parity on a scenario both fail is not a regression. A failed cheap gate returns `status: 'gated'` before any fresh process boots; a skipped replay composition returns `status: 'skipped'`; otherwise `approved` is true only when every gate passed — only replay evidence approves.

## Alternatives considered

- A separate candidate table beside staged writes — rejected: proposals already live in staged writes, and a second table would need cross-table atomicity the domain does not offer; the merge key, recurrence, and block fields ride the entry itself.
- Requiring the contract at stage time — rejected: the reviewer cannot fabricate independent validation evidence, so the gate sits at approval with a block-and-supply loop instead, and the missing evidence tells the approver exactly what to attach.
- Embedding re-rank as the only second stage — rejected: there is no query-time embedding budget at pre-step, so utility evidence re-ranks by default and vectors stay an optional passthrough the offline gate can supply.
- A memoizing ranker class with `invalidate()` — rejected: no production caller exists to drive invalidation, so ranking stays pure and revision keys in the caller's hands are the invalidation rule.
- Routing gate in the curator — rejected: the curator owns no corpus and no triple comparison; the scorer owns both, plus the `SCORER_VERSION` stamping that keeps incomparable rows apart.
- Package-root imports for the new cross-package uses — rejected for `behavior.ts`: under vitest the package root did not serve the new export even after a full host build, while deep `src/` imports resolve immediately (curator precedent); the root re-exports stay as the public API for built hosts.

## Consequences

- A repeatedly proposed skill is one pending entry with a growing `recurrence`, not N duplicates; a blocked proposal names its missing evidence instead of disappearing on reject.
- No skill proposal approves on procedure-only evidence: overlapping or missing validation refs block with the exact issue list, and `/skills approve` reports it verbatim.
- The catalog has a real selector for offline use without changing any model-visible ordering; the routing gate proves a candidate wins its own triggers without hijacking unrelated ones.
- Promotion-grade evidence exists below the optimizer: contract plus routing plus a no-regression replay, with cheap gates stopping expensive replays early and skipped compositions refusing to select on missing evidence.
- `gen-cordis-catalog` classifies the two new service-level types (`BehaviorEvalRequest`, `BehaviorEvaluation`) under the scorer README; the api-catalog mirror records the new staged-write surface.

## Deviations from the plan

- Spec row 11 says BM25-to-embedding re-rank; shipped BM25-to-utility with embedding as an optional caller-supplied stage, because no embedding provider is mounted at query time and the deferred row's own condition (a measured retrieval miss past ~10 skills) has not been met either.
- No separate `EvolutionCandidate` table: the staged write is the candidate, keyed by `mergeKey` while pending, which is also why `blockStaged`/`supplyStagedContract` exist — the spec named the fields but no operation to set them.
- `supplyStagedContract` clears the block on a valid supply; the spec's sketch had no unblock path because blocked entries were never staged anywhere durable before this change.

## Testing

- `evolution-memory`: candidate dedupe/recurrence/scopes, legacy-shape defaults, block/supply/approve-gate paths including scalar/null/list payloads and overlapping refs; new `capture-contract.spec.ts` for every validator refusal plus the JSON materialization.
- `evolution-skill-telemetry`: merge-key order-independence, shared normalization with the evidence counter, empty-list refusal.
- `evolution-reviewer`: staged proposals carry a merge key; a second firing bumps recurrence without duplicating.
- `command-evolution`: `/skills approve` admits a contracted proposal, reports a blocked one with its evidence, and the journey projects blocked pending rows.
- `dsh-skill/rank`: ordering, kebab/unicode matching, empty-query fallback, trust/failure demotion, vector preference and every no-support shape, deterministic full ties.
- `evolution-scorer/behavior`: contract/routing/replay unit gates including both topK refusals, plus service runs proving the early stop (no process boots), both skip paths, approval, and a named regression.
- 100% statements/branches/functions/lines on every touched `src/` file in the affected-package coverage run; `typecheck`, `constraints`, `verify-cordis-config`, both catalog generators, and translation pairing records pass. Full-repo `lint` and `verify-translation-pairing` stay red on pre-existing entries only (verified by diff, none from this change).

## Left alone

- The per-turn catalog keeps static precedence order; wiring `rankSkills` into the model-visible path needs a measured retrieval miss plus snapshot coverage, and is recorded as a limitation in the skill README.
- Trust still only gates visibility nowhere: it feeds the utility signal, never a load decision.
- `skills approve` has no contract-editing flow yet; `supplyStagedContract` is store-level until a command wires it.
- `packages/skill/skill/tests/skill.spec.ts` scoped-layer cases fail when that file runs standalone; verified identical on the pristine tree (unrelated to this change).
