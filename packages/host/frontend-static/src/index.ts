/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: serves the built frontend directory with explicit index
 * entry points. A readable index renders at the dist root and configured index
 * path; missing paths return 404, traversal outside the dist root is 403,
 * unknown extensions ship as octet-stream, and non-GET/HEAD is 405. Every
 * index response first passes Connection's browser authentication, then the
 * webserver's index render (structured injection rows, then raw taps).
 * Non-index assets stay public. The dist location is workspace knowledge of
 * the composing application, so `distIndex` is typically supplied through a
 * `!!js` expression, never hardcoded by a deployment.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import type { ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Services required before the authenticated fallback seat can be claimed. */
export const inject = ['webServer', 'connection']

/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
})

const HTML_MIME = 'text/html; charset=utf-8'

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  // The packed VFS image. Served as its own bytes, never as a Content-Encoding:
  // the worker inflates the body itself, and a transport-level encoding would
  // leave it inflating an already-decoded archive.
  '.gz': 'application/gzip',
}

const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/** One cached non-index asset, validated by filesystem identity. */
export interface StaticAssetEntry {
  /** Modification time the body was read at, in milliseconds. */
  mtimeMs: number
  /** Byte length the body was read at. */
  size: number
  /** Opaque validator derived from the identity above. */
  etag: string
  /** MIME type resolved from the file extension. */
  type: string
  /** File bytes. */
  body: Buffer
}

/**
 * Maximum cached assets per fallback registration. An internal bound, not a
 * deployment choice: entries self-invalidate on filesystem identity, so the
 * worst case of a small bound is a re-read, never staleness.
 */
const ASSET_CACHE_MAX_ENTRIES = 100

/**
 * Serve one GET/HEAD static request from the dist root.
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param authorizeIndex - authenticates an index response before its bytes are read.
 * @param renderIndex - produces the index.html body (structured injection
 * rendering) for the dist root and configured index path.
 * @param options - conditional-request validator and asset cache. The index
 * path always renders fresh (per-request injections) and never consults the
 * cache; assets are validated by `stat` identity (mtime plus size — a
 * same-tick same-size rewrite is served until the identity moves, which the
 * content-hashed Vite output names make harmless in practice).
 */
export async function serveStatic(
  pathname: string, res: ServerResponse, distRoot: string, distIndex: string,
  authorizeIndex: () => boolean,
  renderIndex: () => Promise<string>,
  options?: { ifNoneMatch?: string | undefined; cache?: Map<string, StaticAssetEntry> | undefined },
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  let body: string | Buffer
  let type: string
  try {
    if (target === distRoot || target === distIndex) {
      if (!authorizeIndex()) return
      body = await renderIndex()
      type = HTML_MIME
    } else {
      const identity = await stat(target)
      const cached = options?.cache?.get(target)
      if (cached !== undefined && cached.mtimeMs === identity.mtimeMs && cached.size === identity.size) {
        body = cached.body
        type = cached.type
      } else {
        body = await readFile(target)
        type = MIME[extname(target)] ?? 'application/octet-stream'
        if (options?.cache !== undefined) {
          if (options.cache.size >= ASSET_CACHE_MAX_ENTRIES) {
            const oldest = options.cache.keys().next()
            if (!oldest.done) options.cache.delete(oldest.value)
          }
          options.cache.set(target, {
            mtimeMs: identity.mtimeMs,
            size: identity.size,
            etag: `"${Math.floor(identity.mtimeMs).toString(16)}-${identity.size.toString(16)}"`,
            type,
            body: Buffer.isBuffer(body) ? body : Buffer.from(body),
          })
        }
      }
      const entry = options?.cache?.get(target)
      const etag = entry?.etag
      if (etag !== undefined && options?.ifNoneMatch === etag) {
        res.writeHead(304, { etag })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': type, ...(etag === undefined ? {} : { etag }) })
      res.end(body)
      return
    }
  } catch (error) {
    // Only absent or non-file targets are 404; other filesystem failures reach
    // the webserver's request-failure handling.
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': type })
  res.end(body)
}

/**
 * Claim the webserver fallback seat and serve the dist.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  // Insert after all index transforms so the base precedes every resource reference.
  const renderIndex = async (): Promise<string> => {
    const body = ctx.webServer.renderIndex(await readFile(distIndex, 'utf8'))
    return body.replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./">`)
  }
  // Fiber-scoped asset cache: released with the fallback seat on disposal, so
  // HMR row swaps never serve another composition's bytes.
  const assets = new Map<string, StaticAssetEntry>()
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    const ifNoneMatch = req.headers['if-none-match']
    await serveStatic(
      decodeURIComponent(rawPath),
      res,
      distRoot,
      distIndex,
      () => ctx.connection.authorizeIndex(req, res),
      renderIndex,
      { ifNoneMatch: Array.isArray(ifNoneMatch) ? undefined : ifNoneMatch, cache: assets },
    )
  }), 'frontend-static: fallback seat')
}
