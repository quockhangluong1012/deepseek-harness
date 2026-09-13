---
title: How memory is written (spec + reviewer)
id: how-memory-is-written-spec-reviewer
tags:
- evolutionary-harness-dsh-cf2785
created: '2026-09-13T01:52:19.607354Z'
updated: '2026-09-13T02:05:13.561820Z'
source: packages/evolution/evolution-reviewer/src/index.ts
status: review
type: note
deprecated: false
summary: Turn/end rendezvous, admission predicate, deterministic extraction call,
  defer modes
---

# How memory is written (spec: reviewer + extraction)

Primary source: `specs/evolutionary-harness.spec.md` ("How Memory is written") and `packages/evolution/evolution-reviewer/src/index.ts`.

"`ctx.on('session/event', …)` filtered to `turn/end`. Resolve scope, return when none. One backward scan to most recent `turn/start` feeds output indexing (always) and extraction (when gated)."

"Skipped when `review.enabled` false, cooldown unelapsed, or admitted text under `minTurnTextBytes`."

Transcript admits only human `user/message` and `assistant/message`; injected context (brief itself, instructions, time, references) never feeds back. Deterministic call: `temperature: 0`, reasoning disabled via `purpose: 'evolution-review'`, `maxTokens: maxOutputTokens`, `deadline(signal, timeoutMs)`. Route precedence: configured `provider`+`model`, else session header route; neither means skip with warning (turn) or `evolution/extraction-failed` (rebuild).

Defer `auto` queues a gated turn per session with first-snapshot `deferMaxAgeMs` deadline; `never` extracts at turn end; explicit `/refine` is always immediate.
