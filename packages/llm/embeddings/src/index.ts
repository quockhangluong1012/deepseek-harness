/**
 * Embeddings service (`ctx.embeddings`): a provider-route registry plus one
 * batch call whose results are cached by content hash.
 *
 * The cache is keyed by the resolved route, model, and text together, so
 * changing either route or model looks up a different entry instead of reusing
 * a stale vector, and it is bounded: the least recently used vector is dropped
 * once the configured entry count is reached. Durable reuse of per-document
 * vectors belongs to the index that stores them, not to this cache.
 * @module @deepseek-ai/dsh-embeddings
 */

import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { EmbeddingRequest, EmbeddingResult, EmbeddingSpec } from './types.ts'

export type * from './types.ts'

/** Cache entries retained before the least recently used vector is dropped. */
export const DEFAULT_MAX_CACHE_ENTRIES = 1024

/** Failure class for a request this service cannot serve. */
export class EmbeddingsError extends HarnessError {}

/** Cut one provider's vectors down to the caller's texts, reporting a wrong count. */
function assertVectorCount(provider: string, produced: readonly unknown[], expected: number): void {
  if (produced.length !== expected) {
    throw new EmbeddingsError(
      `embedding provider "${provider}" returned ${produced.length} vectors for ${expected} texts`,
      'MALFORMED_RESPONSE',
    )
  }
}

/**
 * Provider-wire backend for one or more embedding routes. Register
 * implementations with `ctx.embeddings.registerProvider(routes, provider)`,
 * and make every provider request carry the credential its route resolved.
 */
export abstract class EmbeddingsProvider {
  /** Model served when a request names none, and the cache key's model component. */
  abstract readonly defaultModel: string

  /**
   * Embed one non-empty batch.
   * @param spec - the resolved route and model.
   * @param texts - texts to embed, in the order their vectors must return.
   * @param signal - cancels the provider call.
   * @returns one vector per text, in the same order.
   */
  abstract embed(
    spec: EmbeddingSpec,
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly (readonly number[])[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Embedding provider registry and cached batch call. */
    embeddings: EmbeddingsRuntime
  }
}

/** Deployment choices for the embeddings service. */
export interface Config {
  /** Cache entries retained across calls. */
  maxCacheEntries?: number
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  maxCacheEntries: z.number().step(1).min(1).default(DEFAULT_MAX_CACHE_ENTRIES),
})

/** Deployment choices with every default applied. */
export interface ResolvedConfig {
  maxCacheEntries: number
}

/**
 * Apply defaults for the optional fields. The schema fills the same values when
 * the plugin is loaded from `cordis.yml`; this step is what a directly
 * constructed service uses.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return { maxCacheEntries: config.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES }
}

/**
 * The `embeddings` service: routes registered by providers, and one batch call
 * that resolves the route, serves what the cache holds, and asks the provider
 * only for the texts it does not.
 */
export class EmbeddingsRuntime extends Service {
  static readonly Config = Config

  private readonly providers = new Map<string, EmbeddingsProvider>()
  private readonly cache = new Map<string, readonly number[]>()
  private readonly maxCacheEntries: number

