---
title: Journey read model (command-evolution)
id: journey-read-model-command-evolution
tags:
- evolutionary-harness-dsh-cf2785
created: '2026-09-13T01:52:21.880308Z'
updated: '2026-09-13T02:05:11.782090Z'
source: packages/evolution/command-evolution/src/journey.ts
status: review
type: note
deprecated: false
summary: 'Pure timeline read model: stamps to UTC+7 buckets, resolutions from ledger'
---

# Journey read model (command-evolution journey.ts)

Primary source: `packages/evolution/command-evolution/src/journey.ts` (pure read model behind `/journey`; reused unchanged by the Remote controller).

"Read model and rendering behind `/journey`: one scope's recorded evolution activity, bucketed on the dashboard calendar (UTC+7)… The model is pure — the command supplies the record it already read, so this module touches neither storage nor the session log, and the Remote controller reuses it unchanged."

Mechanics: `TimelineInput{record,usedBytes,capacityBytes,digest,range,now}`; deltas only for facts the record proves (per-family stamps, context `addedAt`, output `at`, staged `createdAt`); decided staged entries counted from the resolution ledger on decision day; buckets by UTC+7 day key; bounded ranges zero-filled, `all` keeps active days only; cumulative usage/digest independent of range; pending mapped from `record.staged`.
