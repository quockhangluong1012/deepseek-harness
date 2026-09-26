/** The index service over a real local filesystem: build, cache reuse, invalidation, and bounds. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import RepoIndex from '../src/index.ts'
import type { Config } from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

const CONTROLLER = [
  "import { AuthService } from './auth-service'",
  "import { Context } from '@deepseek-ai/dsh-cordis'",
  '',
  'export class AuthController {',
  '  constructor(private readonly service: AuthService) {}',
  '}',
].join('\n')

const SERVICE = [
  "import { AuthRepository } from './auth-repository'",
  '',
  'export class AuthService {',
  '  constructor(private readonly repository: AuthRepository) {}',
  '}',
].join('\n')

const REPOSITORY = 'export class AuthRepository {}\n'

/** One mounted service over a freshly written workspace. */
async function fixture(files: Readonly<Record<string, string>>, config: Config = {}): Promise<{
  ctx: Context
  root: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repo-index-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'node_modules'), { recursive: true })
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(RepoIndex, config)
  return { ctx, root }
}

const WORKSPACE = {
  'auth/auth-controller.ts': CONTROLLER,
  'auth/auth-service.ts': SERVICE,
  'auth/auth-repository.ts': REPOSITORY,
  'notes.md': '# notes\n',
  'node_modules/ignored.ts': 'export class Ignored {}\n',
}

describe('RepoIndex', () => {
  it('indexes declarations, module edges, and symbol references', async () => {
    const { ctx, root } = await fixture(WORKSPACE, { maxFileBytes: 64 * 1024 })
    const snapshot = await ctx.repoIndex.ensure(root)
    expect(snapshot.root.endsWith(basename(root))).toBe(true)
    expect(snapshot.tree).toEqual([
      'auth/auth-controller.ts',
      'auth/auth-repository.ts',
      'auth/auth-service.ts',
      'notes.md',
    ])
    expect(snapshot.symbols.map(symbol => `${symbol.path}#${symbol.name}:${symbol.kind}:${String(symbol.line)}`)).toEqual([
      'auth/auth-controller.ts#AuthController:class:4',
      'auth/auth-repository.ts#AuthRepository:class:1',
      'auth/auth-service.ts#AuthService:class:3',
    ])
    expect(snapshot.imports).toEqual([
      { from: 'auth/auth-controller.ts', specifier: './auth-service', resolution: 'indexed', to: 'auth/auth-service.ts' },
      { from: 'auth/auth-controller.ts', specifier: '@deepseek-ai/dsh-cordis', resolution: 'external' },
      { from: 'auth/auth-service.ts', specifier: './auth-repository', resolution: 'indexed', to: 'auth/auth-repository.ts' },
    ])
    expect(snapshot.references).toEqual([
      { from: 'auth/auth-controller.ts#AuthController', to: 'auth/auth-service.ts#AuthService', via: 'mention' },
      { from: 'auth/auth-service.ts#AuthService', to: 'auth/auth-repository.ts#AuthRepository', via: 'mention' },
    ])
    expect(snapshot.stats).toEqual({ indexed: 3, skippedLarge: 0, capped: false })
  }, 30_000)

  it('reuses the cached snapshot until the walk fingerprint changes', async () => {
    const { ctx, root } = await fixture(WORKSPACE)
    const first = await ctx.repoIndex.ensure(root)
    expect(await ctx.repoIndex.ensure(root)).toBe(first)
    await writeFile(join(root, 'auth/auth-repository.ts'), `${REPOSITORY}export class AuthToken {}\n`)
    const rebuilt = await ctx.repoIndex.ensure(root)
    expect(rebuilt).not.toBe(first)
    expect(rebuilt.symbols.map(symbol => symbol.name)).toContain('AuthToken')
    ctx.repoIndex.invalidate()
    const invalidated = await ctx.repoIndex.ensure(root)
    expect(invalidated).not.toBe(rebuilt)
    expect(invalidated.symbols.map(symbol => symbol.name)).toEqual(rebuilt.symbols.map(symbol => symbol.name))
  }, 30_000)

  it('bounds the tree, the symbols, and the references', async () => {
    const files = {
      'a.ts': 'export class A {}\nexport class B {}\n',
      'b.ts': 'export class C {}\n',
      'c.ts': 'export class D {}\n',
    }
    const filesFixture = await fixture(files, { maxFiles: 2 })
    const treeCapped = await filesFixture.ctx.repoIndex.ensure(filesFixture.root)
    expect(treeCapped.tree).toEqual(['a.ts', 'b.ts'])
    expect(treeCapped.stats.capped).toBe(true)

    const symbolFixture = await fixture(files, { maxSymbols: 1 })
    const symbolCapped = await symbolFixture.ctx.repoIndex.ensure(symbolFixture.root)
    expect(symbolCapped.symbols.map(symbol => symbol.name)).toEqual(['A'])
    expect(symbolCapped.stats.capped).toBe(true)

    const edgeFixture = await fixture(WORKSPACE, { maxEdges: 1 })
    const edgeCapped = await edgeFixture.ctx.repoIndex.ensure(edgeFixture.root)
    expect(edgeCapped.references).toEqual([
      { from: 'auth/auth-controller.ts#AuthController', to: 'auth/auth-service.ts#AuthService', via: 'mention' },
    ])
    expect(edgeCapped.stats.capped).toBe(true)
  }, 30_000)

  it('skips files over maxFileBytes without reading them', async () => {
    const { ctx, root } = await fixture({ 'big.ts': `export class Big {}\n${'// padding\n'.repeat(64)}` }, {
      maxFileBytes: 32,
    })
    const snapshot = await ctx.repoIndex.ensure(root)
    expect(snapshot.tree).toEqual(['big.ts'])
    expect(snapshot.symbols).toEqual([])
    expect(snapshot.stats).toEqual({ indexed: 0, skippedLarge: 1, capped: false })
  }, 30_000)

  it('evicts the least recently used root past maxRoots', async () => {
    const { ctx, root } = await fixture({
      'one/a.ts': 'export class A {}\n',
      'two/b.ts': 'export class B {}\n',
    }, { maxRoots: 1 })
    const first = await ctx.repoIndex.ensure(join(root, 'one'))
    const second = await ctx.repoIndex.ensure(join(root, 'two'))
    expect(second.symbols.map(symbol => symbol.name)).toEqual(['B'])
    expect(await ctx.repoIndex.ensure(join(root, 'two'))).toBe(second)
    expect(await ctx.repoIndex.ensure(join(root, 'one'))).not.toBe(first)
  }, 30_000)
})

