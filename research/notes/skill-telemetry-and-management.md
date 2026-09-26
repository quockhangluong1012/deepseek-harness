---
title: Skill telemetry and management
id: skill-telemetry-and-management
tags:
- evolutionary-harness-dsh-cf2785
created: '2026-09-13T01:52:59.204635Z'
updated: '2026-09-13T02:05:15.232286Z'
source: packages/skill/evolution-skill-telemetry/README.md
status: review
type: note
deprecated: false
summary: Per-skill counters with background-only agent creation records plus six-op skill_manage
  tool
---

# Skill telemetry and management (evolution-skill-telemetry + skill_manage)

Primary source: `packages/skill/evolution-skill-telemetry/README.md` + `packages/skill/evolution-skill-manage/README.md`.

Telemetry owns durable per-skill counters (`useCount/viewCount/patchCount`), a creation record (`createdBy: 'agent'|'foreground'|null`), pin, and lifecycle state in domain `evolution_skill_usage` v1 per-record. Only `origin: 'background_review'` sets `createdBy: 'agent'` via `markAgentCreated()`; foreground creates stay user-directed and are never auto-managed. A passive `tools/post-execute` observer counts successful skill loads after delegating the chain. Bundled and hub skills are excluded from every write. `skillCreationEvidence` counts repeated normalized produced paths (threshold 3) to propose skills without reading file content.

`skill_manage` publishes six ops (`create/patch/edit/write_file/remove_file/delete`) enforced in the executor; `createDir` defaults to `$DSH_HOME/skills`; patch needs a unique substring; pins block deletion but never patches; bundled/hub mutations are refused. Every mutation reports to telemetry when mounted.
