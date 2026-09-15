# Agent Note: Wire `skillCreationEvidence` into the evolution reviewer

Status: implemented

English | [中文](2026-09-12-skill-creation-evidence-in-reviewer.zh.md)

## Problem

The reviewer indexed a scope's outputs but never asked whether those outputs were evidence of a skill being created. `skillCreationEvidence` — the repeated-path detector in the skill-telemetry package — was never consulted by `indexOutputs`, so repeated output paths staged no skill proposal in the memory store.

## Decision

After `recordOutputs` succeeds in `indexOutputs`, the reviewer reads back the scope record and calls `skillCreationEvidence` on the output paths. When ≥3 paths normalize to the same key (case-folded, slash-normalized), it stages a skill proposal via `evolutionMemory.stageWrite(kind: 'skill')`.

The wiring is one import, one call site, and the dependency that carries them:

- `packages/evolution/evolution-reviewer/src/index.ts` — import + wiring in `indexOutputs`
- `packages/evolution/evolution-reviewer/package.json` — added `@deepseek-ai/dsh-evolution-skill-telemetry` dependency
- `packages/evolution/evolution-reviewer/tsconfig.json` — project reference to `../../skill/evolution-skill-telemetry`
- `packages/evolution/evolution-reviewer/tests/reviewer.spec.ts` — test with read spy seeding 3 identical output paths

`mergeOutputs` deduplicates identical paths, so a real trigger requires different exact paths that normalize to the same key (e.g. case differences on case-sensitive filesystems). Errors during `stageWrite` are caught and logged as warnings; they never propagate out of `indexOutputs`.

## Alternatives considered

**Triggering on identical output paths.** Not available: `mergeOutputs` deduplicates identical paths before the read-back, so the trigger has to be different exact paths that normalize to the same key — case differences on case-sensitive filesystems — rather than a plain repeat of one path.

**A reviewer-local normalization rule.** Not taken: the key normalization the check needs (case-folded, slash-normalized) already ships as `skillCreationEvidence` in `@deepseek-ai/dsh-evolution-skill-telemetry`, so the reviewer takes that dependency and the project reference instead of a second copy of the rule.

**Letting `stageWrite` failures propagate out of `indexOutputs`.** Rejected: a failed proposal is caught and logged as a warning, so the indexing pass still completes.

## Consequences

Repeated output evidence now reaches the memory store as a staged skill proposal, and the indexing pass gains no new failure mode: `stageWrite` errors are caught and logged as warnings and never propagate out of `indexOutputs`. The costs are the new dependency and project reference, and a trigger that needs different exact paths normalizing to one key — a plain duplicate path is deduplicated by `mergeOutputs` and never fires.

## Testing

`'stages a skill proposal when skillCreationEvidence fires on output paths'` in `reviewer.spec.ts` seeds three identical output paths through a `read` spy and asserts the staged skill proposal.
