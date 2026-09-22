---
description: "Knowledge-graph memory: durable per-scope entities and directed relations with bounded traversal, plus one deterministic extraction that turns text into triples (ctx.evolutionGraph)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-graph

English | [中文](README.zh.md)

## Summary

`dsh-evolution-graph` is durable knowledge-graph memory for one scope: entities and directed relations, traversed by connection, not similarity, plus a claim/evidence layer where each asserted fact carries the sources for and against it and a derived belief. Extraction is one `temperature: 0` call whose JSON answer is validated before anything is stored, and the graph keeps labels, kinds, and relation names only, never the sentence it was read from. A repeat raises an edge's count or an evidence source's count, never a belief. Answer a relation, expand a neighbourhood, find entities by label, or query the claims that stand.

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

Claims are the other half of the same record. `recordClaims` records assertions with their evidence; `claims` answers a query over the ones that still stand, and `claim` reads one by identity, retired or not.

```ts
await ctx.evolutionGraph.recordClaims(scope, [{
  statement: 'PostgreSQL holds the session facts',
  supportedBy: [
    { source: 'docs/adr-1.md', quality: 0.8, reliability: 0.5 },
    { source: 's1', quality: 1, reliability: 0.9 },
  ],
  observedIn: ['s1'],
  usedBy: ['skill:session-search'],
}])
ctx.evolutionGraph.claims(scope, 'postgres')                   // active claims, most believed first
ctx.evolutionGraph.claim(scope, 'PostgreSQL holds the facts')  // one claim, with retiredBy when it was replaced
```

Mounted beside `dsh-evolution-memory`, the layer populates itself: the decision batches that store already applies — a `new` candidate, a `confirms`, a `contradicts` — are folded into claims as they land, so the shipped reviewer fills the graph without a command and no model call is added.

A source is identified by its `source`, so recording the same evidence twice raises that entry's `count` and nothing else: `independentSupport` counts distinct sources, and a `contradicts` decision from the reviewer counts as one source however often that session repeats it. A `supersedes` retires the claim it names — the retired claim keeps its evidence and its place in the record but answers no query — which is how a corrected statement replaces an older one instead of editing it.

The `/graph` command is the shipped consumer: `/graph "Project X"` lists an entity's connections, and `/graph "Project X" worked_on` answers one relation. A multi-word entity is quoted; an unquoted extra word is a usage error rather than a silent partial name.

The plugin also produces the graph. Mounted beside `dsh-evolution-heartbeat`, it buffers the text of each scope's user and assistant messages and registers the `evolution-graph-extract` task: every `intervalHours` the task extracts each scope that accumulated text since its last run and clears that scope's buffer as it goes. An idle scope therefore costs no model call. `intervalHours` is not by itself when a run happens: the task passes no idle threshold of its own, so the engine's host-wide `minIdleHours` (default 2) must also have elapsed, and a run beyond that needs a live session in the scope able to report a request route unless `provider` and `model` are configured. A host that never idles that long extracts nothing, and its buffers keep dropping their oldest text to stay inside `maxInputBytes`. A mount with no heartbeat engine still observes, reads, and extracts on demand; only the automatic sweep is absent.

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
| `maxClaims` | `500` | Claims retained per scope; further distinct statements are refused |
| `maxQueryLimit` | `20` | Results one answer, expansion, lookup, or claim query may return |
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

A claim's identity is its normalized statement, so the same fact spelled the same way is one claim, and its `statement` is fixed at first assertion. A corrected statement is therefore a second claim rather than an edit, which is what makes `supersedes` and `derived_from` address claims the way `retiredBy` does: by identity. `observed_in → trace` is the session id a claim was observed in, which is the identity `dsh-evolution-trace` keys a trace by, so the two stores name the same thing. The claim field arrived after records were already stored, so it is a defaulted array in the record schema — a graph written before it opens unchanged with no claims, and no version bump was needed for the reshape.

### Belief

`confidence` is derived, never supplied: the code stores the six decomposition fields (`evidenceQuality`, `sourceReliability`, `independentSupport`, `contradictionCount`, `recency`, and the derived `confidence`) so a consumer can see why a claim is believed rather than only how much. A supporting claim contributes its strongest evidence quality and its most trusted source, multiplied by `n / (n + 1)` over its distinct supporting sources and divided by one plus its distinct contradicting sources. The saturating factor means further independent sources add less and no count alone reaches `1`; the division means a contradiction always lowers the belief on the claim it lands on. `recency` is recorded but not weighted — discounting a fact for age alone needs a clock the pure fold does not have.

Evidence is merged per source: a source already on the claim gains only `count` and `lastAt`, keeping the quality and reliability it first attested with. Re-extraction therefore cannot raise a belief by re-reading one document, session, or model, which is the feedback loop §20 of the specification forbids.

### Bounds

