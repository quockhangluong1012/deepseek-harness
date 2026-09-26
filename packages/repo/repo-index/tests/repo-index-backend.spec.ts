/** Backend edge cases and config validation for the index service. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import RepoIndex from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** A backend over declared paths whose entries report no size and whose reads are scripted. */
function stubBackend(
  files: Readonly<Record<string, string | Error>>,
  options: { readonly failSecondReadOf?: string } = {},
): unknown {
  const targetOf = (path: string): FsTarget => ({ targetKey: FsTargetKey(path), displayPath: path })
  const reads = new Map<string, number>()
  return {
    resolve: async (path: string) => targetOf(path),
    listDir: async (directory: FsTarget) => {
      const prefix = directory.displayPath === 'root' ? '' : `${directory.displayPath}/`
      const names = new Set<string>()
      const directories = new Set<string>()
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash < 0) names.add(rest)
        else directories.add(rest.slice(0, slash))
      }
      const entries: FsDirEntry[] = []
      for (const name of [...directories].sort()) {
        entries.push({ name, type: 'directory', target: targetOf(`${prefix}${name}`) })
      }
      for (const name of [...names].sort()) entries.push({ name, type: 'file', target: targetOf(`${prefix}${name}`) })
      return entries
    },
    readText: async (target: FsTarget) => {
      const read = (reads.get(target.displayPath) ?? 0) + 1
      reads.set(target.displayPath, read)
      if (target.displayPath === options.failSecondReadOf && read > 1) throw new Error('vanished mid-build')
      const value = files[target.displayPath]
      if (value instanceof Error) throw value
      return value as string
    },
  }
}

/** Mount the index over a stub backend. */
async function mount(
  files: Readonly<Record<string, string | Error>>,
  config: Config = {},
): Promise<Context> {
  const ctx = new Context()
  ctx.provide('fs', stubBackend(files) as never)
  await ctx.plugin(RepoIndex, config)
  return ctx
}

describe('RepoIndex backend edge cases', () => {
  it('skips a file whose text exceeds maxFileBytes after reading it', async () => {
    const ctx = await mount({
      'small.ts': 'export class Small {}\n',
      'large.ts': `export class Large {}\n${'// padding\n'.repeat(32)}`,
    }, { maxFileBytes: 64 })
    const snapshot = await ctx.repoIndex.ensure('root')
    expect(snapshot.symbols.map(symbol => symbol.name)).toEqual(['Small'])
    expect(snapshot.stats).toEqual({ indexed: 1, skippedLarge: 1, capped: false })
    await ctx.fiber.dispose()
  })

  it('leaves an unreadable file out of the index', async () => {
    const ctx = await mount({
      'broken.ts': new Error('unreadable'),
      'ok.ts': 'export class Ok {}\n',
      'sub/deep.ts': 'export class Deep {}\n',
    })
    const snapshot = await ctx.repoIndex.ensure('root')
    expect(snapshot.tree).toEqual(['broken.ts', 'ok.ts', 'sub/deep.ts'])
    expect(snapshot.symbols.map(symbol => symbol.name)).toEqual(['Ok', 'Deep'])
    expect(snapshot.imports).toEqual([])
    expect(snapshot.references).toEqual([])
    expect(snapshot.stats.indexed).toBe(2)
    await ctx.fiber.dispose()
  })

  it('links references to every symbol that shares a name', async () => {
    const ctx = await mount({
      'one.ts': 'export class Twin {}\n',
      'two.ts': 'export class Twin {}\n',
      'user.ts': 'export class Uses {\n  constructor(private readonly twin: Twin) {}\n}\n',
    })
    const snapshot = await ctx.repoIndex.ensure('root')
    expect(snapshot.references).toEqual([
      { from: 'one.ts#Twin', to: 'two.ts#Twin', via: 'mention' },
      { from: 'two.ts#Twin', to: 'one.ts#Twin', via: 'mention' },
      { from: 'user.ts#Uses', to: 'one.ts#Twin', via: 'mention' },
      { from: 'user.ts#Uses', to: 'two.ts#Twin', via: 'mention' },
    ])
    await ctx.fiber.dispose()
  })

  it('drops the references of a file that became unreadable after the first pass', async () => {
    const ctx = new Context()
    ctx.provide('fs', stubBackend({
      'a.ts': 'export class A {}\n',
      'b.ts': 'export class B {\n  constructor(private readonly one: A) {}\n}\n',
    }, { failSecondReadOf: 'a.ts' }) as never)
    await ctx.plugin(RepoIndex)
    const snapshot = await ctx.repoIndex.ensure('root')
    expect(snapshot.symbols.map(symbol => symbol.name)).toEqual(['A', 'B'])
    expect(snapshot.references).toEqual([{ from: 'b.ts#B', to: 'a.ts#A', via: 'mention' }])
    await ctx.fiber.dispose()
  })

  it('reports no references when no indexed file declares a symbol', async () => {
    const ctx = await mount({ 'only.md': '# nothing to index\n' })
    const snapshot = await ctx.repoIndex.ensure('root')
    expect(snapshot.symbols).toEqual([])
    expect(snapshot.references).toEqual([])
    expect(snapshot.stats.indexed).toBe(0)
    await ctx.fiber.dispose()
  })

  it('normalizes extension configuration and rejects unusable bounds', async () => {
    const ctx = await mount({ 'source.TS': 'export class Upper {}\n' }, { extensions: ['TS'] })
    expect((await ctx.repoIndex.ensure('root')).symbols.map(symbol => symbol.name)).toEqual(['Upper'])
    await ctx.fiber.dispose()

    const invalid: Config[] = [
      { maxFiles: 0 },
      { maxFileBytes: -1 },
      { maxSymbols: 1.5 },
      { maxEdges: 0 },
      { maxRoots: 0 },
      { excludeDirs: [] },
      { extensions: [] },
      { extensions: ['.ts', 'TS'] },
    ]
    for (const config of invalid) {
      const failing = new Context()
      failing.provide('fs', stubBackend({}) as never)
      await expect(failing.plugin(RepoIndex, config)).rejects.toThrow(/repo-index: /u)
      await failing.fiber.dispose()
    }
  })
})
