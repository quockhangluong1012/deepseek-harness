---
description: "Embedding provider registry and cached batch call: one route-resolved request per batch, with vectors cached by content hash (ctx.embeddings)."
kind: "package-reference"
---

# @deepseek-ai/dsh-embeddings

English | [中文](README.zh.md)

## Summary

`dsh-embeddings` is the embeddings capability: a registry of provider routes and one batch call over them. A request names a route and a model, or omits both and takes the single registered route and the provider's own default model. The cache is keyed by the resolved route, model, and text together, so changing either is a different entry rather than a stale vector, and it is bounded — the least recently used vector is dropped once the configured entry count is reached. A batch asks the provider only for the texts the cache does not already hold.

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

Mount the service, register a provider, then embed batches. Vectors return in request order whatever order the provider answered in.

```ts
ctx.plugin(Embeddings)
ctx.embeddings.registerProvider(['http'], provider)

await ctx.embeddings.embed({ texts: ['first', 'second'] })
// { spec: { provider: 'http', model: 'embed-model' },
//   vectors: [[…], […]], cached: 0, embedded: 2 }

await ctx.embeddings.resolve({ texts: [] })   // { provider: 'http', model: 'embed-model' }
```

`resolve` is the defaulting step and calls no provider: an omitted route is the single registered one, and an omitted model is the provider's default. An omitted route with several registered fails `AMBIGUOUS_PROVIDER` rather than guessing.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-embeddings'
  config:
    maxCacheEntries: 1024
```

| Field | Default | Meaning |
|---|---|---|
| `maxCacheEntries` | `1024` | Vectors retained per service instance before the least recently used is dropped |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-embeddings) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Registration is all-or-nothing: a batch naming a route another provider already holds fails and leaves the registry untouched, so a rejected registration can never leave half its routes served. Disposal releases exactly the routes the registration took.

### The cache

The key is the SHA-256 of the resolved route, model, and text joined by a separator that cannot occur in either, so the three components cannot be confused for one another. A hit is re-inserted to become the most recently used key; an insert past the bound drops the first key, which is therefore the least recently used one. Duplicate texts inside one batch are both sent — batching repeats is the provider's business, not the cache's.

### Failure and recovery

A provider answering with a different number of vectors than it was asked for is refused rather than zipped, because a short answer would silently shift every later text onto the wrong vector. An empty batch is answered without calling any provider. No invariant companion is published: the cache is derived state whose only authority is the provider, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-embeddings-http`](../embeddings-http/README.md) — the shipped OpenAI-compatible provider.
- [`dsh-llm`](../llm/README.md) — the sibling model-call registry this service mirrors.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-embeddings) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

None, as the embeddings service adds no content of its own; the registered provider chooses what it sends to its endpoint.

#### KV Cache effect

None: embedding requests carry no conversation prefix, so a batch cannot invalidate provider cache reuse on a live session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **In-process cache only** — a restart re-embeds every text; durable per-document reuse belongs to whatever index stores those vectors.
- **No deduplication within a batch** — a text repeated in one batch is embedded once per occurrence.
- **No provider concurrency limit** — a caller that issues many batches at once issues that many endpoint requests.
- **No dimension or model validation** — the service returns whatever the provider produced; a caller mixing two models in one corpus owns that mistake.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No consumer is wired yet. The intended one is a vector channel in `dsh-session-query-sqlite`, which would also make the cache's durable counterpart unnecessary for indexed documents.

</details>
