/**
 * Cordis-free retrieval mechanics for the local artifact backend: validate a
 * stored locator, list a session's artifacts, read a line window, project
 * matching lines, diff two texts, and retain a head/tail summary under a byte
 * budget. `./artifacts.ts` maps service requests onto these functions, so the
 * mechanics are unit-testable without a context.
 *
 * @module @deepseek-ai/dsh-spill-local/retrieve
 */

import { lstat, readdir, readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { structuredPatch } from 'diff'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { ArtifactLocatorError } from '@deepseek-ai/dsh-spill'
import type { ArtifactLine } from '@deepseek-ai/dsh-spill'
import { SESSION_DIR_RE } from './cleanup.ts'
import { isErrno, sessionDir } from './store.ts'

/** Unchanged lines {@link unifiedDiff} shows on each side of a change when the request omits `context`. */
export const ARTIFACT_DIFF_CONTEXT = 3

/** One stored artifact file of a session directory. */
export interface StoredArtifact {
  /** Absolute path — the locator the writing backend returned for this file. */
  path: string
  /** Stored leaf name: the collision-resistant prefix plus the sanitized suggested name. */
  name: string
  /** File size in bytes, the artifact's exact UTF-8 text length. */
  bytes: number
  /** Modification time as an ISO 8601 timestamp. */
  savedAt: string
}

/** The line window one {@link readWindow} call returned. */
export interface ReadWindow {
  text: string
  bytes: number
  lines: number
  totalBytes: number
  totalLines: number
  truncated: boolean
}

/** The matching lines one {@link projectMatches} call returned. */
export interface ProjectedLines {
  matches: ArtifactLine[]
  totalMatches: number
  truncated: boolean
}

/** The line comparison one {@link unifiedDiff} call returned. */
export interface UnifiedDiff {
  patch: string
  added: number
  deleted: number
}

/** The retained ends one {@link retainWithin} call returned. */
export interface RetainedEnds {
  text: string
  bytes: number
  totalBytes: number
  omittedBytes: number
  truncated: boolean
}

/**
 * Split stored text into lines: `\n`-separated segments where a trailing newline
 * adds no empty final line and empty text has no lines.
 * @param text - the stored text.
 * @returns the text's lines, without a trailing empty segment.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Resolve a locator to the file path it names, refusing anything this backend
 * did not store: a path outside the root, a path not shaped
 * `<root>/session-<hash>/<name>`, or a name with no file segment.
 * @param root - the resolved absolute spill root.
 * @param locator - the locator a retrieval request named.
 * @returns the resolved absolute artifact path.
 * @throws ArtifactLocatorError when the locator is not a stored artifact path.
 */
export function storedArtifactPath(root: string, locator: string): string {
  const candidate = resolve(locator)
  const prefix = root.endsWith(sep) ? root : root + sep
  const relative = candidate.startsWith(prefix) ? candidate.slice(prefix.length) : undefined
  const [sessionSegment, leafSegment, ...extra] = relative?.split(sep) ?? []
  if (sessionSegment === undefined || leafSegment === undefined || extra.length > 0
    || !SESSION_DIR_RE.test(sessionSegment) || leafSegment.length === 0) {
    throw new ArtifactLocatorError(locator, 'is not a stored artifact of this backend')
  }
  return candidate
}

/**
 * Read one stored artifact's text. Refuses a locator for an unknown path and for
 * every entry that is not a regular file — the backend writes only exclusive
 * regular files, so a directory or symlink is never a stored artifact.
 * @param root - the resolved absolute spill root.
 * @param locator - the locator to read.
 * @returns the stored text, verbatim.
 * @throws ArtifactLocatorError when the locator names no regular file this backend stored.
 */
export async function readStoredArtifact(root: string, locator: string): Promise<string> {
  const path = storedArtifactPath(root, locator)
  let stats
  try {
    stats = await lstat(path)
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) throw new ArtifactLocatorError(locator, 'does not exist')
    throw error
  }
  if (!stats.isFile()) throw new ArtifactLocatorError(locator, 'is not a stored regular file')
  return await readFile(path, 'utf8')
}

/**
 * List one session's stored artifacts, newest first. A session directory that
 * does not exist has no artifacts.
 * @param root - the resolved absolute spill root.
 * @param sessionId - the owning session whose artifacts to list.
 * @param name - stored-name substring to match; omitted lists every artifact.
 * @returns the matching artifacts, newest first and name-ordered within one modification time.
 */
