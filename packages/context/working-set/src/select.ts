/**
 * The deterministic working-set selection: the files one task's objective
 * names, the files they import, and the tests, configuration, and documentation
 * those files carry.
 *
 * The selection is a pure function of the index snapshot and the objective, so
 * the same task over the same repository state always yields the same set. A
 * file enters the set only when the objective names one of its symbols — a task
 * the index cannot match selects nothing rather than everything. Ranking is the
 * repository map's own score, restricted here to symbols the objective names.
 * @module @deepseek-ai/dsh-working-set/select
 */

import type { RepoIndexSnapshot, RepoSymbol, RepoTestNode } from '@deepseek-ai/dsh-repo-index'
import { objectiveTerms, rankRepositoryMap } from '@deepseek-ai/dsh-repo-map'
import type { WorkingSet, WorkingSetSelection } from './types.ts'

/** Configuration basename: `package.json` and every `tsconfig*`. */
const CONFIG_BASENAME = /^(?:package\.json|tsconfig(?:\.[a-z0-9-]+)*\.json)$/u

/** Configuration basename: `<name>.config.<js|ts>`. */
const CONFIG_EXTENSION = /\.config\.[cm]?[jt]s$/u

/** Documentation extension. */
const DOC_EXTENSION = /\.mdx?$/u

/** Source extension a stem drops. */
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/u

/** English documentation suffix a translated mirror carries. */
const TRANSLATED_SUFFIX = '.zh.md'

/** The selection a task the index cannot match receives; shared, no role holds a file. */
const EMPTY: WorkingSet = { primary: [], dependencies: [], tests: [], configs: [], docs: [] }

/** The lowercase words of an identifier or path, split on case boundaries and separators. */
function wordSet(text: string): ReadonlySet<string> {
  const words = new Set<string>()
  for (const word of text.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase().split(/[^a-z0-9]+/u)) {
    if (word.length > 0) words.add(word)
  }
  return words
}

/** The last path segment. */
function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** A path's basename without its source extension. */
function stemOf(path: string): string {
  return basenameOf(path).replace(SOURCE_EXTENSION, '')
}

/**
 * The words a symbol exposes to the objective: its identifier, its declaring
 * file's stem, and its declaring directory path. The extension is deliberately
 * outside the set, so an objective naming `ts` cannot admit every TypeScript file.
 */
function symbolWords(symbol: RepoSymbol): ReadonlySet<string> {
  const slash = symbol.path.lastIndexOf('/')
  const directories = slash < 0 ? '' : symbol.path.slice(0, slash).replaceAll('/', ' ')
  const words = new Set(wordSet(symbol.name))
  for (const word of wordSet(`${directories} ${stemOf(symbol.path)}`)) words.add(word)
  return words
}

/** Whether a tree path is a configuration file the working set recognizes. */
function isConfigPath(path: string): boolean {
  const basename = basenameOf(path)
  return CONFIG_BASENAME.test(basename) || CONFIG_EXTENSION.test(basename)
}

/**
 * Whether a tree path is documentation the working set lists. A `.zh.md` mirror
 * whose English sibling the tree also holds is dropped: the pair carries one
 * document, and the English side is the one the selection spends bytes on.
 */
function isDocumentPath(path: string, tree: ReadonlySet<string>): boolean {
  if (!DOC_EXTENSION.test(path)) return false
  return !path.endsWith(TRANSLATED_SUFFIX) || !tree.has(path.slice(0, -TRANSLATED_SUFFIX.length) + '.md')
}

/**
 * The directories containing a file and each directory above them, deepest
 * first and ending at the repository root.
 */
function ancestorDirectories(path: string): string[] {
  const directories: string[] = []
  let directory = path
  for (;;) {
    const slash = directory.lastIndexOf('/')
    if (slash < 0) {
      directories.push('')
      return directories
    }
    directory = directory.slice(0, slash)
    directories.push(directory)
  }
}

/** The tree paths each directory holds, in tree order. */
function treeByDirectory(tree: readonly string[]): ReadonlyMap<string, string[]> {
  const byDirectory = new Map<string, string[]>()
  for (const path of tree) {
    const slash = path.lastIndexOf('/')
    const directory = slash < 0 ? '' : path.slice(0, slash)
    const known = byDirectory.get(directory)
    if (known === undefined) byDirectory.set(directory, [path])
    else known.push(path)
  }
  return byDirectory
}

