---
description: "Knowledge-graph memory: durable per-scope entities and directed relations with bounded traversal, plus one deterministic extraction that turns text into triples (ctx.evolutionGraph)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-graph

English | [中文](README.zh.md)

## Summary

`dsh-evolution-graph` is durable knowledge-graph memory for one scope: entities and directed relations, traversed by connection instead of matched by similarity. Extraction is one `temperature: 0` call whose JSON answer is validated before anything is stored; the graph keeps labels, kinds, and relation names only, never the sentence a relation was read from. An entity seen again keeps its first label and gains the kind it lacked, and a relation seen again raises its count. Answer a named relation, expand an entity's neighbourhood breadth-first in both directions, or look entities up by label.

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

Mount the plugin, then record relations or read them back. Every scope keeps its own graph.

```ts
await ctx.evolutionGraph.observe(scope, [
  { from: 'Project X', relation: 'worked_on', to: 'Alice', toKind: 'person' },
])
ctx.evolutionGraph.answer(scope, 'Project X', 'worked_on')   // { subject, relation, objects }
ctx.evolutionGraph.expand(scope, 'Alice', 2)                  // neighbourhood, breadth-first
ctx.evolutionGraph.find(scope, 'project')                     // entities by label, most connected first
```

`observe` merges triples: a first sighting inserts, a repeat raises the relation's count, and a triple is dropped — counted in `skipped`, never thrown on — when a part normalizes to nothing or a cap is reached. `extract` runs one model call and merges what it returns.

The `/graph` command is the shipped consumer: `/graph "Project X"` lists an entity's connections, and `/graph "Project X" worked_on` answers one relation. A multi-word entity is quoted; an unquoted extra word is a usage error rather than a silent partial name.

The plugin also produces the graph. Mounted beside `dsh-evolution-heartbeat`, it buffers the text of each scope's user and assistant messages and registers the `evolution-graph-extract` task: every `intervalHours` the task extracts each scope that accumulated text since its last run and clears that scope's buffer as it goes. An idle scope therefore costs no model call. A mount with no heartbeat engine still observes, reads, and extracts on demand; only the automatic sweep is absent.

### Configuration

Caps, query bounds, the extraction route, and the automatic sweep's cadence and scope namespace are validated `Config` members changeable from `cordis.yml`.

```yaml
- name: '@deepseek-ai/dsh-evolution-graph'
  config:
    provider: deepseek
    model: deepseek-chat
```

| Field | Default | Meaning |
|---|---|---|
| `maxNodes` | `500` | Nodes retained per scope; further distinct entities are refused |
| `maxEdges` | `2000` | Relations retained per scope; further distinct relations are refused |
| `maxQueryLimit` | `20` | Results one answer, expansion, or lookup may return |
| `maxInputBytes` | `131072` | Text budget for one extraction call in UTF-8 bytes |
| `maxOutputTokens` | `1024` | Output-token cap for one extraction call |
| `timeoutMs` | `60000` | Deadline for one extraction call |
| `intervalHours` | `6` | Hours between two automatic extraction runs |
| `profile` | `default` | Scope-identity namespace; must match the profile the readers of this graph use |
| `provider` | unset | Extraction route; set together with `model` |
| `model` | unset | Extraction model; required when `provider` is set |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-graph) is the exhaustive source for every accepted field.

With `provider` and `model` unset, an automatic run takes the route from the request route of the first of that scope's buffered sessions that can report one, the same fallback `dsh-evolution-reviewer` uses; a scope whose route resolves neither way keeps its buffer for a later run.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One durable record per scope in storage domain `evolution_graph`, version `1`, layout `per-record`, table `records`, keyed by the scope's storage key. Identity is the case-folded, trimmed label, so `Project X` and `project x` are one entity; a relation name is normalized to lower snake case for the same reason. Edges are keyed by source, relation, and target together.

Every node is created by a triple, so no edge can reference a node that is missing: traversal never has to repair a dangling graph. The two lookups that could still report a missing node are guarded and marked unreachable in coverage with that invariant named.

### Bounds

Both caps are enforced at the write, not at the read: `observe` refuses a new entity or relation once the scope is full and reports it in `skipped`, so a saturated scope keeps answering from what it already knows instead of failing the caller. Query limits cap what one traversal returns, not what is stored.

### Failure and recovery

Invalid records fail the domain open loudly: a lost relation count would silently reorder which connection a traversal treats as strongest. Reads throw before the store starts. A half-set extraction route fails at load. Extraction validates the model's answer at that boundary — unreadable JSON, a non-object, a missing array, or a failed or aborted finish all reject, and nothing is stored from a rejected extraction.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness.spec.md) — the behaviour contract behind the self-learning family.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-reviewer`](../evolution-reviewer/README.md) — the sibling extraction that derives lessons from a turn.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-graph) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

One user message carrying the clipped source text and a fixed system prompt that demands JSON only: one object with a `triples` array of `from`, `relation`, `to`, and optional kinds. A tool call in the answer rejects the extraction.

#### Token effect

Capped: one request per extraction, bounded by `maxInputBytes` of source text and `maxOutputTokens` of completion; an automatic run makes one such request per scope with buffered text and none for an idle scope. Traversal and every read call no model.

#### KV Cache effect

Independent of live requests: extraction is a separate one-shot call with its own prefix, so it cannot invalidate provider cache reuse on a conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the graph is a poor fit. They are current package constraints.

- **Buffered text has two ways to be missed** — the automatic sweep consumes each scope's buffer on the run that extracts it, so text observed since the last run is lost if the process restarts first, and a buffer past `maxInputBytes` drops its oldest message to make room. The window is bounded by `intervalHours` and by the byte cap.
- **Relations are not deduplicated semantically** — `worked_on` and `workedOn` normalize to different relations, and nothing merges near-synonyms.
- **No relation is ever removed** — an edge that a later source contradicts keeps its count; only a raised cap or a new scope starts over.
- **Traversal is undirected** — `expand` walks edges in both directions, so it reports incoming relations as if they were outgoing, naming the relation rather than its inverse.
- **Caps are hard** — once a scope reaches `maxNodes` or `maxEdges`, new entities are dropped rather than evicting the least-connected ones.
- **Extraction is not incremental** — `extract` reads the text it is given; it does not reconcile against what the graph already holds.
- **Machine-local only** — graphs live under `$DSH_HOME`, never inside the project directory.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Wiring `extract` into the reviewer's existing deterministic call would remove the second extraction path, at the cost of widening that prompt's contract from one document to a document plus triples. No design owner yet.

</details>
