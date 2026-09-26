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

/**
 * One provider batch: the vectors and the model that produced them. A provider
 * that retries a failed request under another model reports that model, so a
 * caller keying vectors by model never attributes them to the model it asked
 * for.
 */
export interface EmbeddingBatch {
  /** Model that produced these vectors: the requested one, or the fallback that replaced it. */
  model: string
  /** One vector per requested text, in the same order. */
  vectors: readonly (readonly number[])[]
}

/** Vectors for one batch, in request order. */
export interface EmbeddingResult {
  /**
   * The route and the model that produced these vectors: the requested model,
   * or the fallback a provider served the batch with.
   */
  spec: EmbeddingSpec
  /** One vector per requested text, in the same order. */
  vectors: readonly (readonly number[])[]
  /** Texts answered from the cache. */
  cached: number
  /** Texts sent to the provider. */
  embedded: number
}
