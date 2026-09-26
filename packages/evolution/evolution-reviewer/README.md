---
description: "Evolution background review with per-turn output indexing, gated lessons extraction, and on-demand rebuild (ctx.evolutionReviewer), for hosts composing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-reviewer

English | [中文](README.zh.md)

## Summary

`dsh-evolution-reviewer` derives evolution lessons from live Sessions without blocking a turn: it buffers the turn's events, indexes produced files at `turn/end`, recalls ranked prior scope work into the brief, and enqueues a gated extraction answering `confirms` / `contradicts` / `new` against a relevance-bounded artifact slice, applied directly or staged under `writeApproval`. A failing tool call gets §5's refinement-loop `critique` naming the violated expectation, failure, and correction, and the revision it licenses is recorded. `rebuild` folds history into the same artifacts. Choose it when lessons should track what its Sessions do; each gated turn costs a model call.

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
| `maxOutputTokens` | `2048` | Output token cap per call, sized for a turn producing roughly ten decisions |
| `relevantArtifactLimit` | `20` | Most artifacts one call shows the model, ranked most relevant first |
| `timeoutMs` | `60000` | Call deadline |
| `rebuildSessionLimit` | `20` | Sessions scanned by a rebuild |
| `recallLimit` | `20` | Ranked recall results selected per search, for sessions and for events |
| `recallQueryChars` | `160` | Cap on the recall query derived from a turn's newest human message |
| `outputTools` | `write,edit,str_replace_editor` | Successful tool calls that count as productions |
| `provider`/`model` | unset | Route override; both or neither, else the session route applies |
| `writeApproval` | `false` | Background extractions stage for approval instead of writing |

`maxOutputTokens` sizes a decision batch rather than a document: each `new` candidate carries a full artifact, each `confirms` or `contradicts` is a few tokens, and `2048` covers a turn producing on the order of ten decisions. A busier scope raises it.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-reviewer) is the exhaustive source for every accepted field.

### Structured decisions

One extraction call shows the model the `relevantArtifactLimit` most relevant artifacts of the scope, numbered from 1, beside this turn's transcript, and expects a JSON array of decisions:

| Action | Meaning |
|---|---|
| `confirms` | The artifact listed at that index is upheld by this turn — a `validationCount` bump |
| `contradicts` | The artifact listed at that index is contradicted — a `refutationCount` bump, optionally with a corrected statement and confidence |
| `new` | A fact no listed artifact covers — the full candidate fields, with `source` taken from the extracting session |
| `critique` | A critique of this turn — the violated expectation, the failure, and the correction, with the revision's confidence and scope. Allowed only when the transcript records a failed tool call |

An empty array is the model reporting nothing and is a common answer. The model addresses artifacts by the ordinal it was shown and never by id; the reviewer resolves each index back to a real artifact id from the exact list it sent, so no index-based value reaches a staged payload or the store. A decision naming an index outside the list sent is dropped with a warning, and an unreadable answer warns and leaves the stored artifacts as they were.

The turn's whole batch is one write. `applyExtractionDecisions` folds it in decision order against the record read at write time, and the store checks the lessons cap on that one result: a batch past the cap drops its longest `new` statement and retries, then drops the contradictions' replacement statements while keeping their counter bumps, and propagates the rejection once there is nothing left to drop.

### Self-refine critique

A turn whose tool call failed is a draft worth critiquing, so the extraction call carries both halves of §5's `draft → critique → revise` loop:

| Loop stage | What it is |
|---|---|
| Draft | The turn's transcript: the human and assistant rows it always carried, plus one `tool` row per failing tool result, `<tool name>: <recorded result text>` |
| Critique | The model's `critique` decision, recorded as a scope context item labelled `Critique: <sessionId>` and naming the violated expectation, the failure, and the correction |
| Revise | The correction the critique licenses, recorded as a `new` lesson artifact: the correction as its statement, the failure as its `conditions`, `inference` as its evidence, and the model's own confidence and scope |

Both halves come out of the one call the gated turn already made — no second model call, no second prompt, and no prompt input the session log does not already hold. The critique reaches later turns through the brief like any other context item, and the store's digest covers context items, so the injection is reconstructable from the session log.

The pass reads only what the critique needs, and it widens nothing: the turn's admitted rows and its own recorded failing tool results, the relevance-bounded artifact statements of the scope, and the `sessionQuery` seam the recall and rebuild paths already use. It makes no tool calls, reads no other store, and — because tool results are what it already buffers for output indexing — gained no new seam to do this. Failing calls contribute their name and their recorded result, never their arguments.

