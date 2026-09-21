---
description: "OpenAI-compatible embedding endpoint provider for ctx.embeddings: one POST per batch, with vectors validated at the wire boundary."
kind: "package-reference"
---

# @deepseek-ai/dsh-embeddings-http

English | [中文](README.zh.md)

## Summary

`dsh-embeddings-http` serves one `ctx.embeddings` route from an OpenAI-compatible endpoint: one POST to `<baseURL>/embeddings` per batch, with the response validated before any vector reaches the cache. The endpoint and model are required configuration, because no embedding model name is assumed; the bearer key is resolved per batch through the credential seam, so a rotated key reaches the very next request, and an omitted key leaves the request unauthenticated for endpoints that need none. The response shape is the one DeepSeek-compatible gateways, Ollama, vLLM, and LM Studio serve.

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

```yaml
- name: '@deepseek-ai/dsh-embeddings'
- name: '@deepseek-ai/dsh-embeddings-http'
  config:
    baseURL: 'https://embed.example/v1'
    model: 'text-embedding-model'
    apiKeyEnv: 'EMBEDDINGS_API_KEY'
```

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `route` | `http` | Route this endpoint serves on `ctx.embeddings` |
| `baseURL` | required | Endpoint base; `/embeddings` is appended, and a trailing slash is trimmed |
| `model` | required | Embedding model this endpoint serves |
| `fallbackModel` | unset | Second model retried once when the primary request fails; omit for fail-fast |
| `apiKey` | unset | Literal bearer key; prefer `apiKeyEnv` so no secret enters a configuration file |
| `apiKeyEnv` | unset | Credential reference resolved once per batch; omit for an endpoint that needs no key |
| `timeoutMs` | `30000` | Deadline for one request |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-embeddings-http) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Wire contract

The request body is `{ model, input }` with the model from the resolved spec, so a caller's `model` reaches the endpoint unchanged. The answer is read from `data`: an entry carrying a numeric `index` is placed by it, one without keeps its response position, and a body that does not account for every requested text is refused. Every vector value is checked to be a number before it is returned.

### Credential resolution

`apiKey` wins when set. Otherwise `apiKeyEnv` is resolved through `ctx.credentials` when that seam is mounted, and through the launching environment when it is not; a configured reference that resolves nowhere fails `MISSING_CREDENTIAL` instead of sending an unauthenticated request. Resolution happens per batch, so a key stored while the process runs reaches the next request without a reload.

### Failure and recovery

A rejected HTTP status reports the status and a bounded slice of the body. A body that is not JSON, carries no `data` array, leaves a text unanswered, places an index outside the batch, or carries a non-numeric value all fail `MALFORMED_RESPONSE` — a partially read response would otherwise be cached as if it were complete. When `fallbackModel` is set, any primary failure retries the whole batch once under the fallback model (each attempt gets its own `timeoutMs`); when both fail, the error names both models and both failures. No invariant companion is published: the endpoint is the sole authority on the vectors, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-embeddings`](../embeddings/README.md) — the capability this provider registers into.
- [`dsh-llm-deepseek`](../llm-deepseek/README.md) — the sibling provider whose credential handling this package follows.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-embeddings-http) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

One `POST` per batch carrying the resolved model and the texts to embed, as the endpoint's own `{ model, input }` JSON body. No conversation, prompt section, or tool schema reaches it.

#### Token effect

Bounded by the batch: the endpoint bills the texts it was sent, and the shared cache means a repeated text is sent at most once per service instance.

#### KV Cache effect

None: an embedding request carries no conversation prefix, so it cannot invalidate provider cache reuse on a live session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One endpoint per instance** — every text on the registered route goes to the same base URL and model.
- **No retry** — a failed batch is reported to the caller; nothing resends it.
- **No batch-size limit** — the whole batch is sent as one request whatever its size; a caller with a large corpus chunks it.
- **No proxy configuration of its own** — it uses the process-wide dispatcher the launcher installs.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package assumes the OpenAI-compatible shape deliberately, since the repository declares no embedding model of its own; a vendor-specific provider would be a second package rather than a branch here.

</details>
