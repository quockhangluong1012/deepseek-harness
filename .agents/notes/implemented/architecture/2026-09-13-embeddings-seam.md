# Agent Note: Embeddings become a capability seam with a content-hash cache

Status: implemented

English | [中文](2026-09-13-embeddings-seam.zh.md)

## Problem

The specification's hybrid-search mechanism needs vectors, and the harness had no way to produce one: no embeddings capability, no embedding provider, and no caching, so every consumer would have reached an endpoint directly and re-sent text it had already sent.

Adding one raised two questions the specification does not answer. Where does the defaulting happen — a caller that names no model, or a caller that names no route but has several registered? And what bounds the cost of repeating a call that is pure function of its input?

A third question came from the repository's own conventions rather than the specification: what a capability seam must ship. The glossary is explicit that a seam comprises a Service Definition, one or more Service Providers, and one or more Consumers that inject the service, and that a package may own several roles only when they are one concern.

## Decision

Two packages, following the shape `dsh-llm` and its providers established.

`@deepseek-ai/dsh-embeddings` is the Service Definition: `ctx.embeddings` registers provider routes and serves one batch per call. `resolve(request)` is the explicit defaulting step — an omitted route is the single registered one, an omitted model is the provider's own `defaultModel`, and an omitted route with several registered fails `AMBIGUOUS_PROVIDER` rather than picking one. `embed(request)` serves the texts the cache holds and sends the provider only the rest, returning both counts.

The cache is keyed by the SHA-256 of the resolved route, model, and text joined by a character that cannot occur in either, so changing either is a different entry rather than a stale vector, and a hit is re-inserted so the first key is always the least recently used one. The bound is `maxCacheEntries`.

`@deepseek-ai/dsh-embeddings-http` is the Provider: one POST to `<baseURL>/embeddings` per batch, the endpoint and model required because the repository declares no embedding model of its own, and the bearer key resolved per batch through the credentials seam so a rotated key reaches the next request.

## Alternatives considered

**A separate cache provider over the definition.** A wrapper provider keyed by content hash would have kept caching out of the definition. It loses because every provider would then need the wrapper to get the behaviour, and a provider registered without it would silently re-embed: the cache is a property of the capability, not of one transport.

**A durable cache in the definition's own storage domain.** It would survive a restart. It is also the wrong owner: the durable counterpart of a cached vector is the index that stores the vector, and a definition-level store would duplicate that index's data and need its own invalidation when the model changes. The in-process cache covers the repeated call; durable reuse belongs to whoever stores vectors.

**Defaulting inside each provider.** A provider could have filled its own model and route. That is a hidden `?? default` at the point of use, which the repository forbids at package boundaries, and it would leave `resolve` unable to answer what a request runs against without making a call.

**A vendor-specific provider with a hardcoded endpoint and model.** It would read better than a configurable one. It would also invent a model name the repository does not declare, so the OpenAI-compatible shape is assumed deliberately and a vendor-specific provider becomes a second package rather than a branch.

**Rejecting a short provider answer by truncating to the shorter length.** Refusing it is what the code does; truncating would shift every later text onto the wrong vector, which is a silent corruption rather than a reported failure.

## Consequences

`ctx.embeddings` exists with a tested Definition and Provider: 33 tests across the two packages, both at 100% statements, branches, functions, and lines.

The cache is per process instance, so a restart re-embeds; duplicate texts inside one batch are both sent; and there is no batch-size limit, retry, or dimension validation. These are recorded in the package READMEs rather than implied.

**The Consumer is not built.** By the glossary's own definition this seam is therefore incomplete until a consumer injects `ctx.embeddings`. The intended consumer is a vector channel in `dsh-session-query-sqlite`: a `persisted_vectors` table written as documents are indexed, a semantic search over it, and rank fusion with the existing FTS5 channel. That work is a schema-version bump and a change to the shared indexing path of a 1133-line engine, and it is deferred rather than half-landed. Two constraints found while tracing it: `_replacePersistedSession` and `_replaceLiveSession` are synchronous and run inside the serialized reconcile transaction, so embedding there would hold that transaction open across a provider call, and the vector pass has to run after it closes; and the candidate query is built entirely around FTS5 `MATCH` and `highlight()`, so the semantic channel needs a parallel query without either.

The missing consumer does not make the service undocumented: `gen-cordis-catalog` first refused `ctx.embeddings` because its signature types carried no documentation owner, and classifying those four types renders it on the LLM subsystem page. That refusal was a classification gap, not a reachability one.

Adding the semantic method to the definition was a breaking change to a live service: one production subclass, seven test doubles, three fixtures and benchmark doubles subclass `SessionQueryEngine`, and every one had to answer the new method in the same change. That consumer now exists in `dsh-session-query-sqlite`, so the seam is complete — Definition, Provider, and a Consumer that injects it ([vector channel](2026-09-13-session-search-vector-channel.md)).
