---
description: "Evolution background review with per-turn output indexing, gated lessons extraction, and on-demand rebuild (ctx.evolutionReviewer), for hosts composing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-reviewer

English | [中文](README.zh.md)

## Summary

`dsh-evolution-reviewer` derives evolution lessons from live Sessions without ever blocking a turn: it buffers the current turn's events as they arrive, indexes produced files at `turn/end`, recalls ranked prior work from the scope directory into the brief, and enqueues a gated deterministic extraction that rewrites the scope's lessons document — directly, or staged for approval when `writeApproval` is on. `rebuild` regenerates lessons from history through the asynchronous session query seam. Choose it when a scope's lessons should track what its Sessions actually do.

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

Mount the plugin with the memory store and a workspace registry. Scopes resolve per turn from workspace membership (registry session ids, falling back to a canonical-path `cwd` match) under the configured `profile`; turns outside any scope index and extract nothing.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-evolution-reviewer'
  config:
    profile: default
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Completed turns trigger extraction; output indexing always runs |
| `profile` | `default` | Scope-identity namespace placed before the workspace key |
| `minTurnTextBytes` | `200` | Trivial turns below this admitted-text size skip extraction |
| `cooldownMs` | `60000` | Minimum gap between two extractions for one scope |
| `defer` | `auto` | `auto` queues a gated turn for later; `never` extracts at turn end |
| `deferMaxAgeMs` | `1800000` | Age ceiling of a queued turn, measured from its session's first snapshot |
| `maxInputBytes` | `131072` | Transcript budget per call, oldest dropped first |
| `maxOutputTokens` | `1024` | Output token cap per call |
| `timeoutMs` | `60000` | Call deadline |
| `rebuildSessionLimit` | `20` | Sessions scanned by a rebuild |
| `recallLimit` | `20` | Ranked recall results selected per search, for sessions and for events |
| `recallQueryChars` | `160` | Cap on the recall query derived from a turn's newest human message |
| `squeezeBytes` | `65536` | Byte budget the squeezed lessons document must fit; keep at or below the store's `maxAgentBytes` |
| `squeezeOrder` | `References, Decisions, Preferences, Purpose` | Pressure order: the heading whose body clears first comes first |
| `outputTools` | `write,edit,str_replace_editor` | Successful tool calls that count as productions |
| `provider`/`model` | unset | Route override; both or neither, else the session route applies |
| `writeApproval` | `false` | Background extractions stage for approval instead of writing |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-reviewer) is the exhaustive source for every accepted field.

### Writing and approval

Turn extraction stores the whole lessons document as one coarse artifact — the squeezed text as its statement — with `background_review` provenance. Under `writeApproval` the same document stages as a `replaceArtifacts` op for `/memory approve` instead, and only an explicit `rebuild` (provenance `rebuild`) keeps writing directly. A failed extraction warns and keeps the previous document; teardown and session disposal abort in-flight calls.

### Lean squeeze

Between the extractor and the store, `squeezeLessons` reduces the model's output to the four memory headings: prose before the first heading and lines under any other heading are dropped. When the result still exceeds `squeezeBytes`, bodies clear whole one heading at a time in `squeezeOrder` — the first heading listed goes first — and the last body still standing is clipped at a UTF-8 boundary. The stored document is flagged `truncated` whenever material was lost this way. A `squeezeBytes` set above the store's own `maxAgentBytes` does not survive that cap either, because the cap measures the serialized artifact array, in which the statement appears twice — as `statement` and as the normalized identity keying it — inside a fixed envelope. The retry therefore solves for the longest statement prefix whose artifact fits, searching the prefix length against the store's own reported measurement rather than assuming the text budget equals the cap.

### Ranked recall

While background review is enabled, each observed turn derives a recall query from its newest human message and asks the ranked, directory-scoped search seam for candidate sessions, skipping the asking session itself. A candidate is resolved to its event and admitted through the same rule the transcript uses, so injected briefs and instruction messages are never recalled back. The strongest admitted hit lands as the scope's single context item labelled `Recall: <sessionId>` — replaced when it changes, left alone when it does not — and the brief renders it last, so it drops first under pressure. No search seam means no recall item.

### Rebuild and defer

