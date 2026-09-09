# Agent Note: Harness reliability and tool-call quality fixes

Status: implemented

English | [中文](2026-09-09-harness-reliability-and-tool-quality-fixes.zh.md)

## Problem

The agent loop could leave a provider-invalid transcript when the tool scheduler failed after logging `tool/call` events, reused assistant attempt ids across session resume, and masked the original turn failure when the `turn/end` boundary commit also failed. Request headers churned when `maxTokens` was not restored symmetrically with `reasoningEffort`, DeepSeek usage could emit a negative disjoint input count on inconsistent cache counters, and a 429 carrying context-overflow wording retried instead of recovering. Model-facing tools had small correctness gaps: `terminal send` lost its abort code, `bash` escalation read `.mode` from an undefined policy, background `bash` had a check-then-start race, web fetch leaked transport internals to the model and accepted loopback-like hostnames on the proxied path, `todo_write` accepted unbounded lists, goal integer fields used `number`, and compaction and title sampling was nondeterministic. Subagent failure text was unbounded.

## Decision

`dsh-agent-loop` seeds its attempt counter from durable `assistant/message` and `assistant/attempt` events so `${sessionId}:${attempt}` stays unique across lifecycles and records a synthetic `TOOL_OUTCOME_UNKNOWN` result for every started call without one before rethrowing a scheduler failure. `buildRequest` restores persisted `maxTokens` for the exact route the same way it restores `reasoningEffort`. DeepSeek `mapUsage` clamps inconsistent cache counters to the reported prompt total, and `httpErrorCode` routes context-overflow wording before generic `RATE_LIMIT` so overflow compacts instead of retrying. `terminal send` throws `TOOL_ABORTED` with `HarnessError`, `bash` escalation fails loud on an undefined standing policy, background `bash` kills a just-registered job when an abort lands during registration, web fetch returns a generic model-visible failure while keeping the cause for logs and rejects `localhost` and metadata hostnames, `todo_write` bounds lists to 100 items and 2000 chars per content, goal `revision` and `max_goal_rounds` use `integer`, compaction and title set `temperature: 0`, and subagent partial output in failures is capped at 8000 chars with a truncation notice.

## Alternatives considered

**Leave scheduler orphans to crash-recovery repair.** Rejected because a live turn-error path closed the turn with orphan `tool/call` events and no `tool/result`, leaving a provider-invalid transcript for the next step without a crash.

**Fail the session invariant on `step/end` with pending calls.** Rejected because the log contract allows unresolved calls at step end and repair synthesizes `TOOL_NOT_STARTED` and `TOOL_OUTCOME_UNKNOWN` closers; the live scheduler fix reduces orphans without changing the durable contract.

**Block workspace-inside-temp on Windows ACL.** Rejected because a temp parent above the workspace yields a sibling temp child, not a capability inheritance; the existing one-direction check plus wrapped resolution errors is the correct boundary.

**Fail closed on union-held secrets in settings redaction.** Rejected for now because current schemas reach secrets through modeled containers that the walker already covers in tests; a blanket throw breaks redaction and needs a schema-by-schema audit first.

## Consequences

Resumed sessions keep unique attempt ids, scheduler failures keep a provider-valid transcript, headers churn less across steps, usage telemetry survives inconsistent cache counters, overflow triggers recovery instead of useless retries, abort and escalation errors stay machine-routable, background aborts leave no orphan jobs, web failures hide transport internals while blocking well-known private hostnames, todo and goal inputs stay bounded and typed, compaction and title output is deterministic, and large child failures no longer blow the parent context.
