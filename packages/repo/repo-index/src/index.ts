/**
 * The repository index service (`ctx.repoIndex`): one bounded, lazily built
 * index of a workspace root, re-derived only when the walk's fingerprint or an
 * explicit `invalidate()` says the tree changed.
 *
 * A build walks the tree without reading contents, reads only the files whose
 * configured extension and reported size admit them, derives declarations,
 * import specifiers, and header-block references from line facts, and discards
 * every file's text before the next read. `maxFiles`, `maxFileBytes`,
 * `maxSymbols`, and `maxEdges` bound the result, and a cache hit costs one
 * walk of directory metadata and no content read.
 * @module @deepseek-ai/dsh-repo-index
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import { extractFile, headerReferences, resolveRelative, resolveSpecifier, workspacePackageOf } from './extract.ts'
import type { RepoDeclaration } from './extract.ts'
import { configOf, packageGraphOf, testNodesOf } from './graphs.ts'
import type { RepoManifestText } from './graphs.ts'
import { walkRepository } from './walk.ts'
import type { WalkEntry, WalkResult } from './walk.ts'
import type {
  RepoConfigNode,
  RepoConfigReadEdge,
  RepoIndexService,
  RepoIndexSnapshot,
  RepoModuleEdge,
  RepoSymbol,
  RepoSymbolEdge,
} from './types.ts'

export type {
  RepoConfigField,
  RepoConfigFieldSource,
  RepoConfigNode,
  RepoConfigReadEdge,
  RepoDependencyScope,
  RepoIndexService,
  RepoIndexSnapshot,
  RepoIndexStats,
  RepoModuleEdge,
  RepoModuleResolution,
  RepoPackageDependency,
  RepoPackageNode,
  RepoSymbol,
  RepoSymbolEdge,
  RepoSymbolKind,
  RepoSymbolReferenceKind,
  RepoTestCover,
  RepoTestEdgeKind,
  RepoTestNode,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    repoIndex: RepoIndexService
  }
}

/** One index build's bounds; an invalid value fails plugin load. */
export interface Config {
  /** Maximum tree entries one walk returns; the walk stops at this many. */
  maxFiles?: number
  /** Maximum bytes of one file's text the index reads and indexes. */
  maxFileBytes?: number
  /** Maximum symbols retained across the index. */
  maxSymbols?: number
  /** Maximum symbol references retained across the index. */
  maxEdges?: number
  /** Maximum workspace roots whose built snapshot stays cached; the least recently used root is dropped. */
  maxRoots?: number
  /** Directory basenames the walk never descends into. */
  excludeDirs?: string[]
  /** File extensions whose text is read for declarations and imports; a leading dot is optional. */
  extensions?: string[]
  /** File-name fragments that make one path a test file. */
  testFileSuffixes?: string[]
  /** Directory basenames that hold test files. */
  testDirs?: string[]
  /** Directory basename a test directory maps to when a test covers source by path convention. */
  sourceDir?: string
  /** Basenames whose JSON text is read as a package manifest for the package/dependency graph. */
  manifestNames?: string[]
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  maxFiles: z.number().default(10000),
  maxFileBytes: z.number().default(262144),
  maxSymbols: z.number().default(20000),
  maxEdges: z.number().default(40000),
  maxRoots: z.number().default(4),
  excludeDirs: z.array(z.string()).default(['node_modules', '.git', 'lib', 'dist', 'coverage', '.sessions']),
  extensions: z.array(z.string()).default(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']),
  testFileSuffixes: z.array(z.string()).default(['.spec.', '.test.']),
  testDirs: z.array(z.string()).default(['tests', '__tests__']),
  sourceDir: z.string().default('src'),
  manifestNames: z.array(z.string()).default(['package.json']),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** Reject a bound that would truncate everything to zero or behave non-deterministically. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`repo-index: ${name} must be a positive safe integer, got ${String(value)}`)
  }
}

/** One reference pass result: the edges it kept and whether the bound cut it. */
interface ReferencePass {
  readonly edges: readonly RepoSymbolEdge[]
  readonly capped: boolean
}

/** The repository index service. One instance per plugin fiber; the cache dies with the fiber. */
export class RepoIndex extends Service implements RepoIndexService {
  static inject = ['fs']
  static Config: z<Config> = Config

  /** Validated config (schemastery applied the defaults before construction). */
  readonly config: ResolvedConfig
  /** Configured extensions as a lookup set. */
  private readonly extensions: ReadonlySet<string>
  /** Configured manifest basenames whose JSON text the package graph reads. */
  private readonly manifests: ReadonlySet<string>
  /** Built snapshots keyed by the root's resolved target identity, in least-recently-used order. */
  private readonly cache = new Map<string, RepoIndexSnapshot>()

