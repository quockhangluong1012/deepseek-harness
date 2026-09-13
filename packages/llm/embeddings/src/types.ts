/**
 * Vocabulary for the embeddings capability: the batch a caller asks for, the
 * route and model it resolved to, and the vectors that came back.
 * @module @deepseek-ai/dsh-embeddings/types
 */

/** One embedding batch as a caller asks for it. */
export interface EmbeddingRequest {
  /** Texts to embed; their vectors return in this order. */
  texts: readonly string[]
  /** Provider route; required only when more than one route is registered. */
  provider?: string
  /** Model identifier; the serving provider's default fills an omitted one. */
  model?: string
  /** Cancels the batch, including a provider call already in flight. */
  signal?: AbortSignal
}

/**
 * The route and model one request resolved to. Together with the text this is
 * also the cache identity, so a changed route or model is a different entry
 * rather than a stale hit.
 */
export interface EmbeddingSpec {
  /** Registered provider route serving the request. */
  provider: string
  /** Concrete model, never absent: the provider's default fills an omitted one. */
  model: string
}

/** Vectors for one batch, in request order. */
export interface EmbeddingResult {
  /** The route and model that produced these vectors. */
  spec: EmbeddingSpec
  /** One vector per requested text, in the same order. */
  vectors: readonly (readonly number[])[]
  /** Texts answered from the cache. */
  cached: number
  /** Texts sent to the provider. */
  embedded: number
}
