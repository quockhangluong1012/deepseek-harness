import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { EmbeddingsError, EmbeddingsProvider, EmbeddingsRuntime, resolveConfig } from '../src/index.ts'
import type { EmbeddingBatch, EmbeddingSpec } from '../src/index.ts'

/** Provider recording every batch it is asked for. */
class FakeProvider extends EmbeddingsProvider {
  readonly defaultModel = 'fake-embed'
  readonly calls: Array<{ spec: EmbeddingSpec; texts: readonly string[]; signal: AbortSignal | undefined }> = []

  constructor(private readonly vector: (text: string) => readonly number[]) {
    super()
  }

  async embed(
    spec: EmbeddingSpec,
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<EmbeddingBatch> {
    this.calls.push({ spec, texts, signal })
    return { model: spec.model, vectors: texts.map(this.vector) }
  }
}

/** Provider answering under `serves`, whatever model it was asked for. */
class ServingProvider extends EmbeddingsProvider {
  /** Model each batch was asked for, in call order. */
  readonly asked: string[] = []

  constructor(readonly defaultModel: string, private readonly serves: string) {
    super()
  }

  async embed(spec: EmbeddingSpec, texts: readonly string[]): Promise<EmbeddingBatch> {
    this.asked.push(spec.model)
    return { model: this.serves, vectors: texts.map(() => [7]) }
  }
}

/** Provider answering with fewer vectors than it was asked for. */
class TruncatingProvider extends EmbeddingsProvider {
  readonly defaultModel = 'truncating'

