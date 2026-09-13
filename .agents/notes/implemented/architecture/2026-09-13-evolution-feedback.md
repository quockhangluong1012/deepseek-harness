# Agent Note: Failure feedback is recorded per session, not inferred per turn

Status: implemented

English | [中文](2026-09-13-evolution-feedback.zh.md)

## Problem

The learning loop had no durable evidence of what actually broke. Lessons come from what the conversation said, skill telemetry counts how often a skill was loaded and patched, and the scorer produces a pass/fail number for a recorded corpus — but nothing recorded that a tool call failed, what it said, or whether the same fault keeps recurring.

That gap blocks the reflective half of the loop. A GEPA-style optimizer needs the pair a textual optimizer reads: a measured score and natural-language feedback about why the attempt fell short. The harness had the score and the trace; the feedback did not exist anywhere. It also made the failures themselves unreadable: a fault that happened forty times across four sessions left no trace beyond the session logs.

## Decision

`@deepseek-ai/dsh-evolution-feedback` provides `ctx.evolutionFeedback`, a durable per-session record of failing tool results.

The plugin observes `session/event` as delivered. A `tool/call` is remembered by call id; a `tool/result` marked as an error is recorded with its resolved tool name and its visible text, falling back to the failure code when the result carries no text. A successful result records nothing. The pending table is cleared at `turn/end`, so a result that arrives after its turn records a null tool rather than a stale name.

An observation is keyed by tool and message. A repeat increments `count`, moves the entry to the front, and drops the earlier copy, so a session that hits one fault forty times holds one entry carrying forty. A message is whitespace-normalized and clipped to `maxMessageChars` before it becomes the key, and a session retains at most `maxEntries` observations newest-first.

`summary(sessionIds, limit)` merges the requested sessions by tool and message. It sums each failure's observation count, keeps the earliest first sighting and the newest repeat, and counts the distinct sessions that reported it — so a fault seen once in each of four sessions outranks one repeated four times in a single session, which is the ranking a fix should follow. Entries order by count, then by recency.

Nothing here calls a model. The failing result's own text is the feedback; extracting it costs nothing and is deterministic.

## Alternatives considered

**Fold failure observation into the reviewer's turn buffer.** The reviewer already sees the same turn stream, buffers it, and flushes at `turn/end`, so the cheapest change was to record failures in the buffer it already keeps. It loses on two counts: the reviewer's unit is the whole turn and its extraction is gated (cooldown, text floor, `enabled`), so failures would be silently dropped whenever extraction was off — which is exactly when a deployment wants the evidence. And its buffer exists to feed one model call, not to be read by other consumers.

**Have a model parse errors into prose feedback.** A reflective optimizer reads natural language, so the failure could be summarized by a model. That trades a deterministic transcription for a nondeterministic and billable one: the tool result already carries the text a model would paraphrase, and paraphrasing it loses the exact message the next fix must match.

**Key by scope instead of by session.** Every other evolution store is keyed by `profile:workspaceId`, so feedback could have followed that shape and joined the brief's scope record. It would have bought cross-session merging for free, at the cost of resolving scope membership per event and answering how feedback behaves for a session outside any workspace. Keying by session keeps the write path a function of the event alone; callers aggregate the sessions they care about when they read.

**Record into skill telemetry.** The telemetry store already keeps per-skill counters, so failures could have become another counter. Telemetry deliberately counts usage — uses, views, patches, lifecycle state — and its records are per skill, not per occurrence. A count of failures with no message cannot tell an optimizer what to change.

## Consequences

The loop can now be told what keeps failing, deterministically and without a model call, and the answer ranks by how widely a fault spreads rather than how loudly one session repeats it.

Writing this exposed a real concurrency defect before it shipped. Tool results of one step arrive together, so the naive read-then-write raced with itself: two results recorded in the same tick each read an absent record, each wrote a fresh one, and the later write dropped the earlier observation. The store now gives each session one write chain, so an observation's read-then-write decision never overlaps another, and each chain drops its map entry once it settles as the tail. Two specs — the per-session cap and the cross-session aggregation — failed on the racing implementation and pass on the chained one.

The trade-offs are recorded in the package README: only tool failures are observed; the domain keeps one record per session that is never pruned; observation is not retroactive, so sessions that failed before the mount are invisible; a clipped message means two different long failures can collide on one entry; and a null tool is a real state, not an error.

`summary` has no in-repo caller until the optimizer pass that consumes it lands.
