---
description: "Budget guard for turns, sessions, and runs: billed-token, priced-cost, tool-call, wall-clock, and context-pressure ceilings checked before each step, for users and maintainers choosing, configuring, or debugging the guard."
kind: "package-reference"
---

# @deepseek-ai/dsh-budgets

English | [中文](README.zh.md)

## Summary

Bound what an agent may spend before its next model request. Optional ceilings bound one turn, the whole session, and one run by billed tokens, priced dollars, tool calls, or wall-clock time; a separate ceiling bounds measured context pressure. When a step would reach one, the guard records a durable `budget/exceeded` event, rejects that step, and the turn ends blocked instead of continuing. A step that claims a human message always enters, so a budget never discards user input. Every ceiling is off unless configured, and the web-app bundle mounts the plugin with all of them off.

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

Mount this plugin when an agent should stop rather than keep spending. With no configuration it observes turns and rejects nothing; each ceiling you set turns on one bound.

### When to choose it

Choose it when an unattended or long-horizon agent must be bounded: a tool loop that never converges, a session that runs for hours, or a request that keeps billing. Three scopes answer three questions — a turn ceiling bounds one model-request cycle, a session ceiling bounds the whole conversation's billed history, and a run ceiling bounds one task the kernel opened. A context ceiling stops a turn whose request has outgrown what it is measured against.

Avoid it when every turn must be allowed to finish for correctness, and when you need a hard interruption: the guard is checked between steps, so it stops the *next* model request, never a call already in flight. It also cannot bound work it never observed — see [Known Limitations and Deferred Work](#known-limitations-and-deferred-work).

### Setting the ceilings

Mount the plugin with the ceilings the deployment wants:

```yaml
- name: '@deepseek-ai/dsh-budgets'
  config:
    maxTotalTokens: 200000      # billed tokens one turn may spend
    maxToolCalls: 50            # tool calls one turn may dispatch
    maxWallMs: 600000           # milliseconds one turn may run
    maxSessionTokens: 5000000   # billed tokens the whole session may spend
    maxSessionCost: 25          # USD the session may spend, priced by usdPerMillionTokens
    maxSessionWallTime: 28800000
    maxRunTokens: 500000        # billed tokens one run may spend
    maxRunCost: 5
    maxRunWallTime: 1800000
    maxContextTokens: 200000    # measured request pressure of one step
    usdPerMillionTokens: 3      # USD per million billed tokens: what the deployment's model costs
```

| Field | Scope | Default | Meaning |
|---|---|---|---|
| `maxInputTokens` | turn | unset (off) | Prompt tokens — uncached input plus cache reads and writes — one turn may be billed for |
| `maxOutputTokens` | turn | unset (off) | Completion tokens one turn may be billed for |
| `maxTotalTokens` | turn | unset (off) | All billed tokens one turn may spend |
| `maxToolCalls` | turn | unset (off) | Tool calls one turn may dispatch |
| `maxWallMs` | turn | unset (off) | Wall-clock duration of one turn, measured from its `turn/start` |
| `maxSessionTokens` | session | unset (off) | Billed tokens the whole session may spend |
| `maxSessionCost` | session | unset (off) | Priced USD the session may spend; needs `usdPerMillionTokens` |
| `maxSessionWallTime` | session | unset (off) | Wall-clock age of the session, measured from its creation |
| `maxRunTokens` | run | unset (off) | Billed tokens one run may spend |
| `maxRunCost` | run | unset (off) | Priced USD the run may spend; needs `usdPerMillionTokens` |
| `maxRunWallTime` | run | unset (off) | Wall-clock duration of one run, measured from its run marker |
| `maxContextTokens` | context | unset (off) | Measured request pressure of the next request |
| `maxCostUsd` | turn | unset (off) | Priced USD one turn may spend; needs `usdPerMillionTokens` |
| `usdPerMillionTokens` | price | unset (inert) | USD per million billed tokens; without a cost ceiling it does nothing |

Each ceiling is off while unset, and a plugin mounted with no configuration rejects nothing. A non-positive or non-finite value fails plugin load with a clear error instead of silently disabling the ceiling it names. A cost ceiling without a price is a supported state, not a misconfiguration: the plugin loads, logs one warning, and reports that axis as unmeasurable, because the harness owns no price source of its own and the deployment states what its models cost. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-budgets) is the complete list of accepted values.

### What you get