  async embed(): Promise<EmbeddingBatch> {
    return { model: 'truncating', vectors: [] }
  }
}

function harness(config?: { maxCacheEntries?: number }) {
  const ctx = new Context()
  return ctx.plugin(EmbeddingsRuntime, config).then(fiber => ({ ctx, fiber, embeddings: ctx.embeddings }))
}

describe('embeddings service', () => {
  it('applies the cache bound default', () => {
    expect(resolveConfig({})).toEqual({ maxCacheEntries: 1024 })
    expect(resolveConfig({ maxCacheEntries: 5 })).toEqual({ maxCacheEntries: 5 })
  })

  it('requires at least one non-empty route and registers all routes at once', async () => {
    const { ctx, embeddings } = await harness()
    const provider = new FakeProvider(() => [1])
    expect(() => embeddings.registerProvider([], provider)).toThrow(EmbeddingsError)
    expect(() => embeddings.registerProvider([''], provider)).toThrow(EmbeddingsError)
    const release = embeddings.registerProvider(['a', 'b'], provider)
    expect(embeddings.resolve({ texts: [], provider: 'b' })).toEqual({ provider: 'b', model: 'fake-embed' })
    release()
    await Promise.resolve()
    expect(() => embeddings.resolve({ texts: [], provider: 'a' })).toThrow(EmbeddingsError)
    await ctx.fiber.dispose()
  })

  it('refuses a route another provider holds and registers nothing of a rejected batch', async () => {
    const { ctx, embeddings } = await harness()
    const first = new FakeProvider(() => [1])
    const second = new FakeProvider(() => [2])
    embeddings.registerProvider(['taken'], first)
    expect(() => embeddings.registerProvider(['free', 'taken'], second)).toThrow('already has an embedding provider')
    expect(() => embeddings.resolve({ texts: [], provider: 'free' })).toThrow('no embedding provider is registered')
    await ctx.fiber.dispose()
  })

  it('resolves an omitted route only when exactly one is registered', async () => {
    const { ctx, embeddings } = await harness()
    expect(() => embeddings.resolve({ texts: [] })).toThrow('no embedding provider is registered')
    const provider = new FakeProvider(() => [1])
    embeddings.registerProvider(['one'], provider)
    expect(embeddings.resolve({ texts: [] })).toEqual({ provider: 'one', model: 'fake-embed' })
    expect(embeddings.resolve({ texts: [], model: 'named' })).toEqual({ provider: 'one', model: 'named' })
    embeddings.registerProvider(['two'], new FakeProvider(() => [2]))
    expect(() => embeddings.resolve({ texts: [] })).toThrow('must name one of the registered embedding routes')
    await ctx.fiber.dispose()
  })

  it('embeds one batch and returns vectors in request order', async () => {
    const { ctx, embeddings } = await harness()
    const provider = new FakeProvider(text => [text.length])
    embeddings.registerProvider(['fake'], provider)
    const result = await embeddings.embed({ texts: ['ab', 'cde'] })
    expect(result.spec).toEqual({ provider: 'fake', model: 'fake-embed' })
    expect(result.vectors).toEqual([[2], [3]])
    expect(result.cached).toBe(0)
    expect(result.embedded).toBe(2)
    expect(provider.calls).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('serves a repeated batch from the cache without calling the provider again', async () => {
    const { ctx, embeddings } = await harness()
    const provider = new FakeProvider(text => [text.length])
    embeddings.registerProvider(['fake'], provider)
    await embeddings.embed({ texts: ['hello'] })
    const second = await embeddings.embed({ texts: ['hello'] })
    expect(second.vectors).toEqual([[5]])
    expect(second.cached).toBe(1)
    expect(second.embedded).toBe(0)
    expect(provider.calls).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('asks the provider only for the texts the cache does not hold, keeping their positions', async () => {
    const { ctx, embeddings } = await harness()
    const provider = new FakeProvider(text => [text.length])
    embeddings.registerProvider(['fake'], provider)
    await embeddings.embed({ texts: ['one', 'two'] })
    provider.calls.length = 0
    const mixed = await embeddings.embed({ texts: ['three', 'one', 'four'] })
    expect(mixed.vectors).toEqual([[5], [3], [4]])
    expect(mixed.cached).toBe(1)
    expect(mixed.embedded).toBe(2)
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]?.texts).toEqual(['three', 'four'])
    await ctx.fiber.dispose()
  })

  it('keys the cache by route and model, so a different model re-embeds the same text', async () => {
    const { ctx, embeddings } = await harness()
    const provider = new FakeProvider(text => [text.length])
    embeddings.registerProvider(['fake'], provider)
    await embeddings.embed({ texts: ['shared'] })
    const other = await embeddings.embed({ texts: ['shared'], model: 'other-model' })
    expect(other.cached).toBe(0)
    expect(other.embedded).toBe(1)
    expect(provider.calls).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('keys a batch by the model that produced it, not the one the caller asked for', async () => {
    const { ctx, embeddings } = await harness()
    const provider = new ServingProvider('primary-model', 'fallback-model')
    embeddings.registerProvider(['fake'], provider)
    const first = await embeddings.embed({ texts: ['shared'] })
    // The provider reported the fallback, so that is the batch's identity.
    expect(first.spec).toEqual({ provider: 'fake', model: 'fallback-model' })
    expect(first.vectors).toEqual([[7]])
    // The requested model's key holds nothing, so the text is embedded again
    // rather than answered from a vector the primary model never produced.
    const asPrimary = await embeddings.embed({ texts: ['shared'] })
    expect(asPrimary).toMatchObject({ cached: 0, embedded: 1, vectors: [[7]] })
    // The producing model's key holds it, so a request naming that model hits.
    const asFallback = await embeddings.embed({ texts: ['shared'], model: 'fallback-model' })
    expect(asFallback).toMatchObject({ cached: 1, embedded: 0, vectors: [[7]] })
    expect(provider.asked).toEqual(['primary-model', 'primary-model'])
    await ctx.fiber.dispose()
  })

  it('drops the least recently used vector once the bound is reached', async () => {
    const { ctx, embeddings } = await harness({ maxCacheEntries: 2 })
    const provider = new FakeProvider(text => [text.length])
    embeddings.registerProvider(['fake'], provider)
    await embeddings.embed({ texts: ['a'] })
    await embeddings.embed({ texts: ['b'] })
    // Re-read `a` so `b` becomes the least recently used entry.
    await embeddings.embed({ texts: ['a'] })
    await embeddings.embed({ texts: ['c'] })
    provider.calls.length = 0
    const reAsked = await embeddings.embed({ texts: ['b'] })
    expect(reAsked.cached).toBe(0)
    expect(provider.calls).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('answers an empty batch without calling any provider', async () => {
    const { ctx, embeddings } = await harness()
    const provider = new FakeProvider(() => [1])
    embeddings.registerProvider(['fake'], provider)
    const result = await embeddings.embed({ texts: [] })
    expect(result).toEqual({
      spec: { provider: 'fake', model: 'fake-embed' },
      vectors: [],
      cached: 0,
      embedded: 0,
    })
    expect(provider.calls).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('rejects a provider answer whose vector count does not match the batch', async () => {
    const { ctx, embeddings } = await harness()
    embeddings.registerProvider(['short'], new TruncatingProvider())
    await expect(embeddings.embed({ texts: ['a', 'b'] })).rejects.toThrow('returned 0 vectors for 2 texts')
    await ctx.fiber.dispose()
  })

  it('passes the request signal through to the provider', async () => {
    const { ctx, embeddings } = await harness()
    const provider = new FakeProvider(() => [1])
    embeddings.registerProvider(['fake'], provider)
    const controller = new AbortController()
    await embeddings.embed({ texts: ['x'], signal: controller.signal })
    expect(provider.calls[0]?.signal).toBe(controller.signal)
    await ctx.fiber.dispose()
  })

  it('releases its routes when the plugin disposes', async () => {
    const { ctx, embeddings } = await harness()
    const provider = new FakeProvider(() => [1])
    embeddings.registerProvider(['fake'], provider)
    await ctx.fiber.dispose()
    expect(ctx.get('embeddings')).toBeUndefined()
  })
})
