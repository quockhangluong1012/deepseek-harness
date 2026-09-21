---
description: "Per-session failure observations: failing tool results recorded, deduplicated, and aggregated into natural-language feedback for the learning loop (ctx.evolutionFeedback)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-feedback

English | [中文](README.zh.md)

## Summary

`dsh-evolution-feedback` turns failing tool results into durable per-session observations and aggregates them into the natural-language feedback the learning loop reads; nothing here calls a model. It records only a failing `tool/result` whose tool call it saw, counts a repeat instead of appending it twice, and keeps the newest `maxEntries` per session. `summary` merges sessions by tool and message, so a fault seen in four sessions outranks one repeated four times in one session; `signals` triggers a review once `triggerReviewSessions` distinct sessions report a failure. `reflect` and `recordReflection` carry analyst-supplied root causes and corrected strategies.

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

Mount the plugin; observation needs no further wiring. Read one session's failures with `entries`, several sessions' merged failures with `summary`, or the graded signals a decision consumes with `signals`.

```ts
const failures = ctx.evolutionFeedback.summary(workspace.sessionIds, 10)
for (const failure of failures) {
  console.log(`${failure.tool ?? 'unknown'} ×${failure.count} (${failure.sessions} sessions): ${failure.message}`)
}
```

```ts
const signals = ctx.evolutionFeedback.signals(workspace.sessionIds, 10)
const decisive = signals.find(signal => signal.actionability === 'trigger_review')
```

```ts
const reflections = ctx.evolutionFeedback.reflect(workspace.sessionIds, 10)
for (const reflection of reflections) {
  console.log(`${reflection.symptom}: expected ${reflection.violatedExpectation} (confidence ${reflection.confidence})`)
}
await ctx.evolutionFeedback.recordReflection(reflections[0]!.failureId, {
  rootCause: 'the skill suggests a flag this shell lacks',
  correctedStrategy: 'probe the flag before using it',
})
```

A reflection's analytic fields stay null until `recordReflection` states them, so a reader never mistakes missing analysis for measured fact. A repeated session id in the input counts once, and an unknown one reports nothing.

A failing result whose `tool/call` was never observed records a null tool, and one carrying neither text nor a failure code records an empty message — both are real states, not errors. A successful result records nothing. `signals` sorts the graded aggregation, so a decisive signal survives a limit that a merely counted one would fill; `summary` keeps its count ordering.

### Configuration

Observation is on by default; every field is a validated `Config` member changeable from `cordis.yml`.

```yaml
- name: '@deepseek-ai/dsh-evolution-feedback'
  config:
    maxEntries: 50
    maxMessageChars: 300
    triggerReviewSessions: 3
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether failing tool results are observed; reads stay available either way |
| `maxEntries` | `100` | Observations retained per session, newest first |
| `maxMessageChars` | `500` | Character budget for one recorded failure message |
| `triggerReviewSessions` | `2` | Distinct sessions reporting one failure before it triggers a review |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-feedback) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One durable record per session in storage domain `evolution_feedback`, version `2`, layout `per-record`, table `records`, keyed by session identity. A record holds the session's retained observations newest-first plus the instant of its last write. A second table, `reflections`, holds the analyst-supplied half of one structured reflection per failure merge key — root cause, corrected strategy, reusable condition, anti-pattern, and candidate test — plus its last analysis write. Observation is derived state: the plugin rebuilds nothing at start-up, so a host restart simply stops observing sessions that already ended and picks up the next ones.

An observation is keyed by tool and message. A repeat increments `count`, moves the entry to the front, and leaves the earlier copy out, so a session that hits one fault forty times holds one entry carrying forty.

### Write ordering

Tool results of one step arrive together, so a naive read-then-write would race with itself and lose observations. Each session therefore owns one write chain: a record is queued behind that session's previous write, so the read-then-write decision inside one observation never overlaps another. The chain drops its map entry once it settles as the tail, so a session that stops failing leaves nothing behind.

### Failure and recovery

Invalid records fail the domain open loudly: a dropped `count` would silently reorder which failure the learning loop treats as dominant. Reads throw before the store starts. A write that cannot land logs one warning and drops that observation rather than surfacing as a session error.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness.spec.md) — the behaviour contract behind the self-learning family.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-reviewer`](../evolution-reviewer/README.md) — the sibling observer that derives lessons from the same turn stream.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-feedback) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering recorded failures into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Tool failures only** — user corrections, partial successes, and non-tool failures are not observed; only a `tool/result` marked as an error records anything.
- **One record per session, never pruned** — a session's own observations are capped, but the domain keeps a record for every session that ever failed.
- **Observation is not retroactive** — only events delivered while the plugin is mounted are recorded; a session that failed before the mount is invisible.
- **The tool name is best-effort** — a result whose `tool/call` was not observed, or that arrives after its turn ended, records a null tool.
- **Messages are clipped, not summarized** — a long failure keeps its first `maxMessageChars` characters, so two different long failures can collide on one entry.
- **Analytic fields need an author** — `reflect` derives the ledger half, but root cause and corrected strategy stay null until something states them; no loop calls `recordReflection` yet, so the dreaming REM phase and reviewer extraction are the intended authors.
- **Machine-local only** — records live under `$DSH_HOME`, never inside the project directory.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`summary` is display-only for the curator's survey prompt and dreaming's light phase, and the curator pass is what turns `signals` into a decision: an attributable failure demotes the skill it was correlated with. That consumer sets `triggerReviewSessions`; the default of two keeps a single bad session from demoting a skill on its own.

</details>
