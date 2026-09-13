---
title: Controller Remote face (evolution-controller)
id: controller-remote-face-evolution-controller
tags:
- evolutionary-harness-dsh-cf2785
created: '2026-09-13T01:52:24.368929Z'
updated: '2026-09-13T02:05:32.847785Z'
source: packages/evolution/evolution-controller/README.md
status: review
type: note
deprecated: false
summary: Evolution Remote verbs, scope-first resolution, follow stream, no durable
  state
---

# Controller Remote face (evolution-controller)

Primary source: `packages/evolution/evolution-controller/README.md` + `packages/evolution/evolution-controller/src/index.ts` (host half of the evolution web surface; `evolution` Remote namespace).

"**The read model lives once.** `scopeTimeline` is imported from `dsh-command-evolution`, so `/journey` text and the timeline verb can never disagree about a bucket."

Verbs: `read/setInstructions/setLessons/setProfile/addContextItem/removeContextItem/rebuildMemory/listStaged/approveStaged/rejectStaged/timeline/follow`. Every scoped verb resolves the workspace first (`workspace/not-found`); staged decisions are scope-checked (`evolution/staged-not-found`); rebuild without a mounted reviewer answers `evolution/extraction-failed`. `follow` publishes one baseline over every registered scope, then one upsert per durable record change (scope-filtered `domain/changed` on `evolution_memory.records`). The package owns no durable state. Model-visible briefs render from the same record via `dsh-evolution-memory-context`.
