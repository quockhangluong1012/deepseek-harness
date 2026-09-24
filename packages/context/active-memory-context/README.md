---
description: "Proactive per-turn memory search: injects semantically relevant past-session snippets into agent pre-step before the model responds, for hosts composing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-active-memory-context

English | [中文](README.zh.md)

## Summary

`dsh-active-memory-context` searches other sessions in the same workspace with the user's newest message before the model responds, and splices the relevance-filtered results into `agent/pre-step` — proactive retrieval instead of the user having to ask "search past sessions". It complements `dsh-evolution-memory-context`, which injects a static per-scope brief that never depends on what the user just asked; this package injects a different result every turn, keyed to the turn's own content. Given `ctx.evolutionGraph`, a second leg follows the graph's connections from the entities the turn names. Choose it when prior sessions should surface automatically.

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

Mount the plugin with the workspace registry and a session-query backend whose vector channel is populated (an embeddings service, e.g. `dsh-embeddings-http`, mounted behind `dsh-session-query-sqlite`). Scopes resolve per turn from workspace membership (registry session ids, falling back to a canonical-path `cwd` match); turns outside any workspace, or in a workspace with no other session, add nothing. A mount that also provides `ctx.evolutionGraph` gains the graph leg below; without it the brief holds the vector leg's own hits — one line per session, in fusion order.

When `@deepseek-ai/dsh-agent-context` is mounted, it also records logged active-memory briefs as untrusted delta sources; each item appears once until compaction clears the placement. The existing pre-step messages remain unchanged in shadow mode.

### Retrieval-configuration record

When `ctx.evolutionRetrieval` is mounted, the injector records the retrieval configuration it runs under for each session, once, at that session's first step: the §39 dimensions this mount sets (retrieval source, graph depth, and the active-memory threshold) beside the shipped choice for the rest. It is a side record — a structural seam read with `ctx.get`, one unawaited write per session, no model call, no prompt change, so the brief is identical with and without that store and a store that rejects the write only logs a debug line. `dsh-evolution-retrieval` turns those records into a per-task-class recommendation; leaving it unmounted records nothing. It describes this mount, never a recommendation the task-aware policy applied to one turn: that is on the brief itself, below.

### Task-aware retrieval policy

With `taskAwarePolicy: true`, an eligible turn retrieves under the §39 configuration `dsh-evolution-retrieval` recommends for the turn's task class, instead of the configuration this mount's own fields spell. The task class comes from recorded evidence rather than from the turn's text: it is a skill whose usage record lists this session (`ctx.evolutionSkillTelemetry`), which is the same task-class axis that store grades a session on. A session that recorded several skills has several classes; the injector asks the store for each in name order and runs the highest-scoring recommendation of the ones above the store's evidence gate.

The dimensions this injector owns take the recommended value — the retrieval lane (`graph` becomes `graph-first`, `hybrid` becomes `both`), the memory scope when it is `workspace`, the graph depth, and the active-memory threshold. Every dimension it cannot serve is recorded as unapplied, with the reason, rather than silently dropped: `queryExpansion`, `weights`, `reranker`, and `mmr` are the shipped choices here, and a source of `vector` or a scope of `session`/`global` leaves the mount's own lane and scope in place.

The applied policy rides the injected brief's own durable record — the `policy` field of its `active-memory` source — so the session log reconstructs which dimensions produced the brief, and a turn that fell back carries no such field. Everything else is unchanged: off (the default), the brief is byte-identical to a mount that never set the field; the configuration-in-force record above is still written; and an unmounted telemetry store, a store with no recommendation above its evidence gate, and a session no skill recorded all fall back to the mount's own configuration with a debug line saying so. The policy calls no model.

### Configuration

`maxBytes` is required: the deployment must choose what a brief may cost, the same discipline `dsh-evolution-memory-context` applies to its own brief.

```yaml
- name: '@deepseek-ai/dsh-active-memory-context'
  config:
    maxBytes: 4096
```

| Field | Default | Meaning |
|---|---|---|
| `maxBytes` | required | Cap on the complete emitted text including the frame |
| `topK` | `5` | Candidate results ranked per search, before the relevance threshold |
| `relevanceThreshold` | `0.7` | Minimum cosine similarity a hit must clear to be worth injecting |
| `turnInterval` | `1` | Turns between active-memory searches |
| `escalation` | `both` | Lanes per eligible turn: `both` runs vector and graph legs every turn; `graph-first` runs the local graph leg first and spends the vector leg's embedding call only when the graph leg returns nothing |
| `profile` | `default` | Scope-identity namespace the graph leg reads; must match the profile the scope's graph was extracted under |
| `graphDepth` | `1` | Hops the graph leg expands from the entity it matched |
| `graphLimit` | `5` | Turn-leading words the entity scan tries, entities one `expand` may return, and labels the expansion may seed searches with |
| `taskAwarePolicy` | `false` | Consult the §39 configuration `ctx.evolutionRetrieval` recommends for the turn's recorded task class and run the dimensions this injector owns; off, every turn runs the configuration this mount's fields spell |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-active-memory-context) is the exhaustive source for every accepted field.

