/**
 * OpenAI-compatible embeddings transport: one POST per batch to
 * `<baseURL>/embeddings`, with the answer validated before it reaches the
 * cache. The endpoint shape is the one DeepSeek-compatible gateways, Ollama,
 * vLLM, and LM Studio all serve.
 * @module @deepseek-ai/dsh-embeddings-http/provider
 */

import { EmbeddingsError, EmbeddingsProvider } from '@deepseek-ai/dsh-embeddings'
import type { EmbeddingSpec } from '@deepseek-ai/dsh-embeddings'
import { deadline } from '@deepseek-ai/dsh-timeout'

/** Timeout reason code for one embeddings request. */
export const EMBEDDINGS_HTTP_TIMEOUT = 'EMBEDDINGS_HTTP_TIMEOUT'

/** Largest response failure detail carried into the thrown message. */
const MAX_DETAIL_CHARS = 400

/** What one provider instance needs to reach its endpoint. */
export interface HttpEmbeddingsOptions {
  /** Endpoint base; `/embeddings` is appended. */
  baseURL: string
  /** Model served when a request names none. */
  model: string
  /** Deadline for one request in milliseconds. */
  timeoutMs: number
  /** Resolves the bearer key per request, so a rotated credential reaches the next call; undefined sends none. */
  apiKey?: () => Promise<string | undefined>
  /** Transport override for tests; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch
}

/** Read one entry's vector, refusing anything that is not a numeric array. */
function readVector(provider: string, entry: unknown, position: number): readonly number[] {
  const embedding = (entry as { embedding?: unknown } | null)?.embedding
  if (!Array.isArray(embedding)) {
    throw new EmbeddingsError(`${provider}: embedding entry ${position} carries no vector`, 'MALFORMED_RESPONSE')
  }
  const numeric: number[] = []
  for (const value of embedding as unknown[]) {
    if (typeof value !== 'number') {
      throw new EmbeddingsError(`${provider}: embedding entry ${position} carries a non-numeric value`, 'MALFORMED_RESPONSE')
    }
    numeric.push(value)
  }
  return numeric
}

/**
 * Read the response body into one vector per requested text. An entry carrying
 * `index` is placed by it, one without keeps its response position, and a body
 * that does not account for every text is refused rather than silently short.
 * @param provider - route name used in failure messages.
 * @param payload - the decoded response body.
 * @param expected - how many texts were requested.
 * @returns vectors in request order.
 */
export function readVectors(provider: string, payload: unknown, expected: number): readonly (readonly number[])[] {
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new EmbeddingsError(`${provider}: embeddings response carries no data array`, 'MALFORMED_RESPONSE')
  }
  const ordered: Array<readonly number[] | undefined> = new Array<readonly number[] | undefined>(expected)
  for (const [position, entry] of (data as unknown[]).entries()) {
    const index = (entry as { index?: unknown } | null)?.index
    const slot = typeof index === 'number' ? index : position
    if (!Number.isInteger(slot) || slot < 0 || slot >= expected) {
      throw new EmbeddingsError(
        `${provider}: embeddings response placed a vector at ${slot}, outside the ${expected} requested texts`,
        'MALFORMED_RESPONSE',
      )
    }
    ordered[slot] = readVector(provider, entry, position)
  }
  const vectors: Array<readonly number[]> = []
  for (let slot = 0; slot < expected; slot += 1) {
    const vector = ordered[slot]
    if (vector === undefined) {
      throw new EmbeddingsError(`${provider}: embeddings response left text ${slot} unanswered`, 'MALFORMED_RESPONSE')
    }
    vectors.push(vector)
  }
  return vectors
}

/** Provider posting one batch to an OpenAI-compatible embeddings endpoint. */
export class HttpEmbeddingsProvider extends EmbeddingsProvider {
  readonly defaultModel: string

  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly apiKey: (() => Promise<string | undefined>) | undefined
  private readonly send: typeof globalThis.fetch

  /**
   * @param options - endpoint base, model, deadline, and key source.
   */
  constructor(options: HttpEmbeddingsOptions) {
    super()
    this.defaultModel = options.model
    this.endpoint = `${options.baseURL.replace(/\/+$/, '')}/embeddings`
    this.timeoutMs = options.timeoutMs
    this.apiKey = options.apiKey
    this.send = options.fetch ?? globalThis.fetch
  }

  /**
   * Embed one batch against the endpoint.
   * @param spec - the resolved route and model.
   * @param texts - texts to embed, in the order their vectors must return.
   * @param signal - cancels the request, including a caller abort.
   * @returns one vector per text, in the same order.
   */
  async embed(
    spec: EmbeddingSpec,
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    using call = deadline(signal, this.timeoutMs, EMBEDDINGS_HTTP_TIMEOUT)
    const key = await this.apiKey?.()
    const response = await this.send(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify({ model: spec.model, input: texts }),
      signal: call.signal,
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, MAX_DETAIL_CHARS)
      throw new EmbeddingsError(
        `embedding endpoint ${this.endpoint} answered ${response.status}: ${detail}`,
        'HTTP_ERROR',
      )
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new EmbeddingsError(`embedding endpoint ${this.endpoint} did not return JSON`, 'MALFORMED_RESPONSE', {
        cause: error,
      })
    }
    return readVectors(spec.provider, payload, texts.length)
  }
}
