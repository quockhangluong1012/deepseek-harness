# Interim A — evolution-memory store (loci L1, L4)

## Findings (from investigator A, verified by orchestrator spot-reads)

- Store `ctx.evolutionMemory` owns durable per-scope record on domain `evolution_memory` v1 per-record; reads sync + detached; caps checked pre-write; rejected writes never mutate (index.ts:2-12, 551-555).
- Record: instructions / agentLessons / userProfile + 3 family stamps + derived memoryUpdatedAt + contextItems (uuid, sizeBytes snapshot) + outputs (newest-first, {path,tool,sessionId,at}) + lastExtraction ({at,sessionId,provider,model,origin,inputBytes,truncated}) + staged (oldest-first) + resolutions (newest-first, cap maxResolutions) + updatedAt (types.ts:134-166, spec.ts:86-100, spec:57-76).
- Verbs: read/usage/digest (empty when absent); setInstructions (capacity only); setLessons/setUserProfile (+extraction, family stamps); addLesson (dup no-write); replace/removeLesson (unique-substring else item-not-found/ambiguous-match); add/removeContextItem; stageWrite (validates JSON, no capacity touch); approveStaged (memory ops applied, skill kind only dropped); rejectStaged; recordOutputs (empty→noop, unchanged→no-write/no-churn, absent→seed+put).
- 3 memory write paths: (a) direct controller/commands, (b) background extraction origin background_review (or staged setLessons when writeApproval), (c) rebuild origin rebuild always-direct.
- recordOutputs fires ONLY from reviewer indexOutputs with full filter chain; mergeOutputs newest-first cap maxOutputs 200, idempotent.
- Digest sha1(instructions, lessons, profile, contextItems); capacity = those + Σ sizeBytes; outputs/staged/resolutions excluded.

## Committed position

**Memory trigger và evolution-save trigger là hai cơ chế khác nhau chung một điểm hẹn turn/end.** Ghi memory (lessons/profile) luôn gated; lưu output (recordOutputs) luôn chạy. Mọi nhầm lẫn "mỗi turn đều ghi memory" đều sai — mỗi turn chỉ *index outputs*, memory chỉ đổi khi extraction vượt gate hoặc con người approve/rebuild. (Serves L1; reconciles with B/C in comparisons.md.)
