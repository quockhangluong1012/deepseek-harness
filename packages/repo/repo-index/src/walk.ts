/**
 * The bounded directory walk behind one repository index build: it resolves
 * the root once, lists each directory at most once, and returns the file
 * entries in ascending path order together with a digest of the freshness
 * facts a later build compares against.
 *
 * The walk never reads file contents, and it stops as soon as `maxFiles`
 * entries exist, so a workspace larger than the bound costs the tree it
 * returned rather than the whole tree. Freshness facts come from the
 * filesystem backend: an entry that reports no version token contributes its
 * size only, so a same-size edit is invisible to the digest until the caller
 * invalidates the index.
 * @module @deepseek-ai/dsh-repo-index/walk
 */

import { createHash } from 'node:crypto'
import type { FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'

/** The two filesystem reads the walk needs; `ctx.fs` satisfies it. */
export interface WalkFileSystem {
  /**
   * Resolve the walk root into a stable target identity.
   * @param path - the workspace root path.
   * @param opts - resolution options; the walk forwards its cancellation signal.
   * @returns the resolved root target.
   */
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  /**
   * List one directory's direct children.
   * @param target - the directory to list.
   * @param signal - the walk's cancellation signal.
   * @returns the directory's entries.
   */
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
}

/** One walked file: its repository-relative path, its target, and the freshness facts the digest covers. */
export interface WalkEntry {
  /** Repository-relative, `/`-separated path. */
  readonly path: string
  /** The resolved target a later read uses. */
  readonly target: FsTarget
  /** Reported byte size, or 0 when the backend reports none. */
  readonly size: number
  /** The backend's opaque freshness token, or an empty string when it reports none. */
  readonly version: string
}

/** What one walk returned. */
export interface WalkResult {
  /** The root as the backend resolved it; its target identity is the index cache key. */
  readonly root: FsTarget
  /** Files in ascending path order, at most `maxFiles`. */
  readonly entries: readonly WalkEntry[]
  /** Whether `maxFiles` stopped the walk before the tree was exhausted. */
  readonly capped: boolean
  /** Digest of every returned entry's path, freshness token, and size. */
  readonly fingerprint: string
}

/** The walk's caller-owned bounds. */
export interface WalkOptions {
  /** Maximum returned entries; the walk stops once the tree supplied this many. */
  readonly maxFiles: number
  /** Directory basenames the walk never descends into. */
  readonly excludeDirs: readonly string[]
}

/** Code-unit basename order, so one machine's traversal matches another's. */
function byName(left: FsDirEntry, right: FsDirEntry): number {
  if (left.name < right.name) return -1
  /* v8 ignore next -- one listing cannot report the same basename twice; the 0 keeps the comparator well-formed */
  if (left.name === right.name) return 0
  return 1
}

/** Digest one walk's freshness facts; the index cache compares exactly this string. */
function fingerprintOf(entries: readonly WalkEntry[]): string {
  const hash = createHash('sha256')
  for (const entry of entries) hash.update(`${entry.path}\u0000${entry.version}\u0000${String(entry.size)}\n`)
  return hash.digest('hex')
}

/**
 * Walk one workspace root.
 * @param fs - the filesystem reads to use.
 * @param rootPath - the workspace root path, resolved through `fs.resolve`.
 * @param options - the file and directory bounds.
 * @param signal - cancellation checked between directories and forwarded to every filesystem call.
 * @returns the file entries in ascending path order, whether the file bound cut the walk, and their digest.
 */
export async function walkRepository(
  fs: WalkFileSystem,
  rootPath: string,
  options: WalkOptions,
  signal?: AbortSignal,
): Promise<WalkResult> {
  const excluded = new Set(options.excludeDirs)
  const root = await fs.resolve(rootPath, signal === undefined ? {} : { signal })
  // A directory the walk already listed is skipped, so a backend that
  // surfaces a link as a directory cannot make the walk revisit a subtree.
  const visited = new Set<string>([String(root.targetKey)])
  const entries: WalkEntry[] = []
  let capped = false

  const visit = async (target: FsTarget, prefix: string): Promise<void> => {
    signal?.throwIfAborted()
    for (const child of [...await fs.listDir(target, signal)].sort(byName)) {
      if (capped) return
      const path = prefix === '' ? child.name : `${prefix}/${child.name}`
      if (child.type === 'directory') {
        const key = String(child.target.targetKey)
        if (excluded.has(child.name) || visited.has(key)) continue
        visited.add(key)
        await visit(child.target, path)
        continue
      }
      if (child.type !== 'file') continue
      if (entries.length >= options.maxFiles) {
        capped = true
        return
      }
      entries.push({
        path,
        target: child.target,
        size: child.size ?? 0,
        version: child.version ?? '',
      })
    }
  }

  await visit(root, '')
  return { root, entries, capped, fingerprint: fingerprintOf(entries) }
}
