/** The working-set selection over a fixed index snapshot: roles, bounds, and determinism. */
import { describe, expect, it } from 'vitest'
import type { RepoIndexSnapshot } from '@deepseek-ai/dsh-repo-index'
import { selectWorkingSet } from '../src/select.ts'
import type { WorkingSetSelection } from '../src/types.ts'

const SRC = 'packages/repo/repo-index/src'
const TESTS = 'packages/repo/repo-index/tests'

/** One bounded snapshot of a workspace shaped like this repository. */
const SNAPSHOT: RepoIndexSnapshot = {
  root: '/repo',
  fingerprint: 'fingerprint-1',
  tree: [
    'README.md',
    'package.json',
    'packages/repo/README.md',
    `${SRC}/extract.ts`,
    `${SRC}/types.ts`,
    `${SRC}/walk.ts`,
    'packages/repo/repo-index/README.md',
    'packages/repo/repo-index/README.zh.md',
    'packages/repo/repo-index/package.json',
    'packages/util/limits.ts',
    `${TESTS}/extract.spec.ts`,
    `${TESTS}/helper.spec.ts`,
    `${TESTS}/walk-bounds.spec.ts`,
    `${TESTS}/walk.spec.ts`,
  ],
  symbols: [
    { id: `${SRC}/extract.ts#extractFile`, name: 'extractFile', kind: 'function', path: `${SRC}/extract.ts`, line: 74 },
    { id: `${SRC}/types.ts#RepoIndexSnapshot`, name: 'RepoIndexSnapshot', kind: 'interface', path: `${SRC}/types.ts`, line: 60 },
    { id: 'packages/util/limits.ts#LIMIT_CACHE', name: 'LIMIT_CACHE', kind: 'const', path: 'packages/util/limits.ts', line: 1 },
    { id: `${SRC}/walk.ts#walkEntry`, name: 'walkEntry', kind: 'type', path: `${SRC}/walk.ts`, line: 12 },
    { id: `${SRC}/walk.ts#walkRepository`, name: 'walkRepository', kind: 'function', path: `${SRC}/walk.ts`, line: 103 },
  ],
  imports: [
    { from: `${SRC}/extract.ts`, specifier: 'node:crypto', resolution: 'external' },
    { from: `${SRC}/extract.ts`, specifier: './types.ts', resolution: 'indexed', to: `${SRC}/types.ts` },
    { from: `${SRC}/walk.ts`, specifier: './types.ts', resolution: 'indexed', to: `${SRC}/types.ts` },
    // The same file reached twice: the index emits one edge per specifier, so a
    // second spelling of an already-selected dependency is a real shape.
    { from: `${SRC}/walk.ts`, specifier: './types', resolution: 'indexed', to: `${SRC}/types.ts` },
    { from: `${SRC}/walk.ts`, specifier: '../../util/limits.ts', resolution: 'indexed', to: 'packages/util/limits.ts' },
    { from: `${SRC}/walk.ts`, specifier: '../../unindexed', resolution: 'unresolved' },
  ],
  references: [],
  tests: [
    { path: `${TESTS}/extract.spec.ts`, covers: [{ subject: `${SRC}/extract.ts`, via: 'import' }] },
    { path: `${TESTS}/helper.spec.ts`, covers: [] },
    { path: `${TESTS}/walk.spec.ts`, covers: [{ subject: `${SRC}/walk.ts`, via: 'import' }, { subject: `${SRC}/types.ts`, via: 'import' }] },
    { path: `${TESTS}/walk-bounds.spec.ts`, covers: [{ subject: `${SRC}/walk.ts`, via: 'naming' }] },
  ],
  packages: [],
  configs: [],
  configReads: [],
  stats: { indexed: 3, skippedLarge: 0, capped: false },
}

const BOUNDS: WorkingSetSelection = {
  maxPrimaryFiles: 8,
  maxDependencyFiles: 8,
  maxTestFiles: 6,
  maxConfigFiles: 4,
  maxDocs: 3,
}