  /**
   * @param ctx - host context owning the service lifetime.
   * @param config - cache bound for this instance.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'embeddings')
    this.maxCacheEntries = resolveConfig(config).maxCacheEntries
  }

  /**
   * Register a provider for the given routes, all-or-nothing. A route already
   * held by a different provider fails the registration and leaves the registry
   * exactly as it was. Disposed with the fiber.
   * @param routes - every route this provider serves.
   * @param provider - the provider that embeds for those routes.
   * @returns the disposer releasing whatever the registration holds.
   */
  registerProvider(routes: readonly string[], provider: EmbeddingsProvider): () => void {
    const owned = new Set<string>()
    const dispose = this.ctx.effect(function* (this: EmbeddingsRuntime) {
      if (routes.length === 0) {
        throw new EmbeddingsError('an embedding provider must register at least one route', 'INVALID_PROVIDER')
      }
      for (const route of routes) {
        if (route === '') {
          throw new EmbeddingsError('an embedding provider route cannot be empty', 'INVALID_PROVIDER')
        }
        const held = this.providers.get(route)
        if (held !== undefined && held !== provider) {
          throw new EmbeddingsError(`route "${route}" already has an embedding provider`, 'DUPLICATE_PROVIDER')
        }
      }
      for (const route of routes) {
        this.providers.set(route, provider)
        owned.add(route)
      }
      yield () => {
        for (const route of owned) this.providers.delete(route)
        owned.clear()
      }
    }.bind(this), 'embeddings.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; this API is synchronous
    // fire-and-forget, so the (always-resolved) promise is discarded.
    return () => void dispose()
  }

  /**
   * Resolve the route and model one request runs against, without calling a
   * provider. This is the defaulting step: an omitted route is the single
   * registered one, and an omitted model is the provider's own default.
   * @param request - the batch's routing fields.
   * @returns the route and model the request resolves to.
   */
  resolve(request: EmbeddingRequest): EmbeddingSpec {
    return this.route(request).spec
  }

  /**
   * Embed one batch, serving texts the cache already holds and asking the
   * provider only for the rest.
   * @param request - texts and routing fields.
   * @returns vectors in request order, with the cache and provider counts.
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const { spec, provider } = this.route(request)
    if (request.texts.length === 0) return { spec, vectors: [], cached: 0, embedded: 0 }
    const vectors: (readonly number[])[] = new Array<readonly number[]>(request.texts.length)
    const pending: Array<{ index: number; text: string }> = []
    let cached = 0
    request.texts.forEach((text, index) => {
      const key = cacheKey(spec, text)
      const held = this.cache.get(key)
      if (held === undefined) {
        pending.push({ index, text })
        return
      }
      // Re-insert so the most recently used entry is the last key.
      this.cache.delete(key)
      this.cache.set(key, held)
      vectors[index] = held
      cached += 1
    })
    if (pending.length > 0) {
      const produced = await provider.embed(spec, pending.map(entry => entry.text), request.signal)
      assertVectorCount(spec.provider, produced, pending.length)
      for (let offset = 0; offset < pending.length; offset += 1) {
        const entry = pending[offset]
        const vector = produced[offset]
        /* v8 ignore next 2 -- both arrays hold one entry per pending text (checked above) */
        if (entry === undefined || vector === undefined) continue
        vectors[entry.index] = vector
        this.remember(cacheKey(spec, entry.text), vector)
      }
    }
    return { spec, vectors, cached, embedded: pending.length }
  }

  /** Resolve the route and the provider serving it, or refuse the request. */
  private route(request: EmbeddingRequest): { spec: EmbeddingSpec; provider: EmbeddingsProvider } {
    const provider = request.provider ?? this.onlyRoute()
    const found = this.providers.get(provider)
    if (found === undefined) {
      throw new EmbeddingsError(`no embedding provider is registered for route "${provider}"`, 'NO_PROVIDER')
    }
    return { spec: { provider, model: request.model ?? found.defaultModel }, provider: found }
  }

  /** The single registered route, or the reason a route must be named. */
  private onlyRoute(): string {
    const [only] = this.providers.keys()
    if (only === undefined) {
      throw new EmbeddingsError('no embedding provider is registered', 'NO_PROVIDER')
    }
    if (this.providers.size > 1) {
      throw new EmbeddingsError(
        `request must name one of the registered embedding routes: ${[...this.providers.keys()].join(', ')}`,
        'AMBIGUOUS_PROVIDER',
      )
    }
    return only
  }

  /** Store one vector, dropping the least recently used entry past the bound. */
  private remember(key: string, vector: readonly number[]): void {
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value
      /* v8 ignore next -- a full cache has a first key to drop. */
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, vector)
  }
}

/** Cache identity of one text under one resolved route and model. */
function cacheKey(spec: EmbeddingSpec, text: string): string {
  return createHash('sha256').update(`${spec.provider}\u0000${spec.model}\u0000${text}`).digest('hex')
}

export default EmbeddingsRuntime
