import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { EmbeddingsRuntime } from '@deepseek-ai/dsh-embeddings'
import type { EmbeddingSpec } from '@deepseek-ai/dsh-embeddings'
import * as EmbeddingsHttp from '../src/index.ts'
import { apply, Config, HttpEmbeddingsProvider, readVectors } from '../src/index.ts'
import type { Config as EmbeddingsHttpConfig } from '../src/index.ts'
import type { HttpEmbeddingsOptions } from '../src/index.ts'

const spec: EmbeddingSpec = { provider: 'http', model: 'embed-model' }

/** One recorded request. */
interface Sent {
  url: string
  init: RequestInit
}

/** Harness building a provider around a recording transport. */
function providerHarness(
  respond: (sent: Sent) => Response | Promise<Response>,
  overrides: Partial<HttpEmbeddingsOptions> = {},
) {
  const sent: Sent[] = []
  const provider = new HttpEmbeddingsProvider({
    baseURL: 'https://embed.example/v1',
    model: 'embed-model',
    timeoutMs: 30_000,
    fetch: ((url: string | URL, init?: RequestInit) => {
      const record = { url: String(url), init: init ?? {} }
      sent.push(record)
      return Promise.resolve(respond(record))
    }) as unknown as typeof globalThis.fetch,
    ...overrides,
  })
  return { provider, sent }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('readVectors', () => {
  it('keeps request order when the response carries indices out of order', () => {
    const vectors = readVectors('http', {
      data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }],
    }, 2)
    expect(vectors).toEqual([[1], [2]])
  })

  it('falls back to response position when an entry carries no index', () => {
    expect(readVectors('http', { data: [{ embedding: [1] }, { embedding: [2] }] }, 2)).toEqual([[1], [2]])
  })

  it('refuses a body that leaves a requested text unanswered', () => {
    expect(() => readVectors('http', { data: [{ embedding: [1] }] }, 2)).toThrow('left text 1 unanswered')
  })

  it('refuses a body with no data array, a missing vector, and a non-numeric value', () => {
    expect(() => readVectors('http', { vectors: [] }, 1)).toThrow('carries no data array')
    expect(() => readVectors('http', { data: [{}] }, 1)).toThrow('carries no vector')
    expect(() => readVectors('http', { data: [{ embedding: [1, 'x'] }] }, 1)).toThrow('non-numeric value')
  })

  it('refuses an entry placed outside the requested texts', () => {
    expect(() => readVectors('http', { data: [{ index: 4, embedding: [1] }] }, 2)).toThrow(
      'placed a vector at 4, outside the 2 requested texts',
    )
  })
})

