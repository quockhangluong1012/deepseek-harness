# Agent Note: Immutable trace bus with ranked credit assignment

Status: implemented

English | [中文](2026-09-21-immutable-trace-bus.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §51 ranks "Immutable trace + event bus" as P0 #1: the architectural center the rest of the learning loop reads (§50). The harness had the raw form already — the session log is a lossless, append-only event stream — and `evolution-trajectory` shaped that log into ShareGPT for evals, but nothing derived the machine-readable learning trace with step-level credit assignment (§3.2) or the compressed form (§3.3), so the evolution loop had no structured evidence tied to decision points.

## Decision

One new package, `dsh-evolution-trace`, projecting the committed session log into the structured learning trace on demand. Three design commitments:

1. **The log stays the raw trace; the package derives, never duplicates.** `project` is pure: it consumes committed `SessionEvent`s in sequence order and builds a `TraceRecord` — turns with request gist, outcome, latency, and steps; steps with tool calls (paired call→result), retry evidence from `assistant/attempt`, the interruption flag, and token `usage`; per-turn failures. Reads flush a live session first. No storage domain, no writes, no model calls: restart derives the same record from the same log, and there is exactly one authoritative source.
2. **Credit assignment is a deterministic proximity heuristic, explicitly not a verdict.** For a failed tool call the ranked causes are: the failing call itself; the same-step calls before it (its input producers); the previous step's calls (the context producer); retrieval calls whose names carry `skill` or `memory` (may have missed); then the turn's request. The schema is stable so a future analyst can replace the ranking with measured attribution without changing consumers.
3. **The compressed form is decision-ordered.** `summarize` reduces one record to a learning-trace row (counts, summed tokens/latency, distinct failure gists in first-occurrence order); `summary(sessionIds, limit)` sorts most failures → retries → tokens → newest, so the sessions with the most to learn from survive the limit.

One consumer lands with the package: `/trace <sessionId>` in `command-evolution` renders a session's structured trace with its failure causes for operators, and the package is mounted in the web-app profile (it writes nothing and reaches no model prompt, like the trajectory exporter).

## Alternatives considered

- Write a new domain holding per-session trace snapshots — rejected: the session log already is the immutable raw trace; a second durable copy would drift and double storage (`derive caches and query views from one authoritative source`).
- Observe `session/event` live and buffer per-session steps, projecting incrementally — rejected: buffering duplicates state the log already holds, and projection-on-read is always consistent with the committed log.
- Store raw tool arguments and full result text in the structured trace — rejected: the learning form needs call identity, outcome, and gist; the log retains arguments and full text for audit.
- Emit a live turn-settled bus event in this change — rejected: an event with no consumer is worse than no event; projection-on-read is the current surface, and turn-settled emission lands with the curriculum and shadow/canary consumers (P1) that actually need it.
- Have an LLM judge attribution — rejected: a model call per failure is the wrong default for a substrate every session passes through; the deterministic ranking is honest, and the reflection path already exists for analyst-supplied root causes.

## Consequences

- The harness's architectural center exists: any consumer can project any session into structured evidence or compress many sessions into decision-ordered rows without new storage.
- Failure causes are available at decision points (§3.2) — retrieval may have missed, an earlier call produced the failing input, the request was under-specified — so mutations can target a component instead of the whole system.
- Nothing changes model-visible behavior: the package registers no prompt, tool, or session event, and adds no model call.
- `command-evolution` gains one command; the web-app profile gains one read-only provider row.

## Deviations from the plan

- No live event bus in the first slice. The plan's "trace bus" is realized as projection-on-read plus the `/trace` command; live turn-settled emission is deferred to the learning-system consumers (P1) so no event ships without a subscriber.
- `command-evolution` resolves the trace store through `ctx.get` with a structural type instead of importing the service type, matching the trajectory command's pattern in that package.

## Fixes found on the way

None beyond routine: `toTraceTurn`'s unused `maxChars` parameter was dropped, and a dead guard in the step-time bump helper was removed once every call site guaranteed a defined step (the false branch was unreachable and would have failed the per-file 100% gate).

## Testing

Projection: empty logs, complete turns (request gist with whitespace collapse and non-text blocks, usage, latency, reason), ranked causes across all five ranks and the no-context fallback, retries, interruption, unpaired calls/results dropped, re-opened turns and steps tolerated, foreign events ignored, clipping with code/tool-name fallbacks, summed usage keeping optional counters only when reported, newest-event timestamps. Compression: empty-trace no-row, counts/tokens/latency/gist dedup, open-turn latency. Service: absent-session undefined, non-absence persistence failures rethrown, live-session flush, decisive-first summary with limit and tie-breaks, config defaults. `/trace` command: usage, unmounted, absent session, rendering, service failure, registration and disposal. 26 trace tests and 100% statements/branches/functions/lines on the package; 133 command-evolution tests pass.

## Left alone

The trace package has no live bus subscribers yet (documented in its Known Limitations). P1 work — automatic curriculum and shadow/canary — is the intended first consumer of `summary` ordering and turn-settled emission. `command-evolution`'s pre-existing lint debt outside the touched surface (max-len and non-null assertions in earlier curator verbs, repo-wide) is unchanged.