Two gates decide whether a critique is recorded: the transcript the call sent must contain a `tool` row, and the critique must name all three of the expectation, the failure, and the correction. A critique failing either gate is dropped with a warning while every decision beside it still applies, so an ungrounded critique costs itself and never the batch. The critique item is written directly even when `writeApproval` stages the decisions beside it: it is the reviewer's own reading of a recorded turn, like a recall item, not a proposed change to the stored artifacts. A store rejection of that item warns and keeps the revision.

### Writing and approval

Turn extraction stages the batch as one `applyDecisions` entry per call when `writeApproval` is on, so `/memory approve <id>` applies the whole batch atomically against the record read at approval time. Tainted content always stages: when the prompt-injection guard recorded a `security/scan` with `tainted: true` for the session, every `new` candidate in the batch carries `trust: 'untrusted'` and the batch is staged whatever `writeApproval` says, because taint reaches durable memory only through an approval. A rebuild (extraction `rebuild`) always writes directly, as does a batch with nothing to approve in it. A failed extraction warns and keeps the stored artifacts; teardown and session disposal abort in-flight calls.

### Relevance window

Every extraction call ranks the scope's artifacts against the turn's text and shows the model only the most relevant `relevantArtifactLimit` of them. With `ctx.embeddings` mounted, the turn text and every artifact statement are embedded in one batch and ranked by cosine similarity; with none mounted, when the batch throws, or when it answers without a query vector, ranking falls back to most-recently-updated first. Ranking never fails an extraction.

The window bounds cost and required output regardless of scope size, and it costs completeness: an artifact this turn's text does not bring into the window is never confirmed by this call, so it ages under the store's `defaultTtlDays` unless a later turn ranks it back in.

### Ranked recall

While background review is enabled, each observed turn derives a recall query from its newest human message and asks the ranked, directory-scoped search seam for candidate sessions, skipping the asking session itself. A candidate is resolved to its event and admitted through the same rule the transcript uses, so injected briefs and instruction messages are never recalled back. The strongest admitted hit lands as the scope's single context item labelled `Recall: <sessionId>` — replaced when it changes, left alone when it does not — and the brief renders it last, so it drops first under pressure. No search seam means no recall item.

### Recall grading

When the optional kernel is mounted, a `verification/result` event settles §23's `helped outcome` link for the recall this session's own extraction bound: `pass` grades `ok`, `fail` grades `failed`, and `unknown` grades nothing — it is not a decisive signal either way. Only a recall whose bound decision batch was extracted from the verified session is graded, so an outcome never lands on a recall some other session's turn left pending; `applyExtractionDecisions` is what records that binding as `decidedInSessionId`. A store rejection — the recall was graded or removed between the read and the write — warns and settles nothing else. Without the kernel mounted, or before a session reaches a compiled verification outcome, a recall stays ungraded: §24's utility reading over it counts the retrieval and the decision link, never the outcome.

### Rebuild and defer

A rebuild selects its material the same way: the scope's newest observed human request drives a ranked, directory-scoped `searchSessions`, each ranked session's events come back through `searchEvents`, and every selected event passes the shared admission rule before it is framed. Rows accumulate least-relevant-first, so the transcript byte cap drops recall rather than the strongest match. An absent or partial search seam, an empty ranked result, a failing search, or a scope with no observed turn falls back to the exact `readSurface` scan. A rebuild then folds the batch it produces into the artifacts already stored, exactly as a live turn does, instead of replacing them.

Under the default `defer: auto`, a gated turn waits in an in-memory per-session queue instead of extracting at `turn/end`. Turns that close before the flush accumulate into one snapshot instead of replacing it: their rows append in turn order while the first snapshot's `deferMaxAgeMs` deadline and timer stand, so a busy session cannot postpone its extraction indefinitely, and an oversized snapshot loses only its oldest rows to `maxInputBytes`. Disposing a session flushes its queued turns rather than dropping them; plugin teardown drops them, because the reviewer's own services unload with it. `defer: never` restores the immediate turn-end extraction.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The reviewer observes `session/event` and buffers the current turn's admitted rows and tool outcomes per session, flushing the buffer at `turn/end`. Nothing scans session history synchronously: resumed sessions contribute their observed suffix, and rebuilds select their material through `sessionQuery`'s ranked search, falling back to the exact `readSurface` scan when the ranked seam is absent or empty. One scope never runs two extractions at once: the immediate path, a due defer flush, and an explicit `rebuild` call all enqueue on the same per-scope promise chain, which drops superseded entries when turns overlap. A rebuild queued behind a live turn's extraction still reports its own success or failure to its caller — the chain link itself never rejects, so one queued entry's failure never blocks the next. The defer queue itself holds one coalesced snapshot per session, keyed to that session's first snapshot's deadline.

