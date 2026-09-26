/**
 * The graphs the index derives on top of one built snapshot: the test graph,
 * the package/dependency graph, and the configuration graph.
 *
 * Each derivation is a pure function over facts the build already extracted,
 * and each states the resolution it could not perform rather than reporting an
 * unresolved relation as a fact.
 * @module @deepseek-ai/dsh-repo-index/graphs
 */

import { configReadFields, extractConfig } from './extract.ts'
import type {
  RepoConfigNode,
  RepoConfigReadEdge,
  RepoDependencyScope,
  RepoModuleEdge,
  RepoPackageDependency,
  RepoPackageNode,
  RepoTestCover,
  RepoTestNode,
} from './types.ts'

/** The manifest sections the package graph reads, in reported order. */
const DEPENDENCY_SECTIONS: readonly (readonly [RepoDependencyScope, string])[] = [
  ['runtime', 'dependencies'],
  ['dev', 'devDependencies'],
  ['peer', 'peerDependencies'],
  ['optional', 'optionalDependencies'],
]

/** Whether one path is a test file under the configured name fragments. */
export function isTestPath(path: string, suffixes: readonly string[]): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return suffixes.some(suffix => name.includes(suffix))
}

/**
 * The source file a test path covers by path convention: the same directory
 * with the test name fragment dropped, and the same path with a test directory
 * replaced by the source directory.
 * @param path - the test file's repository-relative path.
 * @param suffixes - the configured test name fragments.
 * @param testDirs - the configured test directory basenames.
 * @param sourceDir - the directory basename a test directory maps to.
 * @returns the candidate paths, in the order they should be tried.
 */
function namingCandidates(path: string, suffixes: readonly string[], testDirs: readonly string[], sourceDir: string): string[] {
  const slash = path.lastIndexOf('/')
  const name = path.slice(slash + 1)
  const suffix = suffixes.find(fragment => name.includes(fragment))
  if (suffix === undefined) return []
  const stripped = name.replace(suffix, '.')
  const candidates = [`${path.slice(0, slash + 1)}${stripped}`]
  const segments = path.split('/')
  const at = segments.findIndex(segment => testDirs.includes(segment))
  if (at >= 0) {
    candidates.push([...segments.slice(0, at), sourceDir, ...segments.slice(at + 1, -1), stripped].join('/'))
  }
  return candidates
}

/**
 * Build the test graph over the indexed files and their resolved imports. A
 * test's import of an indexed file is direct evidence; a path-convention match
 * is reported as such, and neither resolves a dynamically imported subject or a
 * subject the index did not read.
 * @param paths - every indexed path, in walk order.
 * @param imports - every module edge of the indexed files.
 * @param testSuffixes - the configured test name fragments.
 * @param testDirs - the configured test directory basenames.
 * @param sourceDir - the directory basename a test directory maps to.
 * @returns one node per test file, in path order.
 */
export function testNodesOf(
  paths: readonly string[],
  imports: readonly RepoModuleEdge[],
  testSuffixes: readonly string[],
  testDirs: readonly string[],
  sourceDir: string,
): readonly RepoTestNode[] {
  const tests = paths.filter(path => isTestPath(path, testSuffixes))
  if (tests.length === 0) return []
  const indexed = new Set(paths)
  const importedBy = new Map<string, Set<string>>()
  for (const edge of imports) {
    if (edge.resolution !== 'indexed' || edge.to === edge.from) continue
    const covered = importedBy.get(edge.from)
    if (covered === undefined) importedBy.set(edge.from, new Set([edge.to]))
    else covered.add(edge.to)
  }
  return tests.map((path) => {
    const covers: RepoTestCover[] = []
    const seen = new Set<string>()
    for (const subject of [...importedBy.get(path) ?? []].sort()) {
      seen.add(subject)
      covers.push({ subject, via: 'import' })
    }
    for (const candidate of namingCandidates(path, testSuffixes, testDirs, sourceDir)) {
      if (!indexed.has(candidate) || seen.has(candidate) || candidate === path) continue
      seen.add(candidate)
      covers.push({ subject: candidate, via: 'naming' })
    }
    return { path, covers }
  })
}

/** One manifest's text, keyed by the path the walk returned. */
export interface RepoManifestText {
  /** Repository-relative path of the manifest. */
  readonly path: string
  /** The manifest's complete text. */
  readonly text: string
}

/** One object as the manifest parser reads it. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Parse one manifest's text; a manifest the index cannot parse declares nothing. */
function parseManifest(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text) as unknown)
  } catch {
    // Malformed JSON in a manifest the walk returned leaves that one package
    // out of the graph rather than failing the whole index build.
    return undefined
  }
}

/**
 * Build the package/dependency graph and the package-name lookup the module
 * graph resolves bare specifiers with. A manifest the index cannot read as a
 * JSON object contributes a node named by nothing rather than failing the build.
 * @param manifests - every indexed manifest's path and text.
 * @returns one node per manifest in path order, and the manifest path of each declared package name.
 */
export function packageGraphOf(manifests: readonly RepoManifestText[]): {
  readonly nodes: readonly RepoPackageNode[]
  readonly byName: ReadonlyMap<string, string>
} {
  const byName = new Map<string, string>()
  const named: { readonly path: string; readonly name: string; readonly manifest: Record<string, unknown> | undefined }[] = []
  for (const { path, text } of manifests) {
    const manifest = parseManifest(text)
    const name = manifest === undefined || typeof manifest['name'] !== 'string' ? '' : manifest['name']
    if (name.length > 0 && !byName.has(name)) byName.set(name, path)
    named.push({ path, name, manifest })
  }
  const nodes = named.map(({ path, name, manifest }) => {
    const dependencies: RepoPackageDependency[] = []
    for (const [scope, section] of DEPENDENCY_SECTIONS) {
      const declared = manifest === undefined ? undefined : asRecord(manifest[section])
      if (declared === undefined) continue
      for (const [dependency, range] of Object.entries(declared)) {
        if (typeof range !== 'string') continue
        const to = byName.get(dependency)
        dependencies.push(to === undefined ? { name: dependency, scope, range } : { name: dependency, scope, range, to })
      }
    }
    return { path, name, dependencies }
  })
  return { nodes, byName }
}

/**
 * The configuration declarations one indexed file makes, and the fields it
 * reads. Both are line facts: the declaration list comes from each binding named
 * `*Config`, and a read is any property of an object named `config`.
 * @param path - the file's repository-relative path.
 * @param text - the file's complete text.
 * @returns the file's configuration nodes and read edges, each in file order.
 */
export function configOf(path: string, text: string): {
  readonly nodes: readonly RepoConfigNode[]
  readonly reads: readonly RepoConfigReadEdge[]
} {
  const nodes = extractConfig(text).map(declaration => ({
    path,
    binding: declaration.binding,
    fields: declaration.fields,
  }))
  return { nodes, reads: configReadFields(text).map(field => ({ from: path, field })) }
}