### Why a relevance threshold, not just a result count

A nearest-neighbor vector search always answers with its closest candidates, however far they actually are — there is no "no match" case built into cosine similarity. `topK` alone would silently inject an off-topic turn's "closest" memories as if they were relevant. `relevanceThreshold` is the quality gate the spec calls for: a hit only surfaces once it clears the threshold, on the same 0–1 cosine scale the mounted embedding model itself produces. Recalibrate the threshold after switching embedding providers or models, since the scale is meaningful only within one model's own vector space.

### Cost and cadence

Every eligible turn runs one semantic search (an embedding call for the query, plus whatever documents the vector store does not already hold — see `dsh-session-query-sqlite`'s lazy embedding design). The graph leg adds no embedding call and no model call: it is label lookups against the local graph plus at most `graphLimit` text searches on the corpus the turn already searches. That lexical channel is the same opt-in the vector leg needs: both shipped compositions mount `dsh-session-query-sqlite` with `openAt: never`, where each label search throws `SESSION_QUERY_SEARCH_DISABLED` and the graph leg contributes nothing until content search is enabled. `turnInterval` throttles that cost the same way `dsh-evolution-memory-context`'s nudge intervals do: a session with no observed `turn/start` yet counts as turn 0 and reads as its first turn, so `turnInterval: 1` searches on the very first turn. A retried step for the same observed turn never re-searches: the injector remembers the last turn it searched for.

### Escalation lane

`escalation: graph-first` runs the cheap local graph leg before the vector leg and skips the vector leg — saving its query embedding call — whenever the graph leg already connected the turn to at least one session. An unmounted, inapplicable, or empty graph leg returns nothing, so the vector leg runs exactly as it would have without escalation. The tradeoff is recall shape, not just cost: a skipped vector leg cannot surface a session only similarity would have found, so the brief holds the graph leg's connections alone. The default `both` preserves the historical behavior of running both legs every eligible turn.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

At each `agent/pre-step`, the injector reads the text of the proposed step's own messages (not whatever an earlier listener already appended, so a search never uses another package's injected brief as its own query), resolves the session's workspace, and — unless the search is off cadence or was already run for this observed turn — calls `ctx.sessionQuery.searchSessionsSemantic` scoped to the workspace's other sessions (the current session is always excluded, so a session can never surface its own just-submitted message as its own "relevant memory"). Hits below `relevanceThreshold` are dropped; the survivors render into one framed `user/message` and append to the step, bounded by `maxBytes`, weakest hits dropped first when the budget is tight. Under `escalation: graph-first` the graph leg below runs first instead, and this vector call happens only when it returns nothing.

A vector-channel failure (`SESSION_QUERY_SEMANTIC_UNAVAILABLE`, `SESSION_QUERY_SEARCH_DISABLED`) degrades to no injection rather than blocking the turn; any other failure propagates, since it signals a genuine defect rather than an expected deployment state.

With `taskAwarePolicy` on, the turn's recorded task class is looked up before the legs run and the recommendation it names replaces the mount's lane, graph depth, and threshold for that turn alone; the pure `applyRetrievalPolicy` decides which dimensions that is and which ones this injector must report unapplied. Nothing else about the step changes: the same cadence, the same scope, the same fusion, the same rendering, with the applied policy carried on the injected message's source.

When a mount provides `ctx.evolutionGraph`, a second leg searches by connection instead of similarity. The graph matches labels, so a whole turn is not a usable query: the leg scans the turn's own leading words — at most `graphLimit` of them — and takes the first the scope's graph knows, expands it `graphDepth` hops, and searches the same session corpus by text once per reached label, labels capped at `graphLimit`. These hits come back unscored, because their relevance is a connection rather than a distance, and the brief labels them `via graph connections` instead of inventing a similarity. The two legs fuse by reciprocal rank: a session both legs found outranks one only a single leg found, and since fusion keys by session id the brief carries one line per session where two documents of one session both qualified. The graph is reached through `ctx.get('evolutionGraph')`, so an unmounted, older, or failing graph leaves the brief to the vector leg's own hits — the same sessions, one line each, in fusion order. The graph leg resolves its scope from registry membership alone, so a session the vector leg matched only through its canonical-path `cwd` fallback gains no graph leg.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: pre-step search, workspace membership, turn cadence, relevance filtering, the graph leg, rank fusion, the retrieval-configuration record, and the task-class lookup the policy runs on |
| [`src/policy.ts`](src/policy.ts) | Pure task-aware policy: which §39 dimensions a recommendation applies and which this injector reports unapplied |
| [`src/render.ts`](src/render.ts) | Pure brief rendering within the byte budget |