/** One manifest's text, with the key order the fixture declares. */
function manifest(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** A workspace with two packages, a test tree, a configuration declaration, and every resolution outcome. */
const GRAPHS = {
  'package.json': manifest({ name: 'graph-root', private: true }),
  'packages/core/package.json': manifest({ name: '@deepseek-ai/dsh-core', version: '1.0.0' }),
  'packages/app/package.json': manifest({
    name: '@deepseek-ai/dsh-app',
    version: '1.0.0',
    dependencies: { '@deepseek-ai/dsh-core': 'workspace:*', zod: '^4.0.0' },
    devDependencies: { vitest: '^4.0.0' },
    peerDependencies: { '@deepseek-ai/cordis': 'workspace:~' },
    optionalDependencies: { fsevents: '^2.3.0' },
  }),
  'packages/app/src/config.ts': [
    'export interface Config {',
    '  mode?: string',
    '}',
    'export const Config: z<Config> = z.object({ mode: z.string(), retries: z.number() })',
    'export function apply(config: Config): void {',
    '  void config.mode',
    '  void config.retries',
    '}',
  ].join('\n'),
  'packages/app/src/uses.ts': [
    "import { apply } from './config'",
    "import { select } from '@deepseek-ai/dsh-core/src/select'",
    "import { z } from 'zod'",
    "import { gone } from './gone'",
    '',
    'export function boot(): void {',
    '  apply({})',
    '  select()',
    '}',
  ].join('\n'),
  'packages/core/src/helper.ts': 'export const helper = 1\n',
  'packages/core/src/select.ts': 'export function select(): string {\n  return "selected"\n}\n',
  'packages/core/tests/helper.spec.ts': 'export function exercisesHelper(): void {\n}\n',
  'packages/core/tests/orphan.spec.ts': 'export function exercisesNothing(): void {\n}\n',
  'packages/core/tests/select.spec.ts': [
    "import { select } from '../src/select'",
    '',
    'export function exercisesSelect(): void {',
    '  select()',
    '}',
  ].join('\n'),
}

describe('derived graphs', () => {
  it('derives the test graph, the package graph, and the configuration graph together', async () => {
    const { ctx, root } = await fixture(GRAPHS)
    const snapshot = await ctx.repoIndex.ensure(root)

    expect(snapshot.tests).toEqual([
      { path: 'packages/core/tests/helper.spec.ts', covers: [{ subject: 'packages/core/src/helper.ts', via: 'naming' }] },
      { path: 'packages/core/tests/orphan.spec.ts', covers: [] },
      { path: 'packages/core/tests/select.spec.ts', covers: [{ subject: 'packages/core/src/select.ts', via: 'import' }] },
    ])

    expect(snapshot.packages).toEqual([
      { path: 'package.json', name: 'graph-root', dependencies: [] },
      {
        path: 'packages/app/package.json',
        name: '@deepseek-ai/dsh-app',
        dependencies: [
          { name: '@deepseek-ai/dsh-core', scope: 'runtime', range: 'workspace:*', to: 'packages/core/package.json' },
          { name: 'zod', scope: 'runtime', range: '^4.0.0' },
          { name: 'vitest', scope: 'dev', range: '^4.0.0' },
          { name: '@deepseek-ai/cordis', scope: 'peer', range: 'workspace:~' },
          { name: 'fsevents', scope: 'optional', range: '^2.3.0' },
        ],
      },
      { path: 'packages/core/package.json', name: '@deepseek-ai/dsh-core', dependencies: [] },
    ])

    expect(snapshot.configs).toEqual([
      { path: 'packages/app/src/config.ts', binding: 'Config', fields: [{ name: 'mode', derivedFrom: 'interface' }] },
      {
        path: 'packages/app/src/config.ts',
        binding: 'Config',
        fields: [{ name: 'mode', derivedFrom: 'schema' }, { name: 'retries', derivedFrom: 'schema' }],
      },
    ])
    expect(snapshot.configReads).toEqual([
      { from: 'packages/app/src/config.ts', field: 'mode' },
      { from: 'packages/app/src/config.ts', field: 'retries' },
    ])
  }, 30_000)

  it('reports one resolution per import, with a target only where the specifier resolved to it', async () => {
    const { ctx, root } = await fixture(GRAPHS)
    const snapshot = await ctx.repoIndex.ensure(root)

    expect(snapshot.imports).toEqual([
      { from: 'packages/app/src/uses.ts', specifier: './config', resolution: 'indexed', to: 'packages/app/src/config.ts' },
      {
        from: 'packages/app/src/uses.ts',
        specifier: '@deepseek-ai/dsh-core/src/select',
        resolution: 'workspace-package',
        package: '@deepseek-ai/dsh-core',
      },
      { from: 'packages/app/src/uses.ts', specifier: 'zod', resolution: 'external' },
      { from: 'packages/app/src/uses.ts', specifier: './gone', resolution: 'unresolved' },
      {
        from: 'packages/core/tests/select.spec.ts',
        specifier: '../src/select',
        resolution: 'indexed',
        to: 'packages/core/src/select.ts',
      },
    ])

    // The variant decides which fields exist, so a reader cannot take an
    // unresolved specifier for a resolved one.
    for (const edge of snapshot.imports) {
      const fields = Object.keys(edge).sort()
      if (edge.resolution === 'indexed') expect(fields).toEqual(['from', 'resolution', 'specifier', 'to'])
      else if (edge.resolution === 'workspace-package') expect(fields).toEqual(['from', 'package', 'resolution', 'specifier'])
      else expect(fields).toEqual(['from', 'resolution', 'specifier'])
    }
  }, 30_000)

  it('separates a called name from a name the block only mentions', async () => {
    const { ctx, root } = await fixture(GRAPHS)
    const snapshot = await ctx.repoIndex.ensure(root)

    expect(snapshot.references).toEqual([
      { from: 'packages/app/src/config.ts#apply', to: 'packages/app/src/config.ts#Config', via: 'mention' },
      { from: 'packages/app/src/uses.ts#boot', to: 'packages/app/src/config.ts#apply', via: 'call' },
      { from: 'packages/app/src/uses.ts#boot', to: 'packages/core/src/select.ts#select', via: 'call' },
      {
        from: 'packages/core/tests/select.spec.ts#exercisesSelect',
        to: 'packages/core/src/select.ts#select',
        via: 'call',
      },
    ])
  }, 30_000)
})