`admittedRow` is the only admission rule: the live buffer, the exact rebuild scan, and every ranked recall candidate pass through it, so an injected brief or instruction message never becomes transcript or recall material.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `EvolutionReviewer` service, turn buffering, gating, ranked recall, rebuild, index resolution, batch write |
| [`src/protocol.ts`](src/protocol.ts) | Extraction system prompt, request framing with the indexed artifact list, decision schema and parser |
| [`src/relevance.ts`](src/relevance.ts) | Relevance-bounded selection: similarity ranking through the optional embeddings seam, recency fallback |

### Failure and recovery

Extraction routes resolve from the configured pair, else the session's last request header; a turn with neither skips with a warning, while a rebuild without a route rejects. `error` and `aborted` finishes throw into the warning path; `max-tokens` is tolerated as `truncated`; tool-call blocks and any other finish reject. Model calls run at `temperature: 0` with `purpose: 'evolution-review'`, so reasoning stays disabled and usage attributes to the review task. An extraction is budget-gated when `ctx.evolutionBudget` is mounted: it opens the scope's daily and weekly ceiling before the model is asked and settles its tokens and wall time against both, and a spent ceiling refuses the call with a warning — `openCeiling`'s — leaving the stored artifacts untouched and no request made. Recall failures, a critique item the store rejects, and a store rejection of a recalled item warn instead of failing the turn, and the previous context survives.

No invariant companion is published because the reviewer owns no durable state of its own: buffers and chains are in-memory scheduling, and the store's domain table is the only durable copy.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md) — the behaviour contract this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-reviewer) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

The extraction call sends one auxiliary user message holding this turn's transcript as JSON plus the numbered list of the relevant artifacts' statements, with a lessons system prompt. A failing tool result appears in that transcript as a `tool` row naming the tool and the result it recorded; the answer may then add one `critique` per recorded failure beside the usual decisions.

##### Verbatim text for this field, when needed

```markdown
You distill durable lessons for an agent scope from one turn of conversation.
```

#### Token effect

Capped: one auxiliary request per gated turn or defer flush, bounded by `maxInputBytes` of transcript — failing tool results included — plus the `relevantArtifactLimit` artifact statements, and `maxOutputTokens` of completion. A critique adds a few tokens to that same answer rather than a request of its own. With `ctx.evolutionBudget` mounted, an extraction also opens the scope's daily and weekly ceiling first and settles its spend against both, so a spent ceiling buys no request at all. Recall adds one indexed search per observed turn and at most one context item to the scope record; its material reaches the model only through the next brief, and a recorded critique reaches it the same way, as one more context item.

#### KV Cache effect

Independent of live requests: the extraction is a separate one-shot model call with its own prefix, so it cannot invalidate provider cache reuse on the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the reviewer is a poor fit. They are current package constraints.

- **Lessons only** — extraction writes `agentLessons`; the user profile stays hand-authored until the controller slice arrives.
- **No subagent review fork** — extraction runs in-process on the per-scope chain; delegated background agents with tool whitelists are deferred.
- **Queued turns are in-memory** — a restart or teardown before the `deferMaxAgeMs` deadline drops them instead of persisting the snapshot.
- **Turns in flight at mount** — sessions already mid-turn when the reviewer loads extract from their observed suffix.
- **Recall needs the ranked seam** — without `sessionQuery` a rebuild rejects; without its ranked readers, recall writes nothing and rebuilds fall back to the exact surface scan.
- **One recall item per scope** — a changed hit replaces the previous item and changes the record digest, so the next brief is a fresh one; an unchanged hit rewrites nothing.
- **Recall queries are literal phrases** — the search backend matches the derived query as data, so a query that never appeared verbatim in an indexed session returns no candidate.
- **The window is not the whole store** — an artifact outside the relevance window is invisible to that call, so a still-true fact the window keeps missing decays under `defaultTtlDays` with nothing left to confirm it.
- **A batch is approved whole** — one staged entry per extraction call means a reviewer cannot accept a `confirms` while rejecting a `contradicts` from the same turn; the choice is the whole batch or none of it.
- **A contested fact keeps its identity** — a contradiction may replace an artifact's statement, but the artifact keeps the id every caller addresses it by, so the id no longer spells the statement it holds.
- **Critiques only follow recorded tool failures** — a turn that went wrong without a failing tool result gets no critique, and a failure the transcript byte cap dropped is invisible to the call that would have critiqued it, so its critique is deferred to whatever later turn still carries it.
- **A failure row is as long as the tool result** — the row carries the recorded result text verbatim, under the tool's own output cap and the transcript byte budget; the reviewer never clips it further, and no arguments of the failing call are read at all.
- **Every critique holds a context item** — recorded critiques occupy the scope's context roster and its capacity like any attached item, so on a scope filled to `maxContextItems` the revision is recorded while its critique item warns and is dropped.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
