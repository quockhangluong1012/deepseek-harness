/** The bounded walk: path order, exclusions, cycles, truncation, and the freshness digest. */
import { describe, expect, it } from 'vitest'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { walkRepository } from '../src/walk.ts'
import type { WalkFileSystem } from '../src/walk.ts'

/** One stub directory child, as the backend would report it. */
interface StubChild {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly key?: string
  readonly size?: number
  readonly version?: string
}

/** A backend over predeclared directory listings keyed by target identity. */
function stubFs(listings: Readonly<Record<string, readonly StubChild[]>>): WalkFileSystem {
  const targetOf = (key: string): FsTarget => ({ targetKey: FsTargetKey(key), displayPath: `/repo/${key}` })
  return {
    resolve: async (path: string) => targetOf(path),
    listDir: async (directory: FsTarget) => {
      const children = listings[String(directory.targetKey)]
      if (children === undefined) throw new Error(`stub: no listing for ${String(directory.targetKey)}`)
      return children.map(child => ({
        name: child.name,
        type: child.type,
        target: targetOf(child.key ?? `${String(directory.targetKey)}/${child.name}`),
        ...child.size === undefined ? {} : { size: child.size },
        ...child.version === undefined ? {} : { version: FsVersion(child.version) },
      }))
    },
  }
}

const TREE = {
  root: [
    { name: 'b.ts', type: 'file', size: 12, version: 'v1' },
    { name: 'a.ts', type: 'file', size: 3 },
    { name: 'node_modules', type: 'directory' },
    { name: 'src', type: 'directory' },
    { name: 'link', type: 'other' },
  ],
  'root/src': [
    { name: 'c.ts', type: 'file', size: 7, version: 'v2' },
    { name: 'sub', type: 'directory' },
  ],
  'root/src/sub': [
    { name: 'd.ts', type: 'file', size: 1, version: 'v3' },
    // A backend that surfaces a link as a directory must not make the walk revisit a subtree.
    { name: 'cycle', type: 'directory', key: 'root' },
  ],
} as const

const OPTIONS = { maxFiles: 100, excludeDirs: ['node_modules'] }

describe('walkRepository', () => {
  it('returns files in ascending path order with their freshness facts', async () => {
    const walked = await walkRepository(stubFs(TREE), 'root', OPTIONS)
    expect(walked.root.displayPath).toBe('/repo/root')
    expect(walked.entries.map(entry => entry.path)).toEqual([
      'a.ts',
      'b.ts',
      'src/c.ts',
      'src/sub/d.ts',
    ])
    expect(walked.entries.map(entry => entry.size)).toEqual([3, 12, 7, 1])
    expect(walked.entries.map(entry => entry.version)).toEqual(['', 'v1', 'v2', 'v3'])
    expect(walked.capped).toBe(false)
  })

  it('digests the paths, versions, and sizes it returned', async () => {
    const first = await walkRepository(stubFs(TREE), 'root', OPTIONS)
    const repeat = await walkRepository(stubFs(TREE), 'root', OPTIONS)
    expect(repeat.fingerprint).toBe(first.fingerprint)
    const edited = await walkRepository(stubFs({
      ...TREE,
      'root/src': [{ name: 'c.ts', type: 'file', size: 7, version: 'v9' }],
    }), 'root', OPTIONS)
    expect(edited.fingerprint).not.toBe(first.fingerprint)
  })

  it('stops at maxFiles and reports the truncation', async () => {
    const walked = await walkRepository(stubFs(TREE), 'root', { ...OPTIONS, maxFiles: 2 })
    expect(walked.entries.map(entry => entry.path)).toEqual(['a.ts', 'b.ts'])
    expect(walked.capped).toBe(true)
  })

  it('keeps no further sibling after a subtree hits maxFiles', async () => {
    const walked = await walkRepository(stubFs({
      root: [
        { name: 'src', type: 'directory' },
        { name: 'z.ts', type: 'file', size: 1, version: 'v1' },
      ],
      'root/src': [
        { name: 'a.ts', type: 'file', size: 1, version: 'v1' },
        { name: 'b.ts', type: 'file', size: 1, version: 'v1' },
      ],
    }), 'root', { ...OPTIONS, maxFiles: 1 })
    expect(walked.entries.map(entry => entry.path)).toEqual(['src/a.ts'])
    expect(walked.capped).toBe(true)
  })

  it('honors cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(walkRepository(stubFs(TREE), 'root', OPTIONS, controller.signal)).rejects.toThrow()
  })
})
