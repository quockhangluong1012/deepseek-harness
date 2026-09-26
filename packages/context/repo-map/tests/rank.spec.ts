/** Deterministic ranking: objective overlap, degree, kind, and the total tie-break order. */
import { describe, expect, it } from 'vitest'
import type { RepoIndexSnapshot, RepoSymbol, RepoSymbolEdge, RepoSymbolKind } from '@deepseek-ai/dsh-repo-index'
import { objectiveTerms, rankRepositoryMap } from '../src/rank.ts'

/** One declaration at a known path. */
function symbolOf(name: string, path: string, kind: RepoSymbolKind = 'class', line = 1): RepoSymbol {
  return { id: `${path}#${name}`, name, kind, path, line }
}

/** One index over the given declarations and references. */
function snapshotOf(symbols: readonly RepoSymbol[], references: readonly RepoSymbolEdge[] = []): RepoIndexSnapshot {
  const paths = new Set(symbols.map(symbol => symbol.path))
  return {
    root: '/repo',
    fingerprint: 'fingerprint',
    tree: [...paths],
    symbols,
    imports: [],
    references,
    tests: [],
    packages: [],
    configs: [],
    configReads: [],
    stats: { indexed: paths.size, skippedLarge: 0, capped: false },
  }
}

const AUTH = [
  symbolOf('AuthController', 'src/auth/auth-controller.ts', 'class', 12),
  symbolOf('AuthService', 'src/auth/auth-service.ts', 'class', 3),
  symbolOf('renderTable', 'src/ui/table.ts', 'function', 5),
]

describe('objectiveTerms', () => {
  it('keeps distinct words of at least three characters in first-occurrence order', () => {
    expect(objectiveTerms('Fix the AUTH auth-service, fix it!')).toEqual(['fix', 'the', 'auth', 'service'])
    expect(objectiveTerms('')).toEqual([])
  })

  it('reads at most 64 terms of a long objective', () => {
    const long = Array.from({ length: 100 }, (_unused, index) => `word${String(index)}`).join(' ')
    expect(objectiveTerms(long)).toHaveLength(64)
  })
})

describe('rankRepositoryMap', () => {
  it('ranks objective overlap first and lists the best references beneath a node', () => {
    const ranked = rankRepositoryMap(snapshotOf(AUTH, [
      { from: 'src/auth/auth-controller.ts#AuthController', to: 'src/auth/auth-service.ts#AuthService', via: 'call' },
    ]), 'add an auth controller guard', { maxNodes: 10, maxEdgesPerNode: 4 })
    expect(ranked.map(node => node.symbol.name)).toEqual(['AuthController', 'AuthService', 'renderTable'])
    expect(ranked[0]?.related.map(related => related.name)).toEqual(['AuthService'])
    expect(ranked[1]?.related).toEqual([])
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0)
  })

  it('weights an objective term that names the whole symbol', () => {
    const ranked = rankRepositoryMap(snapshotOf(AUTH), 'AuthService', { maxNodes: 10, maxEdgesPerNode: 4 })
    expect(ranked.map(node => node.symbol.name)).toEqual(['AuthService', 'AuthController', 'renderTable'])
  })

  it('bounds the node count and the references per node', () => {
    const hub = symbolOf('Hub', 'src/hub.ts', 'class', 1)
    const ranked = rankRepositoryMap(snapshotOf([hub, ...AUTH], [
      { from: 'src/hub.ts#Hub', to: 'src/auth/auth-controller.ts#AuthController', via: 'call' },
      { from: 'src/hub.ts#Hub', to: 'src/auth/auth-service.ts#AuthService', via: 'call' },
      { from: 'src/hub.ts#Hub', to: 'src/ui/table.ts#renderTable', via: 'call' },
    ]), 'unrelated', { maxNodes: 1, maxEdgesPerNode: 1 })
    expect(ranked.map(node => node.symbol.name)).toEqual(['Hub'])
    expect(ranked[0]?.related.map(related => related.name)).toEqual(['AuthController'])
  })

  it('breaks equal scores on identifier, then path', () => {
    const ranked = rankRepositoryMap(snapshotOf([
      symbolOf('Beta', 'src/beta.ts'),
      symbolOf('Alpha', 'src/alpha.ts'),
      symbolOf('Alpha', 'src/zzz/alpha.ts'),
    ]), 'nothing here', { maxNodes: 10, maxEdgesPerNode: 4 })
    expect(ranked.map(node => `${node.symbol.name}@${node.symbol.path}`)).toEqual([
      'Alpha@src/alpha.ts',
      'Alpha@src/zzz/alpha.ts',
      'Beta@src/beta.ts',
    ])
    expect(ranked.map(node => node.score)).toEqual([3, 3, 3])
  })

  it('orders equal identifiers by path across many comparisons', () => {
    const paths = Array.from({ length: 8 }, (_unused, index) => `src/p${String(index)}.ts`)
    const symbols = paths.map(path => symbolOf('Same', path))
    const ranked = rankRepositoryMap(snapshotOf([
      ...symbols,
      symbolOf('Same', 'src/dup.ts', 'class', 1),
      symbolOf('Same', 'src/dup.ts', 'class', 9),
      // A leading separator yields an empty split word, which the word set skips.
      symbolOf('_Private', 'src/_.ts'),
    ]), 'nothing here', {
      maxNodes: 12,
      maxEdgesPerNode: 4,
    })
    expect(ranked.map(node => node.symbol.path)).toEqual([
      'src/dup.ts',
      'src/dup.ts',
      'src/p0.ts',
      'src/p1.ts',
      'src/p2.ts',
      'src/p3.ts',
      'src/p4.ts',
      'src/p5.ts',
      'src/p6.ts',
      'src/p7.ts',
      'src/_.ts',
    ])
    expect(ranked.every(node => node.score === 3)).toBe(true)
  })

  it('breaks equal reference scores on symbol id', () => {
    const ranked = rankRepositoryMap(snapshotOf([
      symbolOf('Hub', 'src/hub.ts'),
      symbolOf('Twin', 'src/one.ts'),
      symbolOf('Twin', 'src/two.ts'),
    ], [
      { from: 'src/hub.ts#Hub', to: 'src/two.ts#Twin', via: 'call' },
      { from: 'src/hub.ts#Hub', to: 'src/one.ts#Twin', via: 'call' },
    ]), 'nothing here', { maxNodes: 1, maxEdgesPerNode: 4 })
    expect(ranked[0]?.related.map(related => related.id)).toEqual(['src/one.ts#Twin', 'src/two.ts#Twin'])
  })
})
