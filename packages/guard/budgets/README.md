---
description: "Per-turn budget guard: token-pressure, tool-call, and wall-clock ceilings checked before each step, for users and maintainers choosing, configuring, or debugging the guard."
kind: "package-reference"
---

# @deepseek-ai/dsh-budgets

English | [中文](README.zh.md)

## Summary

Use this package to bound what one turn can spend. Three optional ceilings — measured request pressure, dispatched tool calls, and wall-clock duration — are checked before each proposed step; when one is reached, the guard records a durable `budget/exceeded` event, rejects that step, and the turn ends blocked instead of continuing. A step that claims a human message always enters, so a budget never discards what the user said, and every ceiling is off unless configured. The `dsh` web-app bundle mounts the plugin with all three ceilings off, so a deployment opts in per composition.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a session should stop rather than keep spending on one runaway turn. With no configuration it observes turns and rejects nothing; each ceiling you set turns on one bound.

### When to choose it

Choose it when an unattended or long-horizon agent must be bounded — a tool loop that never converges, a turn that runs for hours, or a context that keeps growing through its own output. Avoid it when every turn must be allowed to finish for correctness, and when you need a hard interruption: the guard is checked between steps, so it stops the *next* model request, never a call already in flight. It is also the wrong tool for a session-wide or daily budget, because each turn gets the full ceiling again.

### Setting the ceilings

Mount the plugin with the ceilings the deployment wants:

```yaml
- name: '@deepseek-ai/dsh-budgets'
  config:
    maxTotalTokens: 200000   # reject a step once measured request pressure reaches this
    maxToolCalls: 50         # reject a step once this many tool calls are dispatched in the turn
    maxWallMs: 600000        # reject a step once the turn has run this long
    maxCostUsd: 5             # reject a step once the turn's priced cost reaches this many USD
    usdPerMillionTokens: 3    # USD per million measured tokens: what the deployment's model costs
```

| Field | Default | Meaning |
|---|---|---|
| `maxTotalTokens` | unset (off) | Ceiling on the measured request pressure of one step, compared before that step |
| `maxToolCalls` | unset (off) | Ceiling on tool calls dispatched in one turn |
| `maxWallMs` | unset (off) | Ceiling on one turn's wall-clock duration, measured from its `turn/start` |
| `maxCostUsd` | unset (off) | Ceiling on one turn's measured cost in USD, compared before that step; needs `usdPerMillionTokens` |
| `usdPerMillionTokens` | unset (inert) | Deployment price of one million measured tokens in USD; without `maxCostUsd` it does nothing |

Each ceiling is off while unset, and a plugin mounted with no configuration rejects nothing. A non-positive or non-finite value fails plugin load with a clear error instead of silently disabling the ceiling it names, and the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-budgets) is the complete list of accepted values.

### What you get

When a turn reaches a configured ceiling, the guard records one durable `budget/exceeded` session event naming the ceiling, the observed value, the configured limit, and the turn and step it stopped; logs one warning with the same facts; and rejects the proposed step. The loop then closes the turn with its existing `blocked` reason, the same reason a rejected step has always produced, and no `TurnEndReason` is added. Tool results already produced stay in the session, and the next turn starts with fresh facts — its own `turn/start` resets the tool-call count and the wall-clock origin.

