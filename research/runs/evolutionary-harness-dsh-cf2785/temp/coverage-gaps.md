# Coverage gaps — evolutionary-harness-dsh-cf2785 (Step 2.5)

Vault notes tagged: 0 (corpus is repo-internal by design; substantive sources = files read below).
Escalation queue: 0 queued.

## Per-atomic-item coverage

| Atomic item | Status | Source count | Sources |
|---|---|---|---|
| Sub-Q1 overall mechanism | Well-covered (5+) | 6 | spec (325 lines), subsystem ref, evolution README, web-app cordis.patch.yml rows, package inventory table, Hermes prior-art cite |
| Entity command-evolution | Well-covered | 5 | src/index.ts (918 lines), journey.ts (252), types.ts, README, tests |
| Entity evolution-controller | Well-covered | 5 | src/index.ts, types.ts, README, tests/controller.host.spec.ts, web-app rows |
| Entity evolution-curator | Well-covered | 5 | src/index.ts (822), consolidate.ts, safety.ts, README, spec §Curator |
| Entity evolution-memory | Well-covered | 7 | src/index.ts (874), types.ts, spec.ts, digest.ts (70), README, tests/store.spec.ts, investigator A |
| Entity evolution-reviewer | Well-covered | 6 | src/index.ts (1028), prompt.ts, squeeze.ts, README, spec §How Memory is written, investigator B |
| Entity evolution-scorer | Adequate | 3 | src/index.ts, README, spec row (runner/scenario/score/sessions pending investigator D) |
| Entity evolution-trajectory | Adequate | 4 | src/index.ts (223), sharegpt.ts, README, spec row |
| Sub-Q2 flows | Well-covered | 5 | memory-context index.ts (382), render.ts, sections.ts, reviewer observeTurn, web-app rows |
| Sub-Q3 memory trigger | Well-covered | 6 | reviewer gating chain, store setLessons/setUserProfile, controller verbs, /refine→rebuild, spec §How Memory is written |
| Sub-Q4 evolution save trigger | Well-covered | 5 | reviewer indexOutputs→recordOutputs, producedEntry filter, mergeOutputs/maxOutputs/idempotent, stageWrite/approveStaged, /memory pending/approve |
| Sub-Q5 timeline | Well-covered | 5 | journey.ts scopeTimeline/recordDeltas/renderTimeline, types.ts, controller timeline+follow, /journey + /journey export |
| Sub-Q6 related | Adequate | 4 | skill-telemetry README, skill-manage, curator adopt/pin, memory-context nudges (spill/goal/compaction comparison pending D) |
| Adversarial (limits) | Adequate | 3 | spec Limits + Product choices, byte-identical disable, never-claims (outputs/staged off-model, extraction-needs-route) |

## Genuine gaps (flagged for Wave 2 / Step 13)

1. Investigator D pending: scorer runner/scenario/score/sessions detail, trajectory sharegpt shaping rules, memory-context sections.ts nudge text, skill-manage tool surface, spill/goal/compaction contrast. → Await D; if still thin, targeted reads before drafting.
2. External Hermes Agent prior art (spec line 11 cites hermes-agent.nousresearch.com): one web fetch for context if time permits; not load-bearing.
3. No vault web notes → `claims ingest / sources score / graph rank` will no-op; run once for hygiene after any fetches.

## Retractions

None (no DOI-bearing web sources in corpus).
