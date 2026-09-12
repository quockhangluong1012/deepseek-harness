# Wire skillCreationEvidence in evolution reviewer

**Date:** 2026-09-12
**Packages:** evolution-reviewer, evolution-skill-telemetry

## What changed

After `recordOutputs` succeeds in `indexOutputs`, the reviewer now reads back
the scope record and calls `skillCreationEvidence` on the output paths. When
≥3 paths normalize to the same key (case-folded, slash-normalized), a skill
proposal is staged via `evolutionMemory.stageWrite(kind: 'skill')`.

## Files

- `packages/evolution/evolution-reviewer/src/index.ts` — import + wiring in `indexOutputs`
- `packages/evolution/evolution-reviewer/package.json` — added `@deepseek-ai/dsh-evolution-skill-telemetry` dependency
- `packages/evolution/evolution-reviewer/tsconfig.json` — project reference to `../../skill/evolution-skill-telemetry`
- `packages/evolution/evolution-reviewer/tests/reviewer.spec.ts` — test with read spy seeding 3 identical output paths

## Notes

- `mergeOutputs` deduplicates identical paths, so a real trigger requires
  different exact paths that normalize to the same key (e.g. case differences
  on case-sensitive filesystems). The test uses a `read` spy to seed outputs.
- Errors during `stageWrite` are caught and logged as warnings; they never
  propagate out of `indexOutputs`.