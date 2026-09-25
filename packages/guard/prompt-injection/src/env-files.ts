/**
 * Filename patterns this guard denies reading by default: `.env` and its
 * variants, plus a short list of well-known credential filenames. This is
 * not an exhaustive credential-file detector — see the package README's
 * Known Limitations.
 * @module @deepseek-ai/dsh-prompt-injection/env-files
 */

/** Exact basenames denied regardless of extension, compared case-insensitively. */
const DENIED_BASENAMES = new Set(['.npmrc', '.netrc', '.pgpass', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'])

/** `.env`, `.env.local`, `.env.production`, and similar, case-insensitively. */
const ENV_FILE_PATTERN = /^\.env(?:\..+)?$/i

/**
 * @param path - a path-shaped argument value; any separator style is accepted.
 * @returns the final path segment, without relying on the host platform's path module.
 */
function fileNameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}

/**
 * Test one path argument against the credential-file denylist, matching the
 * basename only so any directory prefix is accepted.
 * @param path - candidate path argument.
 * @returns whether the path names a file denied by default.
 */
export function isDeniedCredentialPath(path: string): boolean {
  const name = fileNameOf(path)
  return ENV_FILE_PATTERN.test(name) || DENIED_BASENAMES.has(name.toLowerCase())
}

/**
 * Find the first denied path among a tool call's top-level string arguments.
 * @param args - the call's parsed arguments (arbitrary shape; non-objects find nothing).
 * @returns the first denied path, or undefined.
 */
export function deniedPathIn(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && isDeniedCredentialPath(value)) return value
  }
  return undefined
}
