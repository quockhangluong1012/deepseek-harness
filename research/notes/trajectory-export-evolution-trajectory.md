---
title: Trajectory export (evolution-trajectory)
id: trajectory-export-evolution-trajectory
tags:
- evolutionary-harness-dsh-cf2785
created: '2026-09-13T01:52:26.892805Z'
updated: '2026-09-13T02:05:34.588374Z'
source: packages/evolution/evolution-trajectory/README.md
status: review
type: note
deprecated: false
summary: ShareGPT export of finished sessions under DSH_HOME, empty array not failure
---

# Trajectory export (evolution-trajectory)

Primary source: `packages/evolution/evolution-trajectory/README.md` + `packages/evolution/evolution-trajectory/src/index.ts` (`ctx.evolutionTrajectory`, service-only).

"`dsh-evolution-trajectory` writes finished Sessions as ShareGPT conversation files for evals and reinforcement-learning data."

One session export writes one file with one conversation per turn; scope export writes one file per non-archived session and reports totals. Conversations keep the session log's own text and roles; injected context, reasoning, and attachments stay out. A session with no admitted message exports an empty array instead of failing. Exports land under `$DSH_HOME/evolution-trajectories` unless configured otherwise, never inside the project. Governed via `/trajectory [--out <path>] [--all]` in `dsh-command-evolution`.