A rebuild selects its material the same way: the scope's newest observed human request drives a ranked, directory-scoped `searchSessions`, each ranked session's events come back through `searchEvents`, and every selected event passes the shared admission rule before it is framed. Rows accumulate least-relevant-first, so the transcript byte cap drops recall rather than the strongest match. An absent or partial search seam, an empty ranked result, a failing search, or a scope with no observed turn falls back to the exact `readSurface` scan.

Under the default `defer: auto`, a gated turn waits in an in-memory per-session queue instead of extracting at `turn/end`. Turns that close before the flush coalesce: the newest snapshot replaces the queued one while the first snapshot's `deferMaxAgeMs` deadline and timer stand, so a busy session cannot postpone its extraction indefinitely. Disposal and teardown drop queued turns without extracting them; `defer: never` restores the immediate turn-end extraction.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The reviewer observes `session/event` and buffers the current turn's admitted rows and tool outcomes per session, flushing the buffer at `turn/end`. Nothing scans session history synchronously: resumed sessions contribute their observed suffix, and rebuilds select their material through `sessionQuery`'s ranked search, falling back to the exact `readSurface` scan when the ranked seam is absent or empty. One scope never runs two extractions at once: the immediate path and a due defer flush both enqueue on the per-scope promise chain, which drops superseded entries when turns overlap. The defer queue itself holds one coalesced snapshot per session, keyed to that session's first snapshot's deadline.

`admittedRow` is the only admission rule: the live buffer, the exact rebuild scan, and every ranked recall candidate pass through it, so an injected brief or instruction message never becomes transcript or recall material.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `EvolutionReviewer` service, turn buffering, gating, ranked recall, rebuild |
| [`src/prompt.ts`](src/prompt.ts) | Extraction system prompt, JSON input framing, UTF-8 clipping |
| [`src/squeeze.ts`](src/squeeze.ts) | Lean squeeze: heading collection, pressure order, UTF-8 clipping |

### Failure and recovery

Extraction routes resolve from the configured pair, else the session's last request header; a turn with neither skips with a warning, while a rebuild without a route rejects. `error` and `aborted` finishes throw into the warning path; `max-tokens` is tolerated as `truncated`; tool-call blocks and any other finish reject. Model calls run at `temperature: 0` with `purpose: 'evolution-review'`, so reasoning stays disabled and usage attributes to the review task. Recall failures and a store rejection of a recalled item warn instead of failing the turn, and the previous context survives.

No invariant companion is published because the reviewer owns no durable state of its own: buffers and chains are in-memory scheduling, and the store's domain table is the only durable copy.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness.spec.md) — the behaviour contract this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-reviewer) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

The extraction call sends the framed transcript plus the current lessons document as one auxiliary user message with a lessons system prompt.

##### Verbatim text for this field, when needed

```markdown
You distill durable lessons for an agent scope from one turn of conversation.
```

#### Token effect

Capped: one auxiliary request per gated turn, bounded by `maxInputBytes` of transcript plus the lessons document, and `maxOutputTokens` of completion. Recall adds one indexed search per observed turn and at most one context item to the scope record; its material reaches the model only through the next brief.

#### KV Cache effect

Independent of live requests: the extraction is a separate one-shot model call with its own prefix, so it cannot invalidate provider cache reuse on the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the reviewer is a poor fit. They are current package constraints.

- **Lessons only** — extraction rewrites `agentLessons`; the user profile stays hand-authored until the controller slice arrives.
- **No subagent review fork** — extraction runs in-process on the per-scope chain; delegated background agents with tool whitelists are deferred.
- **Queued turns are in-memory** — a restart or teardown before the `deferMaxAgeMs` deadline drops them instead of persisting the snapshot.
- **Turns in flight at mount** — sessions already mid-turn when the reviewer loads extract from their observed suffix.
- **Recall needs the ranked seam** — without `sessionQuery` a rebuild rejects; without its ranked readers, recall writes nothing and rebuilds fall back to the exact surface scan.
- **One recall item per scope** — a changed hit replaces the previous item and changes the record digest, so the next brief is a fresh one; an unchanged hit rewrites nothing.
- **Recall queries are literal phrases** — the search backend matches the derived query as data, so a query that never appeared verbatim in an indexed session returns no candidate.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
