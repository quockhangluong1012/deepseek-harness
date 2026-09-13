---
title: Memory record model (evolution-memory store)
id: memory-record-model-evolution-memory-store
tags:
- evolutionary-harness-dsh-cf2785
created: '2026-09-13T01:52:37.205777Z'
updated: '2026-09-13T02:05:36.217438Z'
source: packages/evolution/evolution-memory/src/types.ts
status: review
type: note
deprecated: false
summary: Per-scope record fields, staged oldest-first, resolutions newest-first, full
  verb semantics
---

# Memory record model (evolution-memory store)

Primary source: `packages/evolution/evolution-memory/src/types.ts` + `src/index.ts` (`ctx.evolutionMemory`, domain `evolution_memory` v1 per-record).

Scope identity is opaque `profile:workspaceId` or `profile:global`; path-safe storage key `<profile>--<workspaceId>` (JSON backend forbids `:`). One document per scope at `$DSH_HOME/storages/evolution_memory/records/<profile>--<workspaceId>.json`.

Record: `instructions` (user-authored), `agentLessons` + `userProfile` (model-maintained, per-family stamps `instructionsUpdatedAt/lessonsUpdatedAt/profileUpdatedAt`, derived `memoryUpdatedAt`), `contextItems` (uuid ids, `sizeBytes` snapshot at add time, newest last), `outputs` (produced-file index `{path,tool,sessionId,at}`, newest first), `lastExtraction` (`{at,sessionId,provider,model,origin,inputBytes,truncated}`, origin `foreground|background_review|user-edit|rebuild`), `staged` (writes awaiting approval, oldest first), `resolutions` (decided entries, newest first, capped by `maxResolutions`), `updatedAt`.

Verbs: `read/usage/digest` (absent reads as undefined/zero/`'empty'`), `setInstructions/setLessons/addLesson/replaceLesson/removeLesson/setUserProfile/addContextItem/removeContextItem` (caps `evolution/too-large`, capacity `evolution/capacity-exceeded`, substring `evolution/item-not-found` / `evolution/ambiguous-match`), `stageWrite/approveStaged/rejectStaged` (`evolution/staged-not-found`; skill-kind approvals only drop), `recordOutputs` (empty/no-change resolves without writing, so idempotent turns cause no `domain/changed` churn).