### Failure and recovery

Missing or unresolvable workspace membership, an empty query, an off-cadence turn, a below-threshold result set, a graph that is unmounted or holds nothing for the scope's profile, and a brief that does not fit `maxBytes` all degrade to no injection — or to the vector leg's hits alone — rather than failing the step. An unmounted `ctx.evolutionRetrieval`, or one that rejects the configuration record, changes neither the search nor the brief: the record is a side write, debug-logged when it fails. The same holds for every way the task-aware policy can find nothing to apply — no telemetry store, a store with no `recommend`, a session no skill recorded, a class with no recommendation above the evidence gate — and each is debug-logged too, because a fallback the operator cannot see is indistinguishable from a policy that never ran. No invariant companion is published because the injector owns no durable state of its own: membership and turn counters are process-local caches rebuilt from `ctx.workspaceRegistry` and observed session events, never the source of truth.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md) — the reference vocabulary and behaviour contract of the self-learning harness this package's Active Memory sub-agent belongs to.
- [dsh-session-query](../../session-query/session-query/README.md) — the search service this package calls; see its vector-channel section for how relevance scores are produced.
- [dsh-evolution-memory-context](../evolution-memory-context/README.md) — the sibling static per-scope brief injector; read both to see why they are two packages, not one.
- [dsh-evolution-graph](../../evolution/evolution-graph/README.md) — the knowledge graph whose labels seed the second search leg.
- [dsh-evolution-retrieval](../../evolution/evolution-retrieval/README.md) — the store the optional retrieval-configuration record feeds, and the recommendation it derives per task class, which the task-aware policy consumes.
- [Session Query subsystem reference](../../../docs/subsystems/session-query.md) — the full type-level search contract.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

One `user/message` per eligible turn, when a relevant hit survives filtering: a framed block naming each surviving session, its match timestamp, and a snippet of the matching text, each line noting either the hit's cosine similarity or `via graph connections` for an unscored hit reached through the graph.

##### Verbatim text for this field, when needed

```markdown
<system-reminder>
Relevant memory found in earlier sessions in this scope:
1. [session <id> @ <timestamp>, similarity <score>] <snippet>
2. [session <id> @ <timestamp>, via graph connections] <snippet>
</system-reminder>
```

#### Token effect

Bounded by `maxBytes`; zero when no hit clears `relevanceThreshold`, the turn is off cadence, or the session has no resolvable workspace.

#### KV Cache effect

Varies with the turn's own content by design: this is proactive retrieval keyed to what the user just asked, not a digest-gated static brief. It is appended after the turn's own messages, so it never disturbs a stable prefix from earlier turns.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Turn cadence counts process-observed turns** — the interval counter starts at plugin load and clears on session disposal, so a resumed session begins again from its first observed `turn/start`, the same limitation `dsh-evolution-memory-context` documents for its own nudge cadence.
- **One embedding call per eligible turn** — cost scales with `turnInterval`; there is no cross-turn result cache, since the query differs every turn by design. `escalation: graph-first` skips the call on turns the graph leg already answers, at the cost of similarity-only recall on those turns.
- **Workspace-scoped only** — a session outside any workspace, or the sole session in one, never receives active memory.
- **The policy needs a recorded task class** — it runs only for a session some skill's usage record lists, and only on turns a search is due; a session that loaded no skill runs the mount's configuration. A recommendation that varies `queryExpansion`, `weights`, `reranker`, or `mmr` is applied only where this injector has the dimension, and the rest is recorded unapplied instead of approximated.
- **The attribution keeps this mount's configuration, not the recommendation** — the once-per-session record describes the configuration the mount spells, so a session that also ran a recommended configuration is attributed to the mount's alone. Splitting it needs per-turn attribution across turns that can change task class mid-session, which the store's one-configuration-per-session model does not have; the applied configuration is on each brief instead.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`escapeFrameBody` rewrites a literal `</system-reminder>` found inside a snippet, because past-session text is not repository-controlled and the memory this package injects must never be able to close the frame that delimits it — the same defense `dsh-evolution-memory-context` applies to its own frame. The graph leg skips query tokens shorter than three characters, since `graph.find` is a substring match: seeding on `in` or `is` would spend the whole label budget on the most connected label that happens to contain those letters. The byte budget is met by rebuilding the framed text from the best-first prefix and dropping the weakest trailing hit, never by truncating a single line, and a brief where even one hit does not fit is `undefined`, which the caller reads as no injection rather than as an empty message.

</details>
