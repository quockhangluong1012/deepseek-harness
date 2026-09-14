/**
 * Register an OpenAI-compatible embeddings provider on `ctx.embeddings` for
 * one route. The endpoint base and model are required configuration, because
 * no embedding model name is assumed; the bearer key is resolved per request
 * through the credential seam, so a rotated key reaches the very next batch
 * while an omitted key leaves the request unauthenticated for endpoints that
 * need none.
 * @module @deepseek-ai/dsh-embeddings-http
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { EmbeddingsError } from '@deepseek-ai/dsh-embeddings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { HttpEmbeddingsProvider } from './provider.ts'

export { EMBEDDINGS_HTTP_TIMEOUT, HttpEmbeddingsProvider, readVectors } from './provider.ts'
export type { HttpEmbeddingsOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'embeddings-http'

/** The embeddings seam this provider registers into. */
export const inject = ['embeddings']

/** Route registered when the configuration names none. */
export const DEFAULT_EMBEDDINGS_ROUTE = 'http'

/** Deadline for one embeddings request when the configuration names none. */
export const DEFAULT_EMBEDDINGS_TIMEOUT_MS = 30_000

/** Plugin configuration; `baseURL` and `model` have no assumed default. */
export interface Config {
  /** Route this endpoint serves on `ctx.embeddings`. */
  route?: string
  /**
   * Endpoint base; `/embeddings` is appended. The OpenAI-compatible shape is
   * served by DeepSeek-compatible gateways, Ollama, vLLM, and LM Studio.
   */
  baseURL: string
  /** Embedding model this endpoint serves. */
  model: string
  /**
   * Second model retried once when the primary request fails (a backup
   * `:free`-tier model, for example). Omit for fail-fast. Each attempt gets
   * its own `timeoutMs` deadline.
   */
  fallbackModel?: string
  /** Literal bearer key; prefer {@link Config.apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved per batch; omit for an endpoint that needs no key. */
  apiKeyEnv?: string
  /** Deadline for one request in milliseconds. */
  timeoutMs?: number
}

/** Validated plugin configuration. */
export const Config: z<Config> = z.object({
  route: z.string().default(DEFAULT_EMBEDDINGS_ROUTE),
  baseURL: z.string().required(),
  model: z.string().required(),
  fallbackModel: z.string(),
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref'),
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_EMBEDDINGS_TIMEOUT_MS),
})

/**
 * Register the configured endpoint on the embeddings service.
 * @param ctx - host context carrying the embeddings seam.
 * @param config - endpoint, model, and optional credential reference.
 */
export function apply(ctx: Context, config: Config): void {
  const route = config.route ?? DEFAULT_EMBEDDINGS_ROUTE
  const ref = config.apiKeyEnv
  const resolveKey = async (): Promise<string | undefined> => {
    if (config.apiKey !== undefined) return assertUsableApiKey(config.apiKey, name, 'apiKey')
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(credentialRef(ref))
      if (hit !== undefined) return assertUsableApiKey(hit.value, name, ref)
    } else {
      // Without the seam there is no managed store to rank against, so the
      // launching environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, name, ref)
    }
    throw new EmbeddingsError(
      `${name}: no API key for route "${route}"; store ${ref} through the credentials service,`
      + ` or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }
  ctx.embeddings.registerProvider([route], new HttpEmbeddingsProvider({
    baseURL: config.baseURL,
    model: config.model,
    fallbackModel: config.fallbackModel,
    timeoutMs: config.timeoutMs ?? DEFAULT_EMBEDDINGS_TIMEOUT_MS,
    apiKey: resolveKey,
  }))
}
