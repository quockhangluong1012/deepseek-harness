---
title: Evolution group map (packages/evolution)
id: evolution-group-map-packagesevolution
tags:
- evolutionary-harness-dsh-cf2785
created: '2026-09-13T01:51:56.709327Z'
updated: '2026-09-13T02:05:30.373550Z'
source: packages/evolution/README.md
status: review
type: note
deprecated: false
summary: Closed learning loop without privileged-core patch; 7-package map with ctx
  keys
---

# Evolution group map (packages/evolution/README.md)

Primary source: `packages/evolution/README.md` (group map for the self-learning harness family).

"The evolution family adds a closed learning loop on top of the harness without patching a privileged core: durable per-scope memory records with staged writes, background turn review, scheduled skill curation, and long-horizon safety rails."

"Every learned write is capped, staged when configured, logged, and rollback-capable; removing the rows restores byte-identical legacy behaviour."

Family members: `evolution-memory` (`ctx.evolutionMemory`), `evolution-reviewer` (`ctx.evolutionReviewer`), `evolution-curator` (`ctx.evolutionCurator`), `evolution-controller` (`ctx.evolutionController`), `evolution-trajectory` (`ctx.evolutionTrajectory`), `evolution-scorer` (`ctx.evolutionScorer`), `command-evolution` (registers on `ctx.commands`).

"Scores a recorded corpus run: workspace-diff pass, metered tokens, and median-of-N wall time"

Behaviour contract: `specs/evolutionary-harness.spec.md`.