export async function listStoredArtifacts(root: string, sessionId: string, name?: string): Promise<StoredArtifact[]> {
  const dir = sessionDir(root, sessionId)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) return []
    throw error
  }
  const artifacts: StoredArtifact[] = []
  for (const entry of entries) {
    if (!entry.isFile() || (name !== undefined && !entry.name.includes(name))) continue
    const path = resolve(dir, entry.name)
    let stats
    try {
      stats = await lstat(path)
    } catch (error: unknown) {
      // The file vanished between readdir and lstat; it is no longer an artifact.
      if (isErrno(error, 'ENOENT')) continue
      throw error
    }
    if (!stats.isFile()) continue
    artifacts.push({ path, name: entry.name, bytes: stats.size, savedAt: stats.mtime.toISOString() })
  }
  return artifacts.sort((left, right) =>
    right.savedAt.localeCompare(left.savedAt) || left.name.localeCompare(right.name))
}

/**
 * Project the requested 1-based line window of stored text. An `offset` below 1
 * starts at line 1 and a `limit` below 0 returns no line; either being omitted
 * returns whole and remaining lines respectively.
 * @param text - the stored text.
 * @param offset - 1-based first line of the window, or `undefined` for line 1.
 * @param limit - maximum lines in the window, or `undefined` for all remaining lines.
 * @returns the window text and both the window's and the artifact's sizes.
 */
export function readWindow(text: string, offset: number | undefined, limit: number | undefined): ReadWindow {
  const lines = splitLines(text)
  const start = Math.min(lines.length, Math.max(0, (offset ?? 1) - 1))
  const count = limit === undefined ? lines.length - start : Math.max(0, limit)
  const window = lines.slice(start, start + count)
  const windowText = window.join('\n')
  return {
    text: windowText,
    bytes: Buffer.byteLength(windowText, 'utf8'),
    lines: window.length,
    totalBytes: Buffer.byteLength(text, 'utf8'),
    totalLines: lines.length,
    truncated: window.length !== lines.length,
  }
}

/**
 * Project the lines matching a regular expression, in artifact order.
 * @param text - the stored text.
 * @param pattern - JavaScript regular expression source, tested per line without flags.
 * @param limit - maximum matches returned, or `undefined` for every match.
 * @returns the matching lines with 1-based line numbers and the complete match count.
 * @throws SyntaxError when `pattern` is not a valid regular expression.
 */
export function projectMatches(text: string, pattern: string, limit: number | undefined): ProjectedLines {
  const regexp = new RegExp(pattern)
  const matches: ArtifactLine[] = []
  for (const [index, line] of splitLines(text).entries()) {
    if (regexp.test(line)) matches.push({ line: index + 1, text: line })
  }
  const totalMatches = matches.length
  if (limit !== undefined) matches.length = Math.max(0, Math.min(totalMatches, limit))
  return { matches, totalMatches, truncated: matches.length < totalMatches }
}

/**
 * Compare two texts line by line into one unified patch.
 * @param left - the "before" text.
 * @param right - the "after" text.
 * @param context - unchanged lines shown on each side of a change.
 * @returns the patch (empty when the texts are identical) and the added/deleted line counts.
 */
export function unifiedDiff(left: string, right: string, context: number): UnifiedDiff {
  const patch = structuredPatch('', '', left, right, undefined, undefined, { context })
  const body: string[] = []
  let added = 0
  let deleted = 0
  for (const hunk of patch.hunks) {
    body.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) {
      // The missing-trailing-newline marker annotates the patch, not the content.
      if (line.startsWith('\\')) continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) deleted += 1
      body.push(line)
    }
  }
  return { patch: body.join('\n'), added, deleted }
}

/**
 * Retain a text's head and tail under a byte budget, cutting on UTF-8
 * boundaries, with the exact middle byte count a retrieval notice reports.
 * @param text - the stored text.
 * @param maxBytes - maximum UTF-8 bytes of the returned text; a negative budget retains nothing.
 * @returns the retained ends and the omitted byte count.
 */
export function retainWithin(text: string, maxBytes: number): RetainedEnds {
  const totalBytes = Buffer.byteLength(text, 'utf8')
  const budget = Math.max(0, Math.floor(maxBytes))
  const headBytes = Math.ceil(budget / 2)
  const retainer = new TextRetainer({ kind: 'headTail', headBytes, tailBytes: budget - headBytes })
  retainer.push(text)
  const retained = retainer.finish()
  const bytes = Buffer.byteLength(retained.text, 'utf8')
  return {
    text: retained.text,
    bytes,
    totalBytes,
    omittedBytes: totalBytes - bytes,
    truncated: retained.truncated,
  }
}
