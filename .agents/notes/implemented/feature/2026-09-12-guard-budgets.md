# Agent Note: Per-Turn Budget Guard — Pre-Step Ceilings Through the Existing Blocked Reason

Status: implemented

English | [中文](2026-09-12-guard-budgets.zh.md)

## Problem

The evolutionary-harness plan promised long-horizon safety: a runaway turn is cut once it exceeds a token, tool-call, wall-clock, or cost budget. No shipped ceiling covered that. `maxSteps` bounds a turn's step count, `maxTokens` bounds one request's output, and neither sees a turn's accumulated request pressure, its completed tool-call count, or its duration. Nothing read `ctx.tokenMeter` to stop a turn. The specification also left the enforcement point open — it named `agent/turn-stopping` plus an early `agent/pre-step` reject — and promised a durable `budget/exceeded` event for the cut.

## Decision

Ship `@deepseek-ai/dsh-budgets` in the `guard/` group as one plugin on two existing extension points. Every ceiling is optional, and an unset ceiling is off, so a plugin mounted with no configuration observes turns and rejects nothing. The web-app bundle mounts it that way; the base, headless, and SDK bundles do not carry the row.

`apply` registers a `session/event` listener that folds per-session turn facts into a `WeakMap<Session, TurnFacts>`: `turn/start` writes `{ turn, startedAt: event.time, toolCalls: 0 }`, `tool/call` increments `toolCalls` when an entry exists, and every other event type is ignored. Facts therefore exist only for turns the plugin observed from their own `turn/start`; a turn already open when the plugin loads has no entry and is never cut. The WeakMap needs no cleanup listener — the entry dies with its session object.

The enforcement point is `agent/pre-step`, not `agent/turn-stopping`. `agent/pre-step` is a waterfall whose `{ kind: 'reject' }` the loop already converts into the turn-end reason `blocked`, and it runs before the step's model request, so a rejection removes that request instead of racing it. `agent/turn-stopping` is a stop event with no veto slot: the only action available there is `agent.steer(...)`, which keeps a turn open. The package therefore registers nothing on it. This is the deviation from `specs/improvement.spec.md` Phase 1, which lists both points.

Ceilings are evaluated cheapest first — `maxToolCalls` against the counted `tool/call` events; `maxWallMs`, `maxSessionWallTime`, and `maxRunWallTime` against their own origins, the turn's `turn/start`, the session header's creation time, and the run marker; the turn, session, and run token and cost axes against the token meter's `tokenUsage` session projection differenced at each scope's origin; and `maxContextTokens` against `ctx.tokenMeter.measure(agent.session).totalTokens` — so a step already over a cheaper ceiling never pays for a log replay. A reached ceiling appends one durable `budget/exceeded` event carrying the budget's scope, the ceiling name, the observed value, the limit, every ceiling as the deployment configured it, and the turn and step it stopped plus the run identity of a run-scope cut, logs exactly one host warning naming the same facts, then returns `{ kind: 'reject' }` without calling `next()`, the Cordis waterfall short-circuit. No `TurnEndReason` is added and no steering is issued. The event is an ordinary `SessionEventMap` member in `src/types.ts`: per the [session-log version mechanism](../../implemented/architecture/2026-08-10-session-log-version-mechanism.md) an ordinary event addition does not bump `SESSION_FORMAT_VERSION`, so it ships at the released version with no migration and no SDK projection change, exactly as `llm/fallback` does. It stays required on read — the guard writes no `ignorable` marker because `Session.append()` cannot set the envelope field — and the `blocked` turn end remains the reconstructed outcome.

Human input outranks every ceiling. The loop removes a step's claimed messages from the inbox before the waterfall runs, so rejecting a step that carries a user message would discard it. When any claimed message has `source.kind === 'user'` the guard delegates without evaluating a single ceiling. That rule is a correctness condition, not an optimization: it is what makes rejection non-destructive, and it also means a ceiling first takes effect from a turn's second step.

`maxCostUsd`, `maxSessionCost`, and `maxRunCost` price billed tokens at the deployment's `usdPerMillionTokens` per million. The harness has no pricing source of its own, so a cost ceiling without a price is a supported state rather than a load failure: it loads, warns once, and reports itself as `unmeasurable` in the cut record, while a price without a cost ceiling stays inert. The turn axes ship the specification's input/output/total split as `maxInputTokens`, `maxOutputTokens`, and `maxTotalTokens`: the total kept its name because deployments already configure it, and all three compare billed buckets from the meter's `tokenUsage` projection rather than the pressure `measure()` reports.

## Alternatives considered

- **Enforcing on `agent/turn-stopping`.** Rejected: the boundary is a stop event, not a waterfall, and has no veto value to return. The only available action keeps the turn open, so the listener would be dead weight that suggests an enforcement that does not exist.
- **Treating the `budget/exceeded` addition as a session-format bump.** Rejected: the [versioning rule](../../implemented/architecture/2026-08-10-session-log-version-mechanism.md) bumps the format only for structural change to headers, event envelopes, core event semantics, or surface reconstruction. An ordinary new member is required on read at the released version without a bump, so no adjacent migration and no SDK projection follow from this event.
- **Reusing the driver's `maxSteps` and `maxTokens` ceilings.** Rejected: they bound different quantities (step count and per-request output) and live in `agent-loop`, which the specification forbids patching for budget behavior.
- **Reading session history for turn facts.** Rejected: `eventAt` and `snapshotEvents` are deprecated for new production calls, and the delivered `session/event` already carries every fact the guard needs.
- **Rejecting a turn's first step when a ceiling is already reached.** Rejected: that step claims the user's message, so the rejection would delete human input. Ceilings take effect from the second step instead.
- **A `DEFAULT_*` constant or test hook for the ceilings.** Rejected: every bound is a validated `Config` field changeable from `cordis.yml`, and an unset field stays off.

## Consequences

A deployment gains a real long-horizon bound without a driver change, a session-format bump, or an SDK change: one row in a composition with the ceilings it wants, a runaway turn ends `blocked` at the next step boundary, and the log itself names the ceiling that cut it and what it observed. What the choice costs is reader compatibility: the new member is required on read, so a harness older than this event refuses a log containing it rather than silently dropping the cut. The guard's token ceiling is an estimate of request pressure rather than a bill, and the cost ceiling is only as current as the deployment's price. The guard also cannot interrupt work already in flight; it stops the next request, so a hung provider call is bounded by other means. Human input bypasses every ceiling by design, which means a user who keeps steering keeps a turn alive past every bound.

## Testing

Eighteen specs drive a real `AgentLoop` against a scripted mock adapter: completion with no ceiling configured, completion when every configured ceiling stays unreached (no event), each of the four ceilings reached with exactly one `budget/exceeded` event naming that ceiling, its observed value, its limit, and the stopped turn and step immediately before the `blocked` turn end, a price with no cost ceiling left inert, the event's read-path admission and its survival through a seeded replay of the log, the human-input rule shown across two turns of one session (the first cut at the token ceiling, the second entering with a user message), a plugin mounted mid-turn that never cuts the turn it was mounted during, disposal removing both listeners (the next turn completes instead of being cut), and fail-loud load rejection for zero, negative, NaN, and infinite values, a cost ceiling without a price, and a non-positive price. Per-file coverage is 100% on statements, branches, functions, and lines.

## Deferred

- A hosted configuration surface for the ceilings; today they reach the plugin through a composition row.

## Related

- [Session event read deprecation](../../implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md) — why the guard folds delivered events instead of reading history.
- [Evolution Curator](../../implemented/feature/2026-09-11-evolution-curator.md) — the sibling long-horizon slice shipped on the same specification.