When a step reaches a configured ceiling, the guard records one durable `budget/exceeded` session event, logs one warning with the same facts, and rejects the proposed step. The event names the budget (`scope`: `turn`, `context`, `session`, or `run`), the ceiling (`name`), the value compared (`observed`), the configured limit (`limit`), the turn and step it stopped, the run identity when the scope is a run, and every ceiling as the deployment configured it — a number, the literal `unbounded` for an axis left unset, or `unmeasurable` for a cost axis with no price. The loop then closes the turn with its existing `blocked` reason, the same reason a rejected step has always produced, and no `TurnEndReason` is added. Tool results already produced stay in the session, and the next turn starts with fresh per-turn facts.

The event is log-only and required on read: it carries no `ignorable` marker, so a reader that does not know the type refuses the log rather than dropping the cut. Its payload and declaration site are in the generated [persistence catalog](../../../docs/persistence-catalog.md#budgetexceeded--log-only).

The order matters in two places. Human input wins: if the claimed messages of a step include one with `source.kind === 'user'`, that step enters and the ceilings are not even evaluated, so a rejection can never drop a user message or a steering instruction. And checks run cheapest first — counters, then clocks, then one reading of billed spend, then the context measurement — so a step already over a cheaper ceiling does not pay for a replay of its log.

### Where the numbers come from

Billed spend is the token meter's own provider-reported accounting, read from its `tokenUsage` session projection: the four disjoint buckets it folds from every settled assistant attempt that reported usage, retries counted separately. A turn compares the difference between the session's current reading and the reading when its `turn/start` arrived, a session compares the whole reading, and a run compares the difference since its run marker. Because the projection folds each settlement as it lands, the turn that is spending is the turn a ceiling can cut, rather than one turn later.

A run is the kernel's durable task: the guard reads the run identity and start time off the log structurally, from the `task/created` event's metadata, so it needs no compile-time dependency on `@deepseek-ai/dsh-agent-kernel`. Context pressure is the only axis that reads a measurement rather than spend: `maxContextTokens` compares `ctx.tokenMeter.measure(session).totalTokens`, the request rather than the bill.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard learns a turn's, a session's, and a run's activity and where it vetoes, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on five commitments:

- **Enforce at a veto boundary that exists.** `agent/pre-step` is the declared waterfall whose rejection the loop already turns into `{ kind: 'blocked' }`; `agent/turn-stopping` is a stop event with no veto slot, so a listener there would be dead weight. The full deviation from the specification's planned enforcement points is recorded in the [guard-budgets Agent Note](../../../.agents/notes/implemented/feature/2026-09-12-guard-budgets.md).
- **Facts, not history.** Per-turn and per-run facts live in `WeakMap`s keyed by session and are maintained from the delivered `session/event` — never a synchronous read of the session log — so a resumed or forked session costs nothing and no new projection is needed.
- **One owner per number.** Billed spend is read from the token meter's `tokenUsage` projection and context pressure from its `measure()`; the guard re-derives neither.
- **Human input outranks every ceiling.** Claimed messages exist to be delivered; rejecting a step that carries a user message would discard it, so the guard delegates instead.
- **A ceiling is configuration, not a constant.** Every bound is an optional validated `Config` field changeable from `cordis.yml`; there is no hidden default and no test hook.

### How a turn and a run are observed and cut

One `session/event` listener builds the facts. `turn/start` writes `{ turn, startedAt: event.time, toolCalls: 0, spend }` with the session's billed spend at that instant, `tool/call` increments `toolCalls` when an entry exists, a `task/created` event carrying a usable run identity writes `{ runId, startedAt, spend }`, and every other event type is ignored. Because a turn entry is created only by the `turn/start` the plugin itself observed, and a run entry only by a marker it saw, work already in flight when the plugin loads is never cut — and a run whose marker predates the mount has no measured spend.

One `agent/pre-step` listener evaluates a proposed step. It delegates untouched when there are no facts for the agent's session or the facts belong to another turn, when a claimed message carries `source.kind === 'user'`, and when no ceiling is configured or reached. Otherwise it appends the `budget/exceeded` event through the session's own append path, logs the single warning, and returns `{ kind: 'reject' }` without calling `next()`, which is the short-circuit Cordis waterfalls define: no later listener runs and the loop records `blocked`. The event is written before the rejection so the durable log carries the cut's reason even if the process dies with the turn; the warning and the event state the same facts, and the turn's `blocked` end remains the outcome a reader reconstructs.

### What each ceiling compares

`maxToolCalls` compares the turn's counted `tool/call` events. `maxWallMs` compares `Date.now() - facts.startedAt` against the turn's own `turn/start` timestamp, so it is wall clock, not CPU time. `maxSessionWallTime` compares the same clock against the session header's creation time, so it counts the session's whole age, idle periods included. `maxRunWallTime` compares against the run marker's timestamp.

`maxInputTokens`, `maxOutputTokens`, and `maxTotalTokens` compare the turn's billed buckets: prompt tokens are uncached input plus both cache buckets, and the total adds completion tokens. `maxSessionTokens` and `maxRunTokens` compare the same buckets over the session and the run. `maxCostUsd`, `maxSessionCost`, and `maxRunCost` price those tokens at `usdPerMillionTokens` per million — one flat rate for prompt, completion, and cached tokens alike, because the harness holds no per-route rate table. `maxContextTokens` compares `ctx.tokenMeter.measure(agent.session).totalTokens`, the meter's estimate of total request pressure, which reuses provider usage when it is safe to do so and reprices the current surface otherwise; it measures the request, not a bill.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, fact listeners, ceiling evaluation |
| [`src/types.ts`](src/types.ts) | Ceiling table plus the scope and measure vocabulary, the durable `budget/exceeded` payload, and the `SessionEventMap` merge |
| [`src/spend.ts`](src/spend.ts) | Billed-token split and flat pricing, with an unavailable side read as unmeasurable |
| [`src/run-marker.ts`](src/run-marker.ts) | The structural read of the kernel's durable run marker |
| — | No runtime invariant companion is published; the guard owns two weak per-session fact maps consumed by its own listener, and a companion re-deriving the same facts from the log would observe the same events rather than an independent relation. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the pre-step boundary to the loop's turn lifecycle, the measured numbers, and the guard group map.

- [Agent package reference](../../../packages/core/agent/README.md) — the `agent/pre-step` waterfall and the `PreStepDecision` values the loop understands.
- [Token meter](../../llm/token-meter/README.md) — the `tokenUsage` and `contextPressure` projections and `measure()` that this guard reads instead of measuring again.
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

Zero tokens added; the measurements themselves send nothing. A reached ceiling saves the prompt, tool schemas, and output of every step it prevents, which is the point of the bound.

#### KV Cache effect

Append-only; rejecting a step adds nothing to the request surface, so existing KV Cache entries stay reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Required-on-read event** — the `budget/exceeded` record carries no `ignorable` marker (the append path cannot write one), so a harness older than the event refuses the whole log instead of skipping the cut. Upgrade the reader before reading a log a newer harness cut.
- **No harness price source** — cost ceilings are only as accurate as the deployment's flat `usdPerMillionTokens`, one rate for prompt, completion, and cached tokens, and a stale price silently misprices every step. The owner of a better source does not exist yet: the model catalog of [@deepseek-ai/dsh-llm-deepseek](../../llm/llm-deepseek/README.md) declares no cost, and per-route rates reach the harness only through an adapter's `resolveModelInfo`. Until that owner lands, a cost ceiling without a price loads, warns once, and reports itself as `unmeasurable`.
- **Facts only for observed turns and runs** — a turn already open when the plugin loads is never cut, and a run whose `task/created` marker predates the mount has no measured spend, so a process resumed mid-run starts its run ceilings from the next marker it sees.
- **Checked between steps** — a single long model call or tool execution is not interrupted; the ceiling takes effect at the next proposed step, and an agent that never proposes one (a hung provider call) is not stopped by this guard.
- **Provider-reported tokens, not the invoice** — the projection counts settled attempts that reported usage, so an attempt reporting none contributes nothing and the reading is a floor; retries count, and cache pricing follows the provider's own rules.
- **Human input bypasses every ceiling** — by design, but it means a user who keeps steering keeps the turn alive past every bound.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The turn fields still differ from the specification's proposed `maxTurnInputTokens`, `maxTurnOutputTokens`, and `maxTurnTotalTokens`: the shipped names are `maxInputTokens`, `maxOutputTokens`, and `maxTotalTokens`, and `maxTotalTokens` kept its name because deployments already configure it. The session and run fields match the specification's names, and its `maxContextTokens` ships here as the pressure axis, while [agent-context](../../runtime/agent-context/README.md) owns the compilation budget of the same name. Pricing stays a deployment-stated flat rate until a route-cost owner exists; the shape of that change is the route's declared cost from `ctx.llm.resolveModelInfo(provider, model).cost`, priced by usage-ledger's `priceSample` and resolved per route. The family's reference contract is the [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md).

</details>