Both caps are enforced at the write, not at the read: `observe` refuses a new entity or relation once the scope is full and reports it in `skipped`, so a saturated scope keeps answering from what it already knows instead of failing the caller. `recordClaims` applies the same rule with `maxClaims`, and still updates a claim the scope already holds at the cap. Query limits cap what one traversal or claim query returns, not what is stored.

### Failure and recovery

Invalid records fail the domain open loudly: a lost relation count would silently reorder which connection a traversal treats as strongest. Reads throw before the store starts. A half-set extraction route fails at load. Extraction validates the model's answer at that boundary — unreadable JSON, a non-object, a missing array, or a failed or aborted finish all reject, and nothing is stored from a rejected extraction. An automatic sweep keeps its per-scope isolation and then reports: every scope that failed is named with its cause in one aggregated error, so a permanently failing route shows up in the heartbeat's bookkeeping instead of a run that discarded its text silently.

The claim layer's producer is the `evolution/decisions-applied` event `dsh-evolution-memory` emits after a decision batch is durable. By then the lessons are already stored, so a claim write that fails is logged and dropped rather than thrown back at the memory write that published it. Claims are derived state: losing one costs a fold, not a fact.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md) — the behaviour contract behind the self-learning family.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-reviewer`](../evolution-reviewer/README.md) — the sibling extraction that derives lessons from a turn.
- [`dsh-evolution-memory`](../evolution-memory/README.md) — the lessons store whose decision batches this package folds into claims.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-graph) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

One user message carrying the clipped source text and a fixed system prompt that demands JSON only: one object with a `triples` array of `from`, `relation`, `to`, and optional kinds. A tool call in the answer rejects the extraction.

#### Token effect

Capped: one request per extraction, bounded by `maxInputBytes` of source text and `maxOutputTokens` of completion; an automatic run makes one such request per scope with buffered text and none for an idle scope. Traversal and every read call no model. The claim layer adds no request of its own: it folds the decision batches `dsh-evolution-memory` already extracted, so populating it is free.

#### KV Cache effect

Independent of live requests: extraction is a separate one-shot call with its own prefix, so it cannot invalidate provider cache reuse on a conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the graph is a poor fit. They are current package constraints.

- **Buffered text can be missed four ways** — the automatic sweep consumes each scope's buffer on the run that extracts it, so text observed since the last run is lost if the process restarts first; a buffer past `maxInputBytes` drops its oldest message to make room; one message larger than the whole budget is refused rather than clipped, so it is never buffered and no later run can reach it; and a failed extraction call spends its batch instead of retrying it, so text the model could not extract is reported in the sweep error and dropped rather than re-extracted. The window is bounded by the idle-gated sweep interval — see above, `intervalHours` plus the engine's `minIdleHours` — and by the byte cap.
- **Relations are not deduplicated semantically** — `worked_on` and `workedOn` normalize to different relations, and nothing merges near-synonyms.
- **A relation edge is still only a count** — an edge keeps its count when a later source contradicts it, because what can be contradicted is the claim built on it, not the record that the relation was read. Contradiction and supersession live in the claim layer: `contradicts` lowers the claim's confidence and `supersedes` retires it. A relation nothing asserts as a claim is still pure frequency.
- **Belief is an ordering, not a probability** — `confidence` is the documented formula over the decomposition fields, and `recency` is recorded without being weighted, so two scopes' claims are comparable only through their own evidence. It ranks claims; it does not estimate how likely one is to be true.
- **The claim layer only folds extraction decisions** — claims arrive from `recordClaims` and from the reviewer's batches. A lesson written by hand (the controller's `setLessons`), an artifact patched in the UI, or a decay-pruned artifact leaves the claims as they were, so a claim can outlive the lesson it came from.
- **`usedBy` has no in-repo writer** — the utility edge is recorded through `recordClaims` when a caller knows which skill or policy consumes a claim, and nothing in this repository writes it yet, so downstream utility is a link the graph can express rather than one it observes.
- **A candidate the store merged into a paraphrase still claims its own statement** — the claim layer keys a `new` decision by the statement the model reported, while the store may have folded that candidate into a similar artifact. The merged artifact's own claim then holds only the evidence addressed to it.
- **A supersede target that does not exist yet is not retired** — no claim means nothing to retire, and a claim created later is not checked against the `supersedes` lists already recorded.
- **Traversal is undirected** — `expand` walks edges in both directions, so it reports incoming relations as if they were outgoing, naming the relation rather than its inverse.
- **Caps are hard** — once a scope reaches `maxNodes`, `maxEdges`, or `maxClaims`, new entities or statements are dropped rather than evicting the least-connected or least-believed ones.
- **Extraction is not incremental** — `extract` reads the text it is given; it does not reconcile against what the graph already holds.
- **Machine-local only** — graphs live under `$DSH_HOME`, never inside the project directory.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Wiring `extract` into the reviewer's existing deterministic call would remove the second extraction path, at the cost of widening that prompt's contract from one document to a document plus triples. No design owner yet.

</details>
