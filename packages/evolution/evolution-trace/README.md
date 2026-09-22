---
description: "Session trace projection over the committed session log: structured learning trajectories with ranked root-cause attribution, counterfactual baseline-vs-candidate replay, and compressed summaries (ctx.evolutionTrace)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-trace

English | [中文](README.zh.md)

## Summary

Read one session's committed log as a structured learning trajectory: turns, steps, tool calls and their recorded outputs, retries, context digests, plans, retrievals, final answers, evaluations, human feedback, cost and latency, with ranked root causes on every failed call and one row per session. Replay a recorded trace against a baseline and a candidate artifact revision, reading recorded tool output instead of re-invoking anything — keyless, deterministic, write-free. Nothing here calls a model or opens a storage domain: the session log is the raw trace. Steps replay cannot reconstruct are named, never guessed. The `/trace <sessionId>` command reads it.

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

Mount the plugin; projection needs no further wiring. Project one session's log with `trace`, compress several sessions into decision-ordered rows with `summary`, or replay one stored trace against two artifact revisions with `replay`.

```ts
const record = await ctx.evolutionTrace.trace(sessionId)
if (record === undefined) {
  console.log('storage holds no such session')
} else {
  for (const turn of record.turns) {
    console.log(`turn ${turn.turn} [${turn.endReason ?? 'open'}]: ${turn.request}`)
    console.log(`  plan: ${turn.subgoals?.map(goal => `${goal.content} (${goal.status ?? 'no status'})`).join('; ') ?? 'none'}`)
    for (const retrieval of turn.retrievals) console.log(`  retrieved via ${retrieval.tool}: ${retrieval.target}`)
    for (const step of turn.steps) console.log(`  step ${step.step} under context ${step.context?.digest ?? 'unrecorded'}`)
    for (const failure of turn.failures) {
      console.log(`${failure.tool} failed: ${failure.message}`)
      for (const cause of failure.causes) console.log(`  ← ${cause.reason}`)
    }
    if (turn.finalAnswer !== null) console.log(`  answer: ${turn.finalAnswer}`)
  }
  for (const evaluation of record.evaluations) console.log(`evaluated ${evaluation.status}`)
  for (const remark of record.feedback) console.log(`human said: ${remark.text ?? '(no text)'}`)
}
```

```ts
const rows = await ctx.evolutionTrace.summary(workspace.sessionIds, 10)
for (const row of rows) {
  console.log(`${row.sessionId}: ${row.failures} failure(s), ${row.retries} retr(ies), ${row.tokens} tokens`)
}
```

```ts
const report = await ctx.evolutionTrace.replay(sessionId, baselineArtifact, candidateArtifact)
if (report !== undefined) {
  console.log(`candidate ${report.candidate} changes ${report.changedSteps.join(', ') || 'nothing'}`)
  console.log(`replayed from snapshots: ${report.snapshotSteps.join(', ')}`)
  console.log(`could not replay: ${report.unreplayableSteps.join(', ') || 'none'}`)
}
```

`ReplayArtifact` is the caller's claim about an artifact revision: `{ id, version, body }`, where `id` is the target a retrieval call of the trace named. `replay` returns `undefined` when storage holds no such session, exactly as `trace` does.

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

The session log is the immutable raw trace (spec §3.3 form one); this package owns only the derived forms. `project` is pure: it consumes committed `SessionEvent`s in sequence order and builds a `TraceRecord` — turns with their request gist, outcome, latency, plan, retrievals, final answer and steps; steps with their tool calls, retry evidence, interruption flag, token usage and compiled-context identity; and per-turn failures. A read path flushes a live session first so a query sees the turns that reached the model. Nothing is stored: a restart derives the same record from the same log, and there is exactly one authoritative source.

A context compilation, plan revision, or todo snapshot binds to the turn or step open when it arrives and carries forward to the ones that follow, so a later record never overwrites a span already closed. That is why the projection tracks the closers (`step/end`, `turn/end`) as well as the openers.

### §3.1 trajectory items

The spec's §3.1 list, against what the committed session log actually records:

| §3.1 item | Where it comes from | Notes |
|---|---|---|
| request and resolved task specification | `user/message` gist per turn | the resolved specification is not separately logged |
| context snapshot/hash | `context/compiled` → `step.context.digest` | identity, not content |
| plan and subgoals | `todo/write` (with status) and `task/plan` (without) | the newest record in force wins |
| model calls | the step itself: attempts, usage, interruption | per-call route identity is not projected |
| tool calls and outputs | `tool/call` + `tool/result` | `snapshot` keeps the result text, clipped |
| intermediate decisions | — | not sourceable: no logged event records a decision |
| errors and retries | `tool/result` error blocks, `assistant/attempt` | |
| retrieved memories/skills | retrieval calls named `skill`/`memory`, with the target each named | |
| final answer/action | the last assistant message text in the turn | |
| evaluator results | `verification/result` | |
| user feedback | `feedback/record` | |
| cost/latency | `TokenUsage` per step, turn open→close | |
| artifact versions used | — | not sourceable: no logged event records a retrieved artifact's revision, so the replay takes both revisions from its caller |