describe('http embeddings provider', () => {
  it('posts the batch to the endpoint base and returns the vectors', async () => {
    const { provider, sent } = providerHarness(() => jsonResponse({ data: [{ embedding: [0.5, 0.25] }] }))
    const vectors = await provider.embed(spec, ['hello'])
    expect(vectors).toEqual([[0.5, 0.25]])
    expect(sent[0]?.url).toBe('https://embed.example/v1/embeddings')
    expect(sent[0]?.init.method).toBe('POST')
    expect(JSON.parse(sent[0]?.init.body as string)).toEqual({ model: 'embed-model', input: ['hello'] })
  })

  it('trims a trailing slash on the configured base', async () => {
    const { provider, sent } = providerHarness(() => jsonResponse({ data: [{ embedding: [1] }] }), {
      baseURL: 'https://embed.example/v1/',
    })
    await provider.embed(spec, ['x'])
    expect(sent[0]?.url).toBe('https://embed.example/v1/embeddings')
  })

  it('sends the bearer key the resolver returns and omits the header without one', async () => {
    const withKey = providerHarness(() => jsonResponse({ data: [{ embedding: [1] }] }), {
      apiKey: () => Promise.resolve('secret-key'),
    })
    await withKey.provider.embed(spec, ['x'])
    expect((withKey.sent[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer secret-key')

    const anonymous = providerHarness(() => jsonResponse({ data: [{ embedding: [1] }] }))
    await anonymous.provider.embed(spec, ['x'])
    expect((anonymous.sent[0]?.init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('reports the endpoint status and detail on a rejected request', async () => {
    const { provider } = providerHarness(() => new Response('quota exhausted', { status: 429 }))
    await expect(provider.embed(spec, ['x'])).rejects.toThrow('answered 429: quota exhausted')
  })

  it('refuses a body that is not JSON', async () => {
    const { provider } = providerHarness(() => new Response('not json', { status: 200 }))
    await expect(provider.embed(spec, ['x'])).rejects.toThrow('did not return JSON')
  })

  it('passes the caller signal to the transport', async () => {
    const { provider, sent } = providerHarness(() => jsonResponse({ data: [{ embedding: [1] }] }))
    const controller = new AbortController()
    await provider.embed(spec, ['x'], controller.signal)
    expect(sent[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('http embeddings plugin', () => {
  async function harness(config: Partial<EmbeddingsHttpConfig>, credentials?: unknown) {
    const ctx = new Context()
    await ctx.plugin(EmbeddingsRuntime, {})
    if (credentials !== undefined) ctx.provide('credentials', credentials as never)
    const fiber = await ctx.plugin(EmbeddingsHttp, config as EmbeddingsHttpConfig)
    return { ctx, fiber, embeddings: embeddingsOf(ctx) }
  }

  /** The registered service, read without a plugin-level inject. */
  function embeddingsOf(ctx: Context) {
    const found = ctx.get('embeddings')
    if (found === undefined) throw new Error('embeddings service is not mounted')
    return found
  }

  /**
   * Run a body with the transport replaced. The stub is installed before the
   * plugin loads, because the provider captures `fetch` when it is built.
   */
  async function withStubbedFetch<T>(run: (sent: Array<string | undefined>) => Promise<T>): Promise<T> {
    const sent: Array<string | undefined> = []
    const original = globalThis.fetch
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
      sent.push((init?.headers as Record<string, string> | undefined)?.authorization)
      return Promise.resolve(jsonResponse({ data: [{ embedding: [1] }] }))
    }) as unknown as typeof globalThis.fetch
    try {
      return await run(sent)
    } finally {
      globalThis.fetch = original
    }
  }

  it('declares the endpoint base and model as required configuration', () => {
    expect(() => Config({} as never)).toThrow()
    expect(Config({ baseURL: 'https://e.example', model: 'm' })).toMatchObject({
      route: 'http',
      timeoutMs: 30_000,
    })
  })

  it('registers the configured route, defaulting it to http', async () => {
    const named = await harness({ baseURL: 'https://e.example', model: 'm', route: 'custom' })
    expect(named.embeddings.resolve({ texts: [] })).toEqual({ provider: 'custom', model: 'm' })
    const standard = await harness({ baseURL: 'https://e.example', model: 'm' })
    expect(standard.embeddings.resolve({ texts: [] })).toEqual({ provider: 'http', model: 'm' })
  })

  it('resolves a configured credential reference for every batch', async () => {
    const seen: string[] = []
    await withStubbedFetch(async () => {
      const { ctx } = await harness(
        { baseURL: 'https://e.example', model: 'm', apiKeyEnv: 'EMBED_KEY' },
        { resolve: (ref: string) => { seen.push(ref); return Promise.resolve({ value: 'from-store' }) } },
      )
      await embeddingsOf(ctx).embed({ texts: ['x'] })
    })
    expect(seen).toEqual(['EMBED_KEY'])
  })

  it('reads the launching environment when no credential seam is mounted', async () => {
    const sent = await withStubbedFetch(async (headers) => {
      const ctx = new Context()
      await ctx.plugin(EmbeddingsRuntime, {})
      ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
        { source: 'process', values: { EMBED_KEY: 'from-environment' } },
      ]))
      await ctx.plugin(EmbeddingsHttp, { baseURL: 'https://e.example', model: 'm', apiKeyEnv: 'EMBED_KEY' })
      await embeddingsOf(ctx).embed({ texts: ['x'] })
      return headers
    })
    expect(sent).toEqual(['Bearer from-environment'])
  })

  it('fails loudly when the launching environment exports no such key', async () => {
    const ctx = new Context()
    await ctx.plugin(EmbeddingsRuntime, {})
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
    await ctx.plugin(EmbeddingsHttp, { baseURL: 'https://e.example', model: 'm', apiKeyEnv: 'EMBED_KEY' })
    await expect(embeddingsOf(ctx).embed({ texts: ['x'] })).rejects.toThrow('export EMBED_KEY in the launching environment')
  })

  it('fails loudly when a configured credential reference resolves nowhere', async () => {
    const { ctx } = await harness(
      { baseURL: 'https://e.example', model: 'm', apiKeyEnv: 'MISSING_KEY' },
      { resolve: () => Promise.resolve(undefined) },
    )
    await expect(embeddingsOf(ctx).embed({ texts: ['x'] })).rejects.toThrow(
      'no API key for route "http"',
    )
  })

  it('accepts a literal key without consulting the credential seam', async () => {
    const sent = await withStubbedFetch(async (headers) => {
      const { ctx } = await harness({ baseURL: 'https://e.example', model: 'm', apiKey: 'literal-key' })
      await embeddingsOf(ctx).embed({ texts: ['x'] })
      return headers
    })
    expect(sent).toEqual(['Bearer literal-key'])
  })

  it('leaves a keyless endpoint unauthenticated', async () => {
    const sent = await withStubbedFetch(async (headers) => {
      const { ctx } = await harness({ baseURL: 'https://e.example', model: 'm' })
      await embeddingsOf(ctx).embed({ texts: ['x'] })
      return headers
    })
    expect(sent).toEqual([undefined])
  })

  it('registers nothing when the plugin config is invalid', async () => {
    const ctx = new Context()
    await ctx.plugin(EmbeddingsRuntime, {})
    await expect(ctx.plugin(EmbeddingsHttp, { model: 'm' } as never)).rejects.toThrow()
    expect(() => { apply(ctx, { model: 'm' } as never) }).toThrow()
  })
})