describe('selectWorkingSet', () => {
  it('selects the file that declares the named symbol, its imports, tests, config, and docs', () => {
    expect(selectWorkingSet(SNAPSHOT, 'walk repository boundaries', BOUNDS)).toEqual({
      primary: [`${SRC}/walk.ts`],
      dependencies: [`${SRC}/types.ts`, 'packages/util/limits.ts'],
      tests: [`${TESTS}/walk.spec.ts`, `${TESTS}/walk-bounds.spec.ts`],
      configs: ['packages/repo/repo-index/package.json', 'package.json'],
      docs: ['packages/repo/repo-index/README.md', 'packages/repo/README.md', 'README.md'],
    })
  })

  it('is a pure function of the snapshot and the objective', () => {
    const first = selectWorkingSet(SNAPSHOT, 'walk repository boundaries', BOUNDS)
    const second = selectWorkingSet({ ...SNAPSHOT, tree: [...SNAPSHOT.tree], symbols: [...SNAPSHOT.symbols] }, 'walk repository boundaries', BOUNDS)
    expect(second).toEqual(first)
  })

  it('selects a different file when the task names a different symbol', () => {
    const walking = selectWorkingSet(SNAPSHOT, 'walk repository boundaries', BOUNDS)
    const extracting = selectWorkingSet(SNAPSHOT, 'extract declaration symbols', BOUNDS)
    expect(extracting.primary).toEqual([`${SRC}/extract.ts`])
    // The dependency's test comes along, because types.ts is selected too.
    expect(extracting.tests).toEqual([`${TESTS}/extract.spec.ts`, `${TESTS}/walk.spec.ts`])
    expect(extracting.primary).not.toEqual(walking.primary)
    expect(extracting.tests).not.toEqual(walking.tests)
  })

  it('selects nothing when no indexed symbol names an objective term', () => {
    expect(selectWorkingSet(SNAPSHOT, 'zebra widget fencing', BOUNDS)).toEqual({
      primary: [],
      dependencies: [],
      tests: [],
      configs: [],
      docs: [],
    })
    expect(selectWorkingSet(SNAPSHOT, '', BOUNDS).primary).toEqual([])
  })

  it('admits every file the objective names and lists no file twice', () => {
    const set = selectWorkingSet(SNAPSHOT, 'repo index', BOUNDS)
    expect(set.primary).toEqual([`${SRC}/types.ts`, `${SRC}/extract.ts`, `${SRC}/walk.ts`])
    expect(new Set(set.primary).size).toBe(set.primary.length)
  })

  it('bounds the primary files without changing their order', () => {
    const complete = selectWorkingSet(SNAPSHOT, 'repo index', BOUNDS)
    const bounded = selectWorkingSet(SNAPSHOT, 'repo index', { ...BOUNDS, maxPrimaryFiles: 2 })
    expect(bounded.primary).toEqual(complete.primary.slice(0, 2))
    expect(selectWorkingSet(SNAPSHOT, 'repo index', { ...BOUNDS, maxDocs: 1 }).docs).toHaveLength(1)
    expect(selectWorkingSet(SNAPSHOT, 'repo index', { ...BOUNDS, maxConfigFiles: 1 }).configs).toHaveLength(1)
  })

  it('bounds the dependency files at the first import edge it keeps', () => {
    const bounded = selectWorkingSet(SNAPSHOT, 'walk repository boundaries', { ...BOUNDS, maxDependencyFiles: 1 })
    expect(bounded.dependencies).toEqual([`${SRC}/types.ts`])
  })

  it('lists an import as a dependency only when the importing file is primary and the target is not', () => {
    const both = selectWorkingSet(SNAPSHOT, 'walk snapshot', BOUNDS)
    expect(both.primary).toEqual([`${SRC}/walk.ts`, `${SRC}/types.ts`])
    // types.ts is primary here, so the same import is not repeated as a dependency.
    expect(both.dependencies).toEqual(['packages/util/limits.ts'])

    const isolated = selectWorkingSet(SNAPSHOT, 'extract declaration symbols', BOUNDS)
    expect(isolated.dependencies).toEqual([`${SRC}/types.ts`])
  })

  it('bounds the test files at the first selected file that has one', () => {
    const bounded = selectWorkingSet(SNAPSHOT, 'walk repository boundaries', { ...BOUNDS, maxTestFiles: 1 })
    expect(bounded.tests).toEqual([`${TESTS}/walk.spec.ts`])
  })

  it('lists the tests the index records as covering a selected file, and only those', () => {
    const set = selectWorkingSet(SNAPSHOT, 'walk snapshot', BOUNDS)
    expect(set.tests).toEqual([`${TESTS}/walk.spec.ts`, `${TESTS}/walk-bounds.spec.ts`])
    // A test of unindexed code covers nothing, and a test of a file this task
    // did not select is not part of the working set.
    expect(set.tests).not.toContain(`${TESTS}/helper.spec.ts`)
    expect(set.tests).not.toContain(`${TESTS}/extract.spec.ts`)
  })

  it('drops a translated documentation mirror the tree pairs with its English sibling', () => {
    const set = selectWorkingSet(SNAPSHOT, 'walk repository boundaries', BOUNDS)
    expect(set.docs).toContain('packages/repo/repo-index/README.md')
    expect(set.docs).not.toContain('packages/repo/repo-index/README.zh.md')
  })
})
