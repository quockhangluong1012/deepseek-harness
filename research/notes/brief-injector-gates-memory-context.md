---
title: Brief injector gates (memory-context)
id: brief-injector-gates-memory-context
tags:
- evolutionary-harness-dsh-cf2785
created: '2026-09-13T01:53:00.902794Z'
updated: '2026-09-13T02:05:39.622974Z'
source: packages/context/evolution-memory-context/src/index.ts
status: review
type: note
deprecated: false
summary: Digest triple-gate pre-step injection, maxBytes drop order, frame safety
---

# Brief injector gates (evolution-memory-context)

Primary source: `packages/context/evolution-memory-context/src/index.ts` + `src/render.ts` (pre-step brief injection + budget rendering).

At each eligible `agent/pre-step`, the injector compares the record digest against the newest visible `user/message` with an `evolution-memory` source and appends exactly one complete fresh brief when they differ (triple gate: in-memory mark, claimed batch, logged surface via `sessionQuery.readSurface`). Membership comes from registry `sessionIds` with canonical-cwd fallback, cached per session, cleared on `session/disposed`. Outside any workspace/scope, or when all four families are empty, nothing is injected (zero tokens).

Budget `maxBytes` covers the complete text including the frame: trailing context drops first, then lessons truncate, then profile, instructions last, with one notice line naming every drop/truncation and UTF-8-safe clipping. Literal `</system-reminder>` in scope text is rewritten to `<\/system-reminder>`. Unreadable files degrade to one unavailable line; the step always proceeds. Recalled `Recall:` items render last so the budget drops them first.
