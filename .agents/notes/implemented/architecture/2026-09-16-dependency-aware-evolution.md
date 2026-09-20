# Agent Note: Dependency-aware evolution

Status: implemented

English | [中文](2026-09-16-dependency-aware-evolution.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §34 states that artifacts have dependencies — prompt, skill, retriever config, evaluator — and that every evaluation result must record dependency versions, because changing the evaluator can invalidate historical metrics and changing retrieval can make old usage metrics incomparable. The experiment ledger recorded the skill side (body digest), the route (provider and model), and the conditions (scenarios, samples), but nothing named the evaluator: `comparabilityKey` matched on scenarios plus route plus attempt count, and `experimentKey` matched on skill plus evidence plus lineup plus body plus route. A scoring-semantics change would have kept matching old rows as if they were measured under the new evaluator — approving floors that mean something else and skipping experiments whose outcomes no longer hold.

## Decision

**One version constant plus one ledger field, no migration, no knob.**

- **`SCORER_VERSION` is a protocol constant** (`evolution-scorer/src/index.ts`), not configuration: scoring semantics are a property of the code, not a deployment choice, so there is nothing to tune. `EvolutionScorer.version` carries it as an instance field so the optimizer reads the mounted scorer's version per run — a host that mounts a different scorer stamps its own number instead of inheriting this package's. The README names the bump duty: any change to what counts as pass, what counts as billed, or how the median reduces.
- **The ledger stamps and matches on it.** `ExperimentRecord` and `ExperimentDraft` carry `scorerVersion`; the run records the mounted scorer's version, `experimentKey` includes it (an old outcome never skips a re-measurement), and `comparabilityKey` includes it (an old approved floor never refuses a new winner). A scorer change retires every floor it measured without deleting anything: old rows stay readable, just incomparable.
- **No migration, following the novelty batch's precedent.** New required fields on the zod schema fail old rows loudly at domain open — the domain's own documented contract — rather than silently reinterpreting measurements from an unknown evaluator. The same precedent covers the absent domain-version bump: this repo versions the schema, not the data, and the loud failure is the migration signal.

## Alternatives considered

- **Stamping every `ScoreOutcome` instead of the ledger row.** Rejected: triples are only compared across runs through the ledger (floors, repeat-matches); within one run everything is measured under one scorer. Stamping each score would have rippled through scorer types and every caller for a comparison that never happens.
- **A nullable version with null meaning "recorded before versions".** Rejected: null would need its own incomparability rule (null matches nothing, not even null — otherwise two pre-version rows compare), which is a second mechanism for what a required field plus loud failure already expresses.
- **Bumping the domain `version` to 2.** Rejected: the novelty batch added three required fields at version 1 without a bump, and the domain comment documents loud failure as the intended behavior for invalid rows. A bump would have implied a migration path that does not exist.

## Consequences

The §34 loop closes for the dependency this harness actually has: the evaluator. Skill identity was already a digest, route and conditions were already matched — the scorer version was the missing leg, and both guards now key on it. Tests prove the invalidation both ways (repeat-match and floor), at unit and orchestration level. What §34 asks beyond this — retriever-config versions, prompt lineage — has no retriever or prompt-version surface in this repo to stamp; when one exists, it joins the same two keys.

## Verification

- 127 tests pass across `evolution-optimizer` and `evolution-scorer`; per-file 100% statements, branches, functions, and lines on both packages' `src`.
- `tsc -b` on both packages clean; oxlint 0 warnings, 0 errors on both.
- New: unit key-mismatch across versions, orchestration re-run after a version bump (LLM paid again, new row stamped v2), orchestration floor ignored after a version bump (6-token winner stages under a retired 4-token floor).
