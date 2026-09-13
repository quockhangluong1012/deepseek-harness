---
title: Digest and capacity (evolution-memory)
id: digest-and-capacity-evolution-memory
tags:
- evolutionary-harness-dsh-cf2785
created: '2026-09-13T01:52:40.008012Z'
updated: '2026-09-13T02:05:25.157953Z'
source: packages/evolution/evolution-memory/src/digest.ts
status: review
type: note
deprecated: false
summary: SHA1 digest covers four model families; capacity excludes outputs and staged
---

# Digest and capacity (evolution-memory digest.ts)

Primary source: `packages/evolution/evolution-memory/src/digest.ts` (brief-input identity + capacity accounting).

Digest is the sha1 of `instructions`, `agentLessons`, `userProfile`, and `contextItems` only; absent record digests as `'empty'`. Outputs, staged writes, resolutions, and timestamps never invalidate the injected brief.

Capacity charged against `capacityBytes`: UTF-8 bytes of `instructions` + `agentLessons` + `userProfile` + every context item's `sizeBytes`. Outputs and staged writes are excluded, so a staged backlog never pressures capacity.

Config: `capacityBytes` required; `maxAgentBytes` 65536, `maxUserBytes` 32768, `maxContextItemBytes` 262144, `maxContextItems` 50, `maxOutputs` 200, `maxResolutions` 200.
