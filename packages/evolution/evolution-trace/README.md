---
description: "Immutable session trace projection: structured learning traces with ranked root-cause attribution and compressed summaries over the committed session log (ctx.evolutionTrace)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-trace

English | [中文](README.zh.md)

## Summary

`dsh-evolution-trace` turns a committed session log into the structured learning trace the evolution loop reads: per-turn and per-step tool calls with their outcomes, model-attempt retries, interruptions, token usage and latency, plus ranked root-cause candidates on every failed tool call and a compressed learning-trace row per session. Nothing here calls a model and nothing writes a new domain — the session log already is the immutable raw trace, so the store derives the machine-readable and compressed forms from it on demand. The host command `command-evolution` reads it through `/trace <sessionId>`.

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

Mount the plugin; projection needs no further wiring. Project one session's log with `trace`, or compress several sessions into decision-ordered rows with `summary`.

```ts
const record = await ctx.evolutionTrace.trace(sessionId)
if (record === undefined) {
  console.log('storage holds no such session')
} else {
  for (const turn of record.turns) {
    console.log(`turn ${turn.turn} [${turn.endReason ?? 'open'}]: ${turn.request}`)
    for (const failure of turn.failures) {
      console.log(`${failure.tool} failed: ${failure.message}`)
      for (const cause of failure.causes) console.log(`  ← ${cause.reason}`)
    }
  }
}
```

```ts
const rows = await ctx.evolutionTrace.summary(workspace.sessionIds, 10)
for (const row of rows) {
  console.log(`${row.sessionId}: ${row.failures} failure(s), ${row.retries} retr(ies), ${row.tokens} tokens`)
}
```

The `/trace` command renders one session's structured trace for operators: a header line, one line per turn with its request and outcome, one line per tool call, and the ranked root-cause candidates under each failure.

### Configuration

Projection is on by default; every field is a validated `Config` member changeable from `cordis.yml`.

```yaml
- name: '@deepseek-ai/dsh-evolution-trace'
  config:
    maxChars: 300
```

| Field | Default | Meaning |
|---|---|---|
| `maxChars` | `500` | Character budget for one failure or request gist |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-trace) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The session log is the immutable raw trace (spec §3.3 form one); this package owns only the derived forms. `project` is pure: it consumes committed `SessionEvent`s in sequence order and builds a `TraceRecord` — turns with their request gist, outcome, latency, and steps; steps with their tool calls, retry evidence, interruption flag, and token usage; and per-turn failures. A read path flushes a live session first so a query sees the turns that reached the model. Nothing is stored: a restart derives the same record from the same log, and there is exactly one authoritative source.

Credit assignment (spec §3.2) is a deterministic proximity heuristic, never a model judgment: the failing call ranks first, then the same-step calls before it (its input producers), then the previous step's calls (the context producer), then retrieval calls named `skill` or `memory` that may have missed, then the turn's request. An analyst can later replace the ranking with measured attribution; the schema is stable either way.

`summarize` compresses one record into a learning-trace row: counts, summed tokens and latency, and the distinct failure gists in first-occurrence order. `summary` sorts rows most decisive first — most failures, then retries, then billed tokens, then newest — so a consumer sees the sessions with the most to learn from ahead of the limit.

### Failure and recovery

A session storage holds no log for reads as absent and contributes nothing to `summary`; any other persistence failure stays fail-loud. Malformed or duplicated log structure (a re-opened turn, an unpaired tool call or result, an event for a step that never opened) is dropped by the projection rather than corrupting the record; the raw log retains everything for audit.

No invariant companion is published because the session log is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) — the trace/credit/compression mechanism families this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-trajectory`](../evolution-trajectory/README.md) — the sibling exporter that shapes the same log into ShareGPT conversations for evals.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-trace) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering trace rows into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Attribution is a heuristic, not a verdict** — causes are ranked by structural proximity; nothing here measures whether a cause actually contributed, so a reader must not treat the ranking as measured blame.
- **Arguments are not retained** — the structured trace keeps call identity, tool name, and result gist, but not the raw tool arguments; the session log retains them for audit.
- **Gists are clipped, not summarized** — a failure keeps its first `maxChars` characters, so two different long failures can collide on one gist.
- **No live bus consumers yet** — the projection read path is the current surface; turn-settled emission and its learning-system consumers land with the curriculum and shadow/canary work (P1).
- **Machine-local only** — reads resolve against the local session persistence, never a remote store.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`command-evolution` is the only current consumer (the `/trace` command). The summary ordering is deliberately decision-oriented (failures first) so the compressed rows feed a future curriculum or shadow runner without re-deriving priorities.

</details>