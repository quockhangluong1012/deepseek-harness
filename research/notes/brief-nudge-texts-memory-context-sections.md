---
title: Brief nudge texts (memory-context sections)
id: brief-nudge-texts-memory-context-sections
tags:
- evolutionary-harness-dsh-cf2785
created: '2026-09-13T01:52:06.209620Z'
updated: '2026-09-13T02:05:37.811584Z'
source: packages/context/evolution-memory-context/src/sections.ts
status: review
type: note
deprecated: false
summary: Three verbatim system-prompt nudges with visibility gating and turn-0 rule
---

# Brief nudge texts (evolution-memory-context sections.ts)

Primary source: `packages/context/evolution-memory-context/src/sections.ts` (system-prompt nudges; wired by `packages/context/evolution-memory-context/src/index.ts`).

Lessons-to-skills nudge (order 10050, only when `skill_manage` visible):

"When this turn produces durable lessons for future turns, record them with the skill_manage tool so they persist beyond this session."

Scope-narrowing nudge (order 10051, every `memoryNudgeInterval` turns):

"Evolution memory in this conversation covers one directory scope (usage {{evolution_memory_usage}}). Ignore it for work outside its directory; inside it, prefer its instructions over general knowledge."

Session-search hint (order 10052, always rendered):

"To recall earlier work in this scope, search past sessions before asking the user to repeat context."

Turn counting: no observed `turn/start` counts as turn 0, so interval-1 nudges render before the first turn.
