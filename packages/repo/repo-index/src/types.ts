/**
 * The repository index vocabulary: the bounded snapshot one workspace build
 * produces, the graphs it derives over that snapshot, and the query service a
 * consumer reads them through.
 * @module @deepseek-ai/dsh-repo-index/types
 */

/** What a declaration line declares. */
export type RepoSymbolKind = 'class' | 'interface' | 'type' | 'enum' | 'function' | 'const'

/** One declaration-line symbol: the unit a repository map ranks. */
export interface RepoSymbol {
  /** `${path}#${name}`; stable inside one index build. */
  readonly id: string
  /** The declared identifier. */
  readonly name: string
  /** Which declaration form the line matched. */
  readonly kind: RepoSymbolKind
  /** Repository-relative, `/`-separated path of the declaring file. */
  readonly path: string
  /** 1-based line of the declaration. */
  readonly line: number
}

/**
 * How one module specifier resolved against the index.
 *
 * - `indexed`: the specifier names an indexed file, reported as `to`.
 * - `workspace-package`: a bare specifier whose first segment or package name
 *   matched an indexed `package.json` name, reported as `package`. The edge
 *   names the package rather than a file: the manifest's `exports` map decides
 *   which file the specifier loads, and the index does not read that map.
 * - `external`: a bare specifier that matched no indexed manifest name, such as
 *   `node:crypto` or a dependency outside the walk.
 * - `unresolved`: a relative specifier that names no indexed file, because the
 *   target is absent, was skipped as too large, or carries an extension the
 *   index does not read.
 */
export type RepoModuleResolution = 'indexed' | 'workspace-package' | 'external' | 'unresolved'

/**
 * One module specifier a file imports, requires, or re-exports.
 *
 * The variants make the resolution limits explicit rather than conventional:
 * `to` exists exactly for an indexed target and `package` exactly for a
 * workspace package, so a reader cannot mistake an unresolved specifier for a
 * resolved one.
 */
export type RepoModuleEdge =
  | {
    /** The importing file's repository-relative path. */
    readonly from: string
    /** The specifier exactly as written in the source. */
    readonly specifier: string
    /** The specifier named an indexed file. */
    readonly resolution: 'indexed'
    /** The indexed path the specifier resolved to. */
    readonly to: string
  }
  | {
    /** The importing file's repository-relative path. */
    readonly from: string
    /** The specifier exactly as written in the source. */
    readonly specifier: string
    /** The specifier named a workspace package, by name or by one of its subpaths. */
    readonly resolution: 'workspace-package'
    /** The workspace package name; the manifest's `exports` map, which the index does not read, decides the file. */
    readonly package: string
  }
  | {
    /** The importing file's repository-relative path. */
    readonly from: string
    /** The specifier exactly as written in the source. */
    readonly specifier: string
    /** The specifier is bare and matched no indexed manifest name. */
    readonly resolution: 'external'
  }
  | {
    /** The importing file's repository-relative path. */
    readonly from: string
    /** The specifier exactly as written in the source. */
    readonly specifier: string
    /** The specifier is relative and names no indexed file. */
    readonly resolution: 'unresolved'
  }

/**
 * How one symbol reference was derived. Both are name matches inside the
 * referring declaration's text: `call` when the block writes the name as a call
 * or construction, `mention` when it only names it, such as a type annotation.
 * Neither resolves scope, overloads, or types.
 */
export type RepoSymbolReferenceKind = 'call' | 'mention'

/** One symbol-level reference: a declaration's header block names another indexed symbol. */
export interface RepoSymbolEdge {
  /** Referring symbol id. */
  readonly from: string
  /** Referenced symbol id. */
  readonly to: string
  /** Whether the referring block calls the name or only mentions it. */
  readonly via: RepoSymbolReferenceKind
}

/**
 * How one test-subject edge was derived. `import` is direct evidence: the test
 * file's own import resolved to the subject. `naming` is the path convention
 * alone, so a subject renamed without its test keeps the edge while a test that
 * exercises a differently named file reports none.
 */
export type RepoTestEdgeKind = 'import' | 'naming'

/** One file a test covers, and how the index derived that. */
export interface RepoTestCover {
  /** Repository-relative path of the covered file. */
  readonly subject: string
  /** How the edge was derived; see {@link RepoTestEdgeKind}. */
  readonly via: RepoTestEdgeKind
}

/** One indexed test file, and the files it covers. */
export interface RepoTestNode {
  /** Repository-relative path of the test file. */
  readonly path: string
  /** Covered files, the import-derived ones first, each group in path order; empty for a test of unindexed code. */
  readonly covers: readonly RepoTestCover[]
}

