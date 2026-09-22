import { describe, expect, it } from 'vitest'
import { applyRetrievalPolicy } from '../src/policy.ts'
import type { RecommendedRetrievalConfiguration, RetrievalRecommendation } from '../src/policy.ts'

/** One recommended configuration, starting from the mount's own shipped choice. */
function recommended(
  overrides: Partial<RecommendedRetrievalConfiguration> = {},
): RetrievalRecommendation {
  return {
    configKey: 'key-1',
    configuration: {
      source: 'hybrid',
      queryExpansion: 'graph-entities',
      weights: { vector: 1, graph: 1 },
      reranker: 'none',
      mmr: { enabled: false, lambda: 1 },
      memoryScope: 'workspace',
      graphDepth: 1,
      threshold: 0.7,
      ...overrides,
    },
  }
}

describe('applyRetrievalPolicy', () => {
  it('applies the injector-owned dimensions and reports the rest unapplied', () => {
    const application = applyRetrievalPolicy('writer', recommended({ graphDepth: 3, threshold: 0.9 }), 'both')

    expect(application).toEqual({
      taskClass: 'writer',
      configKey: 'key-1',
      applied: [
        { dimension: 'source', value: 'hybrid' },
        { dimension: 'memoryScope', value: 'workspace' },
        { dimension: 'graphDepth', value: '3' },
        { dimension: 'threshold', value: '0.9' },
      ],
      unapplied: [
        {
          dimension: 'queryExpansion',
          value: 'graph-entities',
          reason: "the graph leg always expands the turn's own words into entity labels",
        },
        {
          dimension: 'weights',
          value: '{"vector":1,"graph":1}',
          reason: 'fusion is a reciprocal-rank sum over both legs, which weighs them equally',
        },
        {
          dimension: 'reranker',
          value: 'none',
          reason: 'no reranker is mounted: fused rank is the final order',
        },
        {
          dimension: 'mmr',
          value: '{"enabled":false,"lambda":1}',
          reason: 'the brief keeps fusion order, undiversified',
        },
      ],
      effective: { escalation: 'both', graphDepth: 3, threshold: 0.9 },
    })
  })

  it('maps a graph source onto the graph-first lane', () => {
    const application = applyRetrievalPolicy('writer', recommended({ source: 'graph' }), 'both')

    expect(application.applied[0]).toEqual({ dimension: 'source', value: 'graph' })
    expect(application.effective.escalation).toBe('graph-first')
  })

  it('reports the dimensions a vector-only, non-workspace recommendation names as unapplied', () => {
    const application = applyRetrievalPolicy(
      'planner',
      recommended({ source: 'vector', memoryScope: 'global', reranker: 'cross-encoder', mmr: { enabled: true, lambda: 0.5 } }),
      'graph-first',
    )

    expect(application.applied.map(entry => entry.dimension)).toEqual(['graphDepth', 'threshold'])
    expect(application.unapplied.map(entry => entry.dimension)).toEqual([
      'source',
      'queryExpansion',
      'weights',
      'reranker',
      'mmr',
      'memoryScope',
    ])
    // A source the injector cannot map and a scope it cannot search leave the
    // mount's own lane in place: neither dimension is half-applied.
    expect(application.effective.escalation).toBe('graph-first')
  })
})
