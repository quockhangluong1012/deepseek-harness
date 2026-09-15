# Agent Note: Knowledge-graph memory indexes what a scope already knows

Status: implemented

English | [中文](2026-09-13-evolution-graph.zh.md)

## Problem

Every existing recall path in the harness matches text: the ranked search finds sessions whose text resembles a query, and the evolution brief carries one recalled hit. Nothing could answer a question about structure — who worked on a project, what a project depends on — because no store held the connections between the things a scope talks about.

The specification asks for graph memory with entity relationships and graph-based search. Building it raised one question the spec does not answer: where the graph comes from, given that the harness has no entity extractor, and hand-rolling named-entity recognition is exactly the kind of work this repository prefers to spend a model call on instead.

## Decision

`@deepseek-ai/dsh-evolution-graph` provides `ctx.evolutionGraph`: durable per-scope entities and directed relations, with bounded traversal and one deterministic extraction.

The graph stores labels, kinds, and relation names — never the sentence a relation was read from. Identity is the case-folded, trimmed label, so `Project X` and `project x` are one entity, and a relation name is normalized to lower snake case; edges are keyed by source, relation, and target together. A first sighting inserts, a repeat raises the edge's count and moves its `lastAt`, and an entity seen again keeps its first label while gaining the kind it lacked.

Extraction is one call at `temperature: 0` with `purpose: 'evolution-review'` whose answer must be JSON. That answer crosses a wire boundary, so it is validated before anything is stored: unreadable JSON, a non-object, a missing `triples` array, a tool call in the answer, and a failed or aborted finish all reject, and a rejected extraction stores nothing.

Reads are three traversals over the same record: `answer` follows one named relation outward from a found entity, `expand` walks breadth-first in both directions and names the relation on each hop, and `find` locates entities by label substring ranked by connection count. Both caps — `maxNodes` and `maxEdges` — are enforced at the write: a saturated scope keeps answering from what it knows rather than failing its caller, and counts what it dropped in `skipped`.

`/graph` in `dsh-command-evolution` is the shipped consumer: `/graph "<entity>"` lists connections and `/graph "<entity>" <relation>` answers one relation. Entities are quoted because a label may contain spaces, and an unquoted extra word is a usage error rather than a silently truncated name.

## Alternatives considered

**Extraction riding the reviewer's existing call.** The reviewer already makes one deterministic call per gated turn, so the graph could have been filled from that same answer instead of adding a second path. It loses on coupling: that prompt's contract is one replacement lessons document, and widening it to "a document plus triples" makes every future change to lessons extraction also a change to graph extraction. The graph's own call keeps the two independently versioned, and the Dev Note records the trade as an open direction rather than a decision.

**Handle-rolled named-entity recognition.** A dependency or a heuristic could have found entities without a model call, and would have made extraction free. It is the work this repository consistently refuses to hand-roll: relation extraction from prose needs world knowledge, and a dependency for it would be a large surface for one feature. A `temperature: 0` call returns the structure directly.

**Store the source sentence on each edge.** Keeping the sentence a relation was read from would let a caller audit a triple. It would also make the graph a second copy of the transcript, growing without bound and duplicating material the session log already holds; the graph is an index over what the scope knows, so it keeps only the triple.

**Evict the least-connected node when a cap is reached.** Refusing new entities at the cap means a long-lived scope stops learning new things. Eviction would keep accepting them, at the cost of silently forgetting relations a caller may still traverse — a worse failure than a bounded, reported refusal.

## Consequences

A scope can now be asked about structure and answer from a bounded index rather than by re-reading transcripts, and the extraction boundary keeps a model's malformed answer out of durable storage.

The trade-offs are recorded in the package README: relations are not deduplicated semantically (`worked_on` and `workedOn` are two relations), no relation is ever removed, traversal is undirected so an incoming edge is reported with the relation name rather than its inverse, and the caps refuse rather than evict.

The package ships complete: a definition, a consumer command, the extraction that feeds it, and a producer. Mounted beside `dsh-evolution-heartbeat`, the graph buffers each scope's user and assistant message text and registers the `evolution-graph-extract` task, which extracts whatever accumulated since its last run — the [graph-vector fusion](2026-09-15-graph-vector-fusion.md) note records that design and its staleness bounds.