Items the log carries no record of are absent from `TraceRecord` rather than emitted as placeholders. The rows the projection reads from another package's payload type (`context/compiled`, `task/plan`, `verification/result`, `todo/write`, `feedback/record`) contribute nothing when that plugin is not mounted: the projection then sees no such event and leaves its field empty.

### Credit assignment

Credit assignment (spec §3.2) is a deterministic proximity heuristic, never a model judgment: the failing call ranks first, then the same-step calls before it (its input producers), then the previous step's calls (the context producer), then retrieval calls named `skill` or `memory` that may have missed, then the turn's request. An analyst can later replace the ranking with measured attribution; the schema is stable either way.

### Compression

`summarize` compresses one record into a learning-trace row: counts, summed tokens and latency, and the distinct failure gists in first-occurrence order. `summary` sorts rows most decisive first — most failures, then retries, then billed tokens, then newest — so a consumer sees the sessions with the most to learn from ahead of the limit.

### Counterfactual replay

`replayTrace` answers §16's question at the fidelity the trace supports: what would this run have produced under the baseline revision versus the candidate revision? The recorded tool results are the substrate — no tool is re-invoked, no model is called, and nothing is written, so a replay is keyless and deterministic over the same trace.

Reconstruction reads the trace itself: the context digest each step recorded, and the artifact both revisions name. The artifact's observable effect is the retrieval surface. Where the trace recorded a retrieval whose target is an artifact a revision names **and whose result was recorded**, the replayed output is the restored body; every other call replays from its recorded snapshot. Each step therefore reports per call where its output came from — `snapshot`, `artifact`, or `missing` — and the report names the steps replayed from snapshots alone, the steps the candidate changes, and the steps the replay could not reconstruct.

The snapshot gates replayability. A call whose result the log recorded no text for has no substrate, so its step is `unreplayable` under both revisions and is never reported as unchanged: an artifact body deliberately does not stand in for it, because that would be a guess about what the recorded run saw. Restoring writes nothing — the restored body lives in the report, not on disk, and a caller that wants artifact state in a live workspace owns that write.

### Failure and recovery

A session storage holds no log for reads as absent and contributes nothing to `summary`; any other persistence failure stays fail-loud. `replay` returns `undefined` for a session storage holds no log for, the same contract as `trace`. Malformed or duplicated log structure (a re-opened turn, an unpaired tool call or result, an event for a step that never opened, a second closer for a span already closed) is dropped by the projection rather than corrupting the record; the raw log retains everything for audit.

No invariant companion is published because the session log is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) — the trajectory, credit-assignment, compression, counterfactual (§16) and replay (§17) mechanism families this package implements.
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
- **Artifact versions are not in the session log** — no logged event records a retrieved artifact's revision, so the trace cannot carry one and the replay takes both revisions from its caller as `ReplayArtifact`. A caller who restores the wrong revision gets a comparison of the wrong pair, and nothing here can detect that.
- **Arguments are not retained** — the structured trace keeps call identity, tool name, and result gist, but not the raw tool arguments; the session log retains them for audit. The one exception is a retrieval call's target, which is read out of the arguments to name what was retrieved.
- **Gists are clipped, not summarized** — a failure keeps its first `maxChars` characters, and so does every recorded tool-output snapshot, request, retrieval target and final answer, so two different long values can collide on one gist.
- **Context is carried as an identity, not content** — the trace keeps the compilation `digest`, not the prompt text a placement was built from; that text stays on the log's own `system/message` surface.
- **Interleaved steps are not part of the shape** — a compilation or plan record binds to the single step or turn open when it arrives. The harness runs one step at a time, so this is how real logs behave; a log with genuinely concurrent steps would bind such a record to only the most recent one.
- **Replay reaches only the retrieval surface** — the artifact's observable effect is the output of a retrieval naming it. A candidate whose difference does not change a retrieved artifact's output replays as identical to the baseline, which is the module's fidelity ceiling rather than a claim that the two revisions behave alike.
- **Replay compares output, not quality** — it reports where the two revisions differ and where a step could not be reconstructed; it never decides which revision is better. Deciding that needs the scorer's metric triple over a corpus.
- **No live bus consumers yet** — the projection and replay read paths are the current surface; turn-settled emission and its learning-system consumers land with the curriculum and shadow/canary work (P1).
- **Machine-local only** — reads resolve against the local session persistence, never a remote store.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`command-evolution` is the only current consumer (the `/trace` command). The summary ordering is deliberately decision-oriented (failures first) so the compressed rows feed a future curriculum or shadow runner without re-deriving priorities.

The replay path is a pure function over one already-projected record, so the trace store stays read-only over the session log: `replayTrace` writes nothing and touches no workspace. It is deliberately not the scorer's process runner — that one boots fresh subprocesses against on-disk fixtures, while this one compares two revisions over a trace the log already holds.

`SCORER_VERSION`-style versioning is not needed here: a trace has no schema version because the projection is derived on every read, so a change to what it carries takes effect immediately rather than needing a stamp. A consumer persisting a derived projection is the one that would need a version.

</details>