---
description: "The human-facing /cost slash command reporting catalog-priced USD estimates per agent and per subagent session."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-cost

English | [中文](README.zh.md)

## Summary

`dsh-command-cost` gives users the `/cost` command, which prices every billed attempt in the invoking agent and its whole subagent tree against the provider catalog rates already installed in the harness. Each session gets its own line, so a delegating agent shows which child spent what. Attempts on a model with no known rates are counted and named by route instead of being reported as free. Totals are estimates from catalog prices, never a billing record.

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

Mount `dsh-command-cost` in any deployment that has a command adapter and wants spend visibility; the shipped Web bundle mounts it beside the usage ledger.

### Command reference

`/cost` takes no arguments. Any non-empty input returns the usage error `Usage: /cost`.

| Input | Result |
|---|---|
| `/cost` | Prints the estimated USD total for the invoking agent plus every subagent session it can read, one indented line per session, then the routes that could not be priced |
| `/cost <anything>` | Returns `Usage: /cost` and appends no session event |

### Reading the report

The first line is always `Cost estimate in USD; provider catalog rates may differ from your invoice.`. Then `Priced total: $…` sums every priced attempt in the tree. Each session follows on its own line, indented by its depth in the subagent tree and labelled with the subagent's label when it has one: `<label>: $… (<n> priced, <n> unknown)`.

When any attempt had no resolvable price, the report adds `Unknown-priced attempts: <n>` and one line per distinct route, as `provider/model` or `unknown route` when even the route is missing. When a descendant session could not be read at all, it adds `Unreadable subagent sessions: <n>`. A tree with no billed samples prints `No billed usage samples are recorded for this session tree.` instead of a zero total.

Amounts print with eight decimals so a single cheap request never rounds to `$0.00000000`.

### What counts

One attempt is one provider usage sample on an `assistant/attempt` or `assistant/message` event, whose model route comes from the event's own message or the last `request/context` before it — the same vocabulary the usage ledger uses. Each session starts counting at its own first owned event, so a child forked from a parent counts only what it added, never the inherited prefix. That is what keeps the tree total from double-counting a fork.

Prices come from the resolved model info of whichever adapter owns the route, including provider volume tiers. An attempt on a route with no installed rates counts as unknown; the command never guesses and never treats an unknown model as free.

### Minimal configuration

The command has no configuration fields. Mount its four injected services' owners plus the command itself:

```yaml
- {name: '@deepseek-ai/dsh-llm'}
- {name: '@deepseek-ai/dsh-session-query'}
- {name: '@deepseek-ai/dsh-subagent'}
- {name: '@deepseek-ai/dsh-commands'}
- id: command-cost
  name: '@deepseek-ai/dsh-command-cost'
```

`dsh-usage-ledger` is a library dependency supplying the shared sample-validation and price arithmetic, not an injected service; the command runs without the ledger mounted. Headless, ACP automation, and JSON-RPC apps register no command adapter and therefore cannot reach `/cost`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Read-only over the session log.** The command touches no session state and appends no event. It reads the invoking session and each descendant through `ctx.sessionQuery.readSession`, then folds the already-committed events into per-session totals on every invocation.
- **Tree shape comes from the subagent service.** `ctx.subagents.listDescendants(rootId)` supplies the label, depth, and identity of every descendant; diagnostic rows and unreadable sessions are counted and reported rather than aborting the report.
- **One price lookup per route.** Routes are resolved once per invocation and cached, so a session tree with hundreds of attempts on one model performs one model-info lookup. A route whose pricing lookup fails is treated as unknown, not as an error.
- **Inherited events are skipped.** Each descendant input carries the session's `inheritedEventCount` as its starting offset, so forked history is priced once, in the session that owns it.
- **Unknown is a first-class outcome.** Samples that cannot be normalized, events with no known route, and routes with no catalog rates all land in the same unknown counter and stay visible in the output.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: command registration, session-tree walk, pricing fold, report rendering |
| — | No runtime invariant companion is published; the command reads committed state and owns no stream or projection of its own. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Usage ledger](../usage-ledger/README.md) — the durable billed-usage ledger and the `priceSample` arithmetic this command reuses.
- [Session query](../../session-query/session-query/README.md) — the read service that returns session log snapshots.
- [Subagent](../../subagent/subagent/README.md) — the descendant listing the session tree is built from.
- [Commands service](../../interaction/commands/README.md) — the command registry contract and dispatch.
- [LLM service](../../llm/llm/README.md) — resolved model info, including the provider cost metadata this command prices with.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/cost` observation

#### What the model sees

Nothing. `/cost` prints its report to the UI command plane, and the report never enters a model request: the command registers no prompt section, message, tool, or schema, and it appends no session event. The disclaimer, session lines, and unknown-route list exist only in the adapter's direct output.

#### Token effect

Zero. No command path assembles a request or adds content to one; the invocation reads committed events and calls no model.

#### KV Cache effect

No effect. The command changes no request prefix and follows no model route of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the report can and cannot tell a reader. They are current package constraints, not a task backlog.

- **Catalog prices, not invoices** — rates come from the installed provider catalog; provider discounts, negotiated prices, and non-USD billing are not modelled, and the printed total is an estimate.
- **Only sessions the subagent service still knows** — the tree is built from `listDescendants` plus one read per session; a descendant whose log cannot be read is counted under `Unreadable subagent sessions` instead of being priced.
- **Unknown routes are reported, never estimated** — a model missing from the catalog, or an event with no attributable route, leaves spend out of the total by design.
- **No history and no persistence** — every invocation recomputes from the logs; the command stores no running total and offers no time range or per-day breakdown, which the usage ledger and its dashboard tab own.
- **Bare `/cost` only** — there is no per-subagent filter, range argument, or currency option; the report always covers the whole tree.
- **Volume tiers use the billed-input sample** — tiers apply on the request's own billed input tokens, matching the provider's own selection rule rather than a running session total.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