/** Which manifest section declared one dependency. */
export type RepoDependencyScope = 'runtime' | 'dev' | 'peer' | 'optional'

/** One dependency a package manifest declares. */
export interface RepoPackageDependency {
  /** The dependency name as written in the manifest. */
  readonly name: string
  /** The manifest section that declared it. */
  readonly scope: RepoDependencyScope
  /** The declared range as written, including a workspace protocol range. */
  readonly range: string
  /** The manifest path of the workspace package whose `name` matches; absent for an external dependency. */
  readonly to?: string
}

/** One workspace package manifest, and the dependencies it declares. */
export interface RepoPackageNode {
  /** Repository-relative path of the manifest. */
  readonly path: string
  /** The manifest's `name`; empty when it declares none or is not a JSON object. */
  readonly name: string
  /** One edge per declared dependency, in `runtime`, `dev`, `peer`, `optional` order, then by name. */
  readonly dependencies: readonly RepoPackageDependency[]
}

/** How one configuration field list was derived. */
export type RepoConfigFieldSource = 'schema' | 'interface'

/** One field a configuration declaration lists. */
export interface RepoConfigField {
  /** The field name as declared. */
  readonly name: string
  /** Whether the name came from a schema object literal or a declared interface body. */
  readonly derivedFrom: RepoConfigFieldSource
}

/** One file that declares configuration for the plugin it implements. */
export interface RepoConfigNode {
  /** Repository-relative path of the declaring file. */
  readonly path: string
  /** The declared binding name, such as `Config`. */
  readonly binding: string
  /** The declared fields, in first-occurrence order. */
  readonly fields: readonly RepoConfigField[]
}

/** One file's read of a configuration field. */
export interface RepoConfigReadEdge {
  /** The reading file's repository-relative path. */
  readonly from: string
  /** The field the file reads through `config.<name>` or `config['<name>']`. */
  readonly field: string
}

/** What one build skipped, when a bound cut it short. */
export interface RepoIndexStats {
  /** Files whose text was read for symbols and imports. */
  readonly indexed: number
  /** Files in the tree whose text was not read because it exceeds `maxFileBytes`. */
  readonly skippedLarge: number
  /** Whether `maxFiles` stopped the walk, or `maxSymbols`/`maxEdges` cut the graph. */
  readonly capped: boolean
}

/**
 * One bounded extraction of a workspace root. Every member is derived from the
 * filesystem at build time; nothing in it is written back.
 */
export interface RepoIndexSnapshot {
  /** The root as the filesystem backend displays it. */
  readonly root: string
  /**
   * Digest over the walked `(path, freshness token, size)` triples. A later
   * `ensure()` whose walk digests the same returns this snapshot without
   * reading any file; a different digest rebuilds it.
   */
  readonly fingerprint: string
  /** Tree paths the walk returned, ascending and relative to the root, at most `maxFiles`. */
  readonly tree: readonly string[]
  /** Declaration-line symbols, at most `maxSymbols`. */
  readonly symbols: readonly RepoSymbol[]
  /** Module specifiers of every indexed file, with how each one resolved. */
  readonly imports: readonly RepoModuleEdge[]
  /** Symbol references, at most `maxEdges`. */
  readonly references: readonly RepoSymbolEdge[]
  /** Every indexed test file, with the files it covers; empty when the tree holds none. */
  readonly tests: readonly RepoTestNode[]
  /** Every parsed package manifest in the tree, in path order. */
  readonly packages: readonly RepoPackageNode[]
  /** Every indexed file that declares configuration, in path order. */
  readonly configs: readonly RepoConfigNode[]
  /** Configuration field reads, in file order, at most `maxEdges`. */
  readonly configReads: readonly RepoConfigReadEdge[]
  /** What the bounds skipped. */
  readonly stats: RepoIndexStats
}

/** The repository index service (`ctx.repoIndex`). */
export interface RepoIndexService {
  /**
   * Return the index for one workspace root, building it when the walk's
   * fingerprint differs from the cached one.
   * @param root - workspace root path as the filesystem backend resolves it.
   * @param signal - cancellation; aborts the walk and the reads it started.
   * @returns the bounded snapshot.
   */
  ensure(root: string, signal?: AbortSignal): Promise<RepoIndexSnapshot>
  /**
   * Drop every cached snapshot, so the next `ensure()` walks and reads again.
   * @returns nothing.
   */
  invalidate(): void
}