The event is log-only and required on read: it carries no `ignorable` marker, so a reader that does not know the type refuses the log rather than dropping the cut. Its payload and declaration site are in the generated [persistence catalog](../../../docs/persistence-catalog.md#budgetexceeded--log-only).

The order matters in two places. Human input wins: if the claimed messages of a step include one with `source.kind === 'user'`, that step enters and the ceilings are not even evaluated, so a rejection can never drop a user message or a steering instruction. And checks run cheapest first — tool calls, then wall clock, then the token measurement — so a turn already over a cheaper ceiling does not pay for a replay of its log.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard learns a turn's activity and where it vetoes, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on four commitments:

- **Enforce at a veto boundary that exists.** `agent/pre-step` is the declared waterfall whose rejection the loop already turns into `{ kind: 'blocked' }`; `agent/turn-stopping` is a stop event with no veto slot, so a listener there would be dead weight. The full deviation from the specification's planned enforcement points is recorded in the [guard-budgets Agent Note](../../../.agents/notes/implemented/feature/2026-09-12-guard-budgets.md).
- **Facts, not history.** Per-turn facts live in a `WeakMap<Session, TurnFacts>` maintained from the delivered `session/event` — never a synchronous read of the session log — so a resumed or forked session costs nothing and no new projection is needed.
- **Human input outranks every ceiling.** Claimed messages exist to be delivered; rejecting a step that carries a user message would discard it, so the guard delegates instead.
- **A ceiling is configuration, not a constant.** Every bound is an optional validated `Config` field changeable from `cordis.yml`; there is no hidden default and no test hook.

### How a turn is observed and cut

One `session/event` listener builds the facts: `turn/start` writes `{ turn, startedAt: event.time, toolCalls: 0 }`, `tool/call` increments `toolCalls` when an entry exists, and every other event type is ignored. Because an entry is created only by the `turn/start` the plugin itself observed, a turn that was already open when the plugin loaded has no facts and is never cut.

One `agent/pre-step` listener evaluates a proposed step. It delegates untouched when there are no facts for the agent's session or the facts belong to another turn, when a claimed message carries `source.kind === 'user'`, and when no ceiling is configured or reached. Otherwise it appends the `budget/exceeded` event through the session's own append path, logs the single warning, and returns `{ kind: 'reject' }` without calling `next()`, which is the short-circuit Cordis waterfalls define: no later listener runs and the loop records `blocked`. The event is written before the rejection so the durable log carries the cut's reason even if the process dies with the turn; the warning and the event state the same facts, and the turn's `blocked` end remains the outcome a reader reconstructs.

### What each ceiling compares

`maxToolCalls` compares the turn's counted `tool/call` events. `maxWallMs` compares `Date.now() - facts.startedAt` against the turn's own `turn/start` timestamp, so it is wall clock, not CPU time. `maxTotalTokens` compares `ctx.tokenMeter.measure(agent.session).totalTokens` — the meter's estimate of total request pressure, which reuses provider usage when it is safe to do so and reprices the current surface otherwise; it is a measurement of the request, not a bill. `maxCostUsd` prices that same measurement at `usdPerMillionTokens` per million tokens and compares the turn's cost in USD.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, turn-fact and pre-step listeners |
| [`src/types.ts`](src/types.ts) | Durable `budget/exceeded` payload, the shared ceiling-name vocabulary, and the `SessionEventMap` merge |
| — | No runtime invariant companion is published; the guard owns one weak per-session fact map consumed by its own listener, and a companion re-deriving turn facts from the log would observe the same events rather than an independent relation. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the pre-step boundary to the loop's turn lifecycle, the measured pressure, and the guard group map.

- [Agent package reference](../../../packages/core/agent/README.md) — the `agent/pre-step` waterfall and the `PreStepDecision` values the loop understands.
- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/execute` pipeline that produces the `tool/call` events this guard counts.
- [guard-budgets Agent Note](../../../.agents/notes/implemented/feature/2026-09-12-guard-budgets.md) — the design, the human-input rule, and the enforcement points this package rejects.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-budgets) — every accepted ceiling and its source declaration.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### Conditional turn termination

#### What the model sees

No prompt, tool schema, or message text is added. A reached ceiling means the next request of that turn is never made: the turn closes with the loop's `blocked` reason, and the model's next request is whatever the next turn assembles. Tool results already produced stay in the log, so their content is not hidden from later turns.

#### Token effect

Zero tokens added; the measurement itself sends nothing. A reached ceiling saves the prompt, tool schemas, and output of every step it prevents, which is the point of the bound.

#### KV Cache effect

Append-only; rejecting a step adds nothing to the request surface, so existing KV Cache entries stay reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Required-on-read event** — the `budget/exceeded` record carries no `ignorable` marker (the append path cannot write one), so a harness older than the event refuses the whole log instead of skipping the cut. Upgrade the reader before reading a log a newer harness cut.
- **No pricing source** — the harness cannot price a model by itself: `maxCostUsd` multiplies the measured pressure by the deployment's `usdPerMillionTokens` per million tokens, so a stale price silently misprices every turn. Set the price from the provider's current rate and recalibrate when the model changes.
- **Per-turn facts only for observed turns** — a turn already open when the plugin loads has no entry and is never cut, which also means a plugin mounted mid-turn cannot bound the turn it was mounted during.
- **Checked between steps** — a single long model call or tool execution is not interrupted; the ceiling takes effect at the next proposed step, and an agent that never proposes one (a hung provider call) is not stopped by this guard.
- **Per-turn, never per-session** — each turn gets the full ceiling again, so a long session can spend the same budget many times.
- **Human input bypasses every ceiling** — by design, but it means a user who keeps steering keeps the turn alive past every bound.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The field names differ from the `maxInputTokens` and `maxCostUsd` the evolutionary-harness specification proposed: the shipped field is `maxTotalTokens` because `ctx.tokenMeter` measures total request pressure rather than input tokens alone, and cost is priced by the deployment's `usdPerMillionTokens` instead of a harness pricing source, which does not exist. The family's reference contract is the [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md).

</details>