/**
 * Files that serve the selected sources from the directories above them: for
 * each source, the deepest directory first, every tree file that one predicate
 * admits, in tree order.
 * @param sources - the selected files, best-first.
 * @param byDirectory - the tree grouped by directory.
 * @param admits - whether a tree path plays the role being collected.
 * @param max - the cap on the returned files.
 * @returns at most `max` distinct paths, in the order they were found.
 */
function filesAbove(
  sources: readonly string[],
  byDirectory: ReadonlyMap<string, readonly string[]>,
  admits: (path: string) => boolean,
  max: number,
): string[] {
  const files: string[] = []
  for (const source of sources) {
    for (const directory of ancestorDirectories(source)) {
      for (const path of byDirectory.get(directory) ?? []) {
        if (!admits(path) || files.includes(path)) continue
        files.push(path)
        if (files.length >= max) return files
      }
    }
  }
  return files
}

/**
 * The test files covering the selected files, read from the index's own test
 * edges: for each selected file, best-ranked first, the tests the index records
 * as covering it, in index order.
 * @param sources - the selected primary and dependency files, best-first.
 * @param tests - the index's test nodes.
 * @param max - the cap on the returned files.
 * @returns at most `max` distinct test paths, in the order they were found.
 */
function testsCovering(sources: readonly string[], tests: readonly RepoTestNode[], max: number): string[] {
  const bySubject = new Map<string, string[]>()
  for (const node of tests) {
    for (const cover of node.covers) {
      const known = bySubject.get(cover.subject)
      if (known === undefined) bySubject.set(cover.subject, [node.path])
      else known.push(node.path)
    }
  }
  const covered: string[] = []
  for (const source of sources) {
    for (const path of bySubject.get(source) ?? []) {
      if (covered.includes(path)) continue
      covered.push(path)
      if (covered.length >= max) return covered
    }
  }
  return covered
}

/**
 * Select the working set of one task.
 * @param snapshot - the repository index the selection reads; never re-walked.
 * @param objective - the task's objective text, supplying the search terms.
 * @param selection - the per-role file caps.
 * @returns the selected files per role; every role is empty when no indexed symbol names an objective term.
 */
export function selectWorkingSet(
  snapshot: RepoIndexSnapshot,
  objective: string,
  selection: WorkingSetSelection,
): WorkingSet {
  const terms = objectiveTerms(objective)
  if (terms.length === 0) return EMPTY
  // The index's full ranking, best first, with no related-symbol arrays: this
  // selection reads the order, then admits only the symbols the objective names.
  const ranked = rankRepositoryMap(snapshot, objective, { maxNodes: snapshot.symbols.length, maxEdgesPerNode: 0 })
  const primary: string[] = []
  const selected = new Set<string>()
  for (const node of ranked) {
    const words = symbolWords(node.symbol)
    if (!terms.some(term => words.has(term))) continue
    if (selected.has(node.symbol.path)) continue
    primary.push(node.symbol.path)
    selected.add(node.symbol.path)
    if (primary.length >= selection.maxPrimaryFiles) break
  }
  if (primary.length === 0) return EMPTY

  const dependencies: string[] = []
  for (const edge of snapshot.imports) {
    // `to` is present exactly for an indexed specifier; a workspace-package or
    // external specifier names no repository file to add.
    if (edge.resolution !== 'indexed' || !selected.has(edge.from) || selected.has(edge.to)) continue
    if (dependencies.includes(edge.to)) continue
    dependencies.push(edge.to)
    if (dependencies.length >= selection.maxDependencyFiles) break
  }

  const byDirectory = treeByDirectory(snapshot.tree)
  const tree = new Set(snapshot.tree)
  return {
    primary,
    dependencies,
    tests: testsCovering([...primary, ...dependencies], snapshot.tests, selection.maxTestFiles),
    configs: filesAbove(primary, byDirectory, isConfigPath, selection.maxConfigFiles),
    docs: filesAbove(primary, byDirectory, path => isDocumentPath(path, tree), selection.maxDocs),
  }
}
