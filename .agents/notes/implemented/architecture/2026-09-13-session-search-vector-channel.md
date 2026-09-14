# Agent Note: Session search gains a vector channel and rank fusion

Status: implemented

English | [中文](2026-09-13-session-search-vector-channel.zh.md)

## Problem

Session search matched text. A caller could find a session that contained the words it typed and nothing else, so a question phrased differently from the transcript it lived in returned nothing — the same gap the embeddings capability was built to close.

Filling it forced three questions the specification does not answer. Where does the second ranking live: inside the full-text backend, or beside it? What does the service return when a deployment mounts no embedding provider? And what does a fusion of two rankings do when they disagree?

Two constraints came from the existing engine rather than the specification. `_replacePersistedSession` and `_replaceLiveSession` are synchronous and run inside the serialized reconcile transaction, so vectors cannot be written while documents are indexed without holding that transaction open across a network call. And the candidate query is built entirely around FTS5 `MATCH` and `highlight()`, which a semantic search cannot use at all.

## Decision

`SessionQueryEngine` gains two members. `searchSessionsSemantic` is abstract, so every provider answers it. `searchSessionsHybrid` is concrete in the definition, calling both channels and fusing them by reciprocal rank with the standard constant of 60 — a session both channels place highly outranks one either channel found alone, which is the reason to run both. Fusion lives in the definition so the fusion rule is written once, not per backend.

The channel itself lives in `dsh-session-query-sqlite`, beside the lexical one, sharing its filters and its hit assembly. A new `SEMANTIC_CANDIDATES_SQL` selects the filtered corpus without `MATCH`, projecting the same columns plus each document's rowid, so hits are assembled by the existing code and a semantic hit simply carries a plain excerpt where a lexical one carries a highlighted one.

Vectors are keyed by content hash and model, not by rowid. A re-indexed document can therefore never be served the vector of the document that previously occupied its rowid, which is the failure the obvious design ships. The store holds them in `persisted_vectors`, and the schema version moves to 9 so an existing derived index resets in place.

Embedding happens outside the serialized section: the channel reads candidates inside it, embeds and ranks outside it, then writes the freshly produced vectors back inside a short serialized step. A deployment with no embedding service refuses the call with `SESSION_QUERY_SEMANTIC_UNAVAILABLE` rather than silently answering with lexical results a caller did not ask for.

## Alternatives considered

**Fusing inside the backend.** A provider could own fusion. It would let each backend tune its own weights, and would also mean the rule exists once per backend; the definition owns it instead, so every provider fuses identically and a caller can rely on the same combined ordering everywhere.

**Embedding during indexing.** Writing vectors in `_replacePersistedSession` would keep the store always current. It would also hold the reconcile transaction open across a provider call, which the engine's locking design does not survive. Embedding lazily, bounded by `maxVectorCandidates`, keeps the write path synchronous and pays for the vector only when something asks for one.

**Storing vectors by document rowid.** The obvious key, and wrong: documents are deleted and re-inserted wholesale when a session changes, so a rowid can outlive the document it named. Content-hash keying makes a stale hit impossible rather than merely unlikely.

**Falling back to lexical search when no provider is mounted.** Silent degradation would let a caller believe it received semantic results. Refusing names the missing capability.

**Returning both rankings unfused.** A caller could fuse itself. Every caller would then implement the same arithmetic, and the ordering would differ between them.

## Consequences

A session that a caller describes in words it did not use can now be found, and a session both channels agree on is ranked above one only a single channel matched. `searchSessions` and `searchEvents` are unchanged, so nothing that existed before behaves differently.

The cost is paid on the first semantic search over a corpus: the channel embeds the documents it does not already hold, bounded by `maxVectorCandidates` (default 2000). Later searches embed the query alone for persisted documents. Live documents are not stored, so they are embedded per search and absorbed by the embedding service's own cache.

Every implementer of the abstract service had to answer the new method: one production backend and eleven test doubles, fixtures, and benchmarks across the repository. The test doubles reject it, modelling a deployment with no vector channel.

The vector store is not pruned: a document that leaves the index leaves its vector behind. The table is keyed by content hash and read only through exact lookups, so a leftover row is dead weight rather than a wrong answer, and it is recorded here rather than silently accepted.
