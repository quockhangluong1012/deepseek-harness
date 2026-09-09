# Agent Note: Agent-loop step and retry ceilings

Status: implemented

English | [中文](2026-09-09-agent-loop-bounds.zh.md)

## Problem

A step that keeps failing keeps paying for model calls: any `agent/request-error` listener that returns `{ kind: 'retry' }` unconditionally re-runs the failed step without bound, and `always`-mode provider policies never exhaust on their own. Tool-calling turns have the same shape: every tool result that stages more work continues the turn. Both loops burn time, tokens, and money with no ceiling the deployment can set from configuration.

## Decision

The loop enforces two ceilings, both validated `Config` fields and live user settings under the `agent-loop` section.

`maxSteps` (default `100`) ends a turn that would enter more steps with `max-steps`. The ceiling fires only past the budget, so a turn finishing exactly at the ceiling still ends normally; like `max-tokens`, the first ceiling hit owns the outcome and a later step never downgrades it, and the turn stops even when steering queued more work.

`maxRequestRetries` (default `10`) caps honored `agent/request-error` recoveries per step. A recovery past the ceiling stays terminal and warns with the agent, turn, step, and count; `0` disables request recovery entirely. Provider retry policies stay authoritative below the ceiling: their default allows 5 recoveries, at half the loop cap, so ordinary `normal`-mode recovery never reaches it. Cancellation still wins over a retry decision.

## Ceiling semantics

Both ceilings are read through the live configuration on every decision, so a committed settings change bounds the next step or retry without disturbing the one in flight, and a refused write keeps the running loop on its last good caps. The retry counter resets with each step, and the step ceiling composes with it: a turn is bounded by `maxSteps` steps whatever each step's recoveries do. Neither ceiling bounds tokens, time, or cost; a policy that bounds those still cancels from an existing lifecycle extension point such as `agent/turn-stopping`.

## Alternatives considered

**Rely on `dsh-llm-retry` alone.** It bounds only `normal`-mode policies per provider and policy key; `always` mode and custom recovery listeners bypass it, which is exactly the storm the loop cap stops.

**Count retries durably in the session log.** The cap is a local deployment choice, not model-visible state; durable counting would add session format surface without changing what the model sees, so the counter stays process-local to the step.

**Blanket tool timeout or token budget in the loop.** Rejected: cancellation in the loop is cooperative, and hard kills need a worker or process boundary; per-call limits belong to the guard policy that declares them, and token or time budgets belong to a policy plugin on `agent/turn-stopping`.

**A lower default.** Provider stacks can legitimately spend more than 5 recoveries in one step when the route changes mid-step and each policy counts separately, so the loop default holds at twice the provider default instead of matching it.

## Consequences

Worst-case model calls per turn are bounded by `maxSteps` steps times `1 + maxRequestRetries` recoveries each. Default-path transcripts are unchanged: provider policies exhaust before the loop ceiling, so recorded-session snapshots need no refresh. A deployment that legitimately needs more than 10 recoveries in one step must raise the ceiling explicitly; a past-ceiling failure surfaces as the terminal provider error, with the warn as the only record that the ceiling fired.

## Testing

`request-error.spec.ts` pins the default ceiling against an always-retry listener, a smaller configured ceiling, the zero disable, and load-time rejection of negative and fractional values. `settings.spec.ts` pins settings layering and write-time refusal. `request-reconstruction.spec.ts` pins that a tools-only change logs a header `change` without a series flag, which the shared series predicate preserves. The per-file 100% coverage gate keeps every ceiling branch executed.

## Related

- [Bounded LLM request recovery](../architecture/2026-06-21-bounded-llm-request-recovery.md) owns provider-routed retry budgets; the loop ceiling is the deployment backstop above them, not a cross-agent budget.
