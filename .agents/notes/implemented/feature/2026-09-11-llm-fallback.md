# Agent Note: LLM Route Fallback without Loop Changes

Status: implemented

English | [中文](2026-09-11-llm-fallback.zh.md)

## Problem

A dead provider ended the turn: after `llm-retry` declined a failure, the loop re-issued the same route or gave up, so one outage stopped an agent that had healthy routes configured. The specification answers with route fallback plus a per-route breaker and a key rotation hook — but the loop re-issues the identical request object on `{ kind: 'retry' }`, which first looked like fallback needed loop surgery to reroute.

## Decision

Ship `@deepseek-ai/dsh-llm-fallback` in the `llm/` group with no loop changes. The loop re-emits the `agent/request` waterfall per attempt, whose contract is "return a replacement to switch" (the live `model-selection` precedent), so the plugin pairs an outer `agent/request-error` wrapper that always delegates downstream first with an `agent/request` override serving a stashed route for the failed step's next attempt. Declined failures record against their route, open breakers and the just-failed provider are skipped in config order, the rotation hook runs before the switch, and the durable `llm/fallback` event appends before the `{ kind: 'retry' }` answer. Downstream retries are always preserved, never superseded; inherited reasoning effort is stripped on the switch because a different adapter may reject the previous route's knobs. Breaker state is process-local with no success reset yet; key rotation arrives as an optional `ctx.llmFallbackKeyRotation` instead of Config so the generated configuration catalog stays pure data.

## Alternatives considered

- **Extending `RequestErrorAction` with a route payload.** Rejected: it needs a loop change (architecture map update, SDK projections, snapshots) for behavior the existing `agent/request` contract already produces. The stash plus replacement achieves the same observable switch with none of that cost.
- **Inner posture (registering after `llm-retry`).** Rejected: a handling retry short-circuits without delegating, so an inner fallback never sees handled failures and can never supersede. The outer wrapper observes every failure and still preserves downstream retries; row order is pinned by test.
- **Counting retried-then-recovered blips toward the breaker.** Rejected: only failures downstream declines reach evaluation, so the breaker counts give-ups rather than transients. Success resets need an `assistant/message` observer and arrive separately.
- **A second abort check after the rotation hook.** Rejected: the loop's post-waterfall `throwIfAborted` still wins, so at most one stray event lands on a dying turn — and the check would be untestable without warping the hook signature around cancellation.
- **Masking downstream listener throws.** Rejected: a throwing recovery chain is a bug, and the switch would hide it. The throw propagates; only rotation-hook throws are contained (warn and proceed).

## Consequences

Provider outages now migrate the session across configured routes with an auditable event per switch: status surfaces can follow `llm/fallback` the way they follow `llm/retry`. Switched routes persist across turns through the loop's persisted header with no automatic return; always-mode retry policies starve fallback by never declining; each switch costs one shared `maxRequestRetries` step. The shipped web-app bundle mounts the row after the base insert's `llm-retry` row with an empty rotation list, so fallback stays off until a deployment names routes and rotates keys through the context hook; the outer-wrapper posture holds at either row order.

## Testing

Thirteen specs pin config defaults with route copying, loud rejections, end-to-end provider switching with the logged event, downstream-retry preservation beside a mounted `llm-retry`, ineligible and routeless terminal declines, breaker open/skip/cool-down with chained fallback ids across three turns, key rotation invocation and throwing-hook survival, turn-cancellation purity, post-disposal silence plus stale-callback refusal. Per-file 100% holds on statements, branches, functions, and lines.
