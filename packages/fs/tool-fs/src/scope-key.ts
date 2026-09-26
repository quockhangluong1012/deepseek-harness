/**
 * Concurrency scope keys for model-supplied file paths. One file has many
 * spellings (separators, dot segments, relative or absolute form, and on
 * Windows any case), so the raw argument alone cannot tell whether two calls
 * overlap; resolving and case-folding the path yields one key per file.
 * @module @deepseek-ai/dsh-tool-fs/scope-key
 */

import { posix, win32 } from 'node:path'

/**
 * The concurrency scope key for one tool file path.
 * @param filePath - the path argument as the model supplied it.
 * @param platform - the platform whose rules decide separators and case sensitivity.
 * @returns the absolute path, case-folded on Windows, so two spellings of one file share one key.
 */
export function fileScopeKey(filePath: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === 'win32' ? win32 : posix
  const resolved = paths.resolve(filePath)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}