  /**
   * @param ctx - plugin context; the cached snapshots die with its fiber.
   * @param config - the index bounds; invalid values throw before any build.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'repoIndex')
    const resolved = config as ResolvedConfig
    assertPositiveInteger('maxFiles', resolved.maxFiles)
    assertPositiveInteger('maxFileBytes', resolved.maxFileBytes)
    assertPositiveInteger('maxSymbols', resolved.maxSymbols)
    assertPositiveInteger('maxEdges', resolved.maxEdges)
    assertPositiveInteger('maxRoots', resolved.maxRoots)
    if (resolved.excludeDirs.length === 0) throw new Error('repo-index: excludeDirs must name at least one directory')
    if (resolved.extensions.length === 0) throw new Error('repo-index: extensions must name at least one extension')
    const extensions = resolved.extensions.map((extension) => {
      const lower = extension.toLowerCase()
      return lower.startsWith('.') ? lower : `.${lower}`
    })
    if (new Set(extensions).size !== extensions.length) throw new Error('repo-index: extensions must be unique')
    if (resolved.testFileSuffixes.length === 0) throw new Error('repo-index: testFileSuffixes must name at least one fragment')
    if (resolved.testDirs.length === 0) throw new Error('repo-index: testDirs must name at least one directory')
    if (resolved.sourceDir.length === 0) throw new Error('repo-index: sourceDir must not be empty')
    if (resolved.manifestNames.length === 0) throw new Error('repo-index: manifestNames must name at least one basename')
    this.config = { ...resolved, extensions }
    this.extensions = new Set(extensions)
    this.manifests = new Set(resolved.manifestNames)
  }

  async ensure(root: string, signal?: AbortSignal): Promise<RepoIndexSnapshot> {
    const walked = await this.walked(root, signal)
    const key = String(walked.root.targetKey)
    const cached = this.cache.get(key)
    if (cached !== undefined && cached.fingerprint === walked.fingerprint) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }
    const snapshot = await this.build(walked, signal)
    this.cache.delete(key)
    this.cache.set(key, snapshot)
    while (this.cache.size > this.config.maxRoots) {
      const oldest = this.cache.keys().next().value
      /* v8 ignore next -- the loop condition proves at least one key exists */
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    return snapshot
  }

  invalidate(): void {
    this.cache.clear()
  }

  /** Walk one root with the configured bounds. */
  private async walked(root: string, signal?: AbortSignal): Promise<WalkResult> {
    return await walkRepository(this.ctx.fs, root, {
      maxFiles: this.config.maxFiles,
      excludeDirs: this.config.excludeDirs,
    }, signal)
  }

  /**
   * Read the indexable files and derive the snapshot.
   * @param walked - the bounded walk the snapshot covers.
   * @param signal - cancellation forwarded to every read.
   * @returns the built snapshot.
   */
  private async build(walked: WalkResult, signal?: AbortSignal): Promise<RepoIndexSnapshot> {
    const { maxFileBytes, maxSymbols, maxEdges } = this.config
    const symbols: RepoSymbol[] = []
    const declarations = new Map<string, readonly RepoDeclaration[]>()
    const targets = new Map<string, WalkEntry>()
    const unlinked: { from: string; specifier: string }[] = []
    const manifests: RepoManifestText[] = []
    const configs: RepoConfigNode[] = []
    const configReads: RepoConfigReadEdge[] = []
    let indexed = 0
    let skippedLarge = 0
    let capped = walked.capped
    for (const entry of walked.entries) {
      if (symbols.length >= maxSymbols) {
        capped = true
        break
      }
      if (this.manifests.has(entry.path.slice(entry.path.lastIndexOf('/') + 1))) {
        if (entry.size > maxFileBytes) {
          skippedLarge += 1
          continue
        }
        const manifest = await this.read(entry, signal)
        if (manifest === undefined) continue
        if (Buffer.byteLength(manifest, 'utf8') > maxFileBytes) {
          skippedLarge += 1
          continue
        }
        manifests.push({ path: entry.path, text: manifest })
        continue
      }
      if (!this.indexes(entry.path)) continue
      if (entry.size > maxFileBytes) {
        skippedLarge += 1
        continue
      }
      const text = await this.read(entry, signal)
      if (text === undefined) continue
      if (Buffer.byteLength(text, 'utf8') > maxFileBytes) {
        skippedLarge += 1
        continue
      }
      indexed += 1
      targets.set(entry.path, entry)
      const extraction = extractFile(text)
      declarations.set(entry.path, extraction.declarations)
      for (const specifier of extraction.specifiers) unlinked.push({ from: entry.path, specifier })
      const config = configOf(entry.path, text)
      configs.push(...config.nodes)
      for (const read of config.reads) {
        if (configReads.length >= maxEdges) {
          capped = true
          break
        }
        configReads.push(read)
      }
      for (const declaration of extraction.declarations) {
        if (symbols.length >= maxSymbols) {
          capped = true
          break
        }
        symbols.push({
          id: `${entry.path}#${declaration.name}`,
          name: declaration.name,
          kind: declaration.kind,
          path: entry.path,
          line: declaration.line,
        })
      }
    }
    const indexedPaths = new Set(targets.keys())
    const { nodes: packages, byName: packageByName } = packageGraphOf(manifests)
    const packageNames = new Set(packageByName.keys())
    const imports: RepoModuleEdge[] = unlinked.map(({ from, specifier }) => {
      const to = resolveSpecifier(from, specifier, indexedPaths)
      if (to !== undefined) return { from, specifier, resolution: 'indexed', to }
      if (resolveRelative(from, specifier) !== undefined) return { from, specifier, resolution: 'unresolved' }
      const name = workspacePackageOf(specifier, packageNames)
      return name === undefined
        ? { from, specifier, resolution: 'external' }
        : { from, specifier, resolution: 'workspace-package', package: name }
    })
    const pass = await this.references(declarations, targets, maxEdges, signal)
    if (pass.capped) capped = true
    return {
      root: walked.root.displayPath,
      fingerprint: walked.fingerprint,
      tree: walked.entries.map(entry => entry.path),
      symbols,
      imports,
      references: pass.edges,
      tests: testNodesOf([...indexedPaths], imports, this.config.testFileSuffixes, this.config.testDirs, this.config.sourceDir),
      packages,
      configs,
      configReads,
      stats: { indexed, skippedLarge, capped },
    }
  }

  /**
   * Derive symbol references from each indexed file's declaration header blocks.
   * @param declarations - each indexed file's declarations, in walk order.
   * @param targets - the walked entry per indexed path, for the second read.
   * @param maxEdges - the reference bound.
   * @param signal - cancellation forwarded to every read.
   * @returns the distinct references in file and declaration order, and whether the bound cut them.
   */
  private async references(
    declarations: ReadonlyMap<string, readonly RepoDeclaration[]>,
    targets: ReadonlyMap<string, WalkEntry>,
    maxEdges: number,
    signal?: AbortSignal,
  ): Promise<ReferencePass> {
    const byName = new Map<string, string[]>()
    for (const [file, fileDeclarations] of declarations) {
      for (const declaration of fileDeclarations) {
        const id = `${file}#${declaration.name}`
        const known = byName.get(declaration.name)
        if (known === undefined) byName.set(declaration.name, [id])
        else known.push(id)
      }
    }
    if (byName.size === 0) return { edges: [], capped: false }
    const edges: RepoSymbolEdge[] = []
    const seen = new Set<string>()
    files: for (const [path, fileDeclarations] of declarations) {
      const entry = targets.get(path)
      /* v8 ignore next -- every declaration key was inserted with its target */
      if (entry === undefined) continue
      const text = await this.read(entry, signal)
      if (text === undefined) continue
      for (const [index, references] of headerReferences(text, fileDeclarations).entries()) {
        const from = `${path}#${(fileDeclarations[index] as RepoDeclaration).name}`
        const called = new Set(references.calls)
        for (const identifier of references.identifiers) {
          for (const target of byName.get(identifier) ?? []) {
            if (target === from || seen.has(`${from}\u0000${target}`)) continue
            if (edges.length >= maxEdges) break files
            seen.add(`${from}\u0000${target}`)
            edges.push({ from, to: target, via: called.has(identifier) ? 'call' : 'mention' })
          }
        }
      }
    }
    return { edges, capped: edges.length >= maxEdges }
  }

  /** Read one file's text, skipping a file that became unreadable after the walk. */
  private async read(entry: WalkEntry, signal?: AbortSignal): Promise<string | undefined> {
    try {
      return await this.ctx.fs.readText(entry.target, signal)
    } catch {
      // A file that vanished, is permission-denied, or fails to decode since
      // the walk is left out of the index rather than failing the whole build.
      return undefined
    }
  }

  /** Whether one path carries a configured extension. */
  private indexes(path: string): boolean {
    const dot = path.lastIndexOf('.')
    return dot >= 0 && this.extensions.has(path.slice(dot).toLowerCase())
  }
}

export default RepoIndex
