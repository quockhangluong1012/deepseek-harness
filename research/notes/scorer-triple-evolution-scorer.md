---
title: Scorer triple (evolution-scorer)
id: scorer-triple-evolution-scorer
tags:
- evolutionary-harness-dsh-cf2785
created: '2026-09-13T01:52:57.398467Z'
updated: '2026-09-13T02:05:22.744370Z'
source: packages/evolution/evolution-scorer/src/index.ts
status: review
type: note
deprecated: false
summary: 'Manual corpus scoring: workspace-diff pass, metered tokens, median wall
  time'
---

# Scorer triple (evolution-scorer)

Primary source: `packages/evolution/evolution-scorer/src/index.ts` + README (measured improvement scoring over a recorded corpus).

Manual baseline runs only, never per-turn. Config requires `corpusDir` (absolute root, one directory per recorded scenario); `attempts` defaults to 3 so one cold start cannot move the median. Every attempt runs the keyless recorded-session replay tier; nothing records.

`loadScenarioPlan` reads `input.json`, the top session fixture plus children, sidecar `replay.override.json`, and `workspace/` vs `workspace.expected/`; missing corpus/scenario/fixture/input reports `skipped`. Metric triple: pass from the workspace diff (all attempt finals must match expected), billed tokens from the host token meter (nested sessions included), median-of-N wall time. The shipped runner is the snapshot harness ACP tier; replay-tier and ACP-runner only; no Pareto/GEPA fan-out yet.
