import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionGraph, {
  normalizeNodeId,
  normalizeRelation,
  parseTriples,
  resolveConfig,
} from '../src/index.ts'

const scope = EvolutionScopeId('test', 'ws')
const other = EvolutionScopeId('test', 'other')

/** Chunk sequence carrying one text answer, or one failure. */
function answer(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'not the answer' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'block-end', index: 1, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function harness(config: Record<string, unknown> = {}, chunks: StreamChunk[] = answer('{"triples":[]}')) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const calls: GenerateOptions[] = []
  ctx.provide('llm', {
    stream: (options: GenerateOptions) => {
      calls.push(options)
      return (async function* () {
        yield* chunks
      })()
    },
  } as never)
  const fiber = await ctx.plugin(EvolutionGraph, config)
  return { ctx, fiber, graph: ctx.evolutionGraph, calls }
}

describe('evolution graph', () => {
  it('resolves bounds and normalizes identities', () => {
    expect(resolveConfig({})).toMatchObject({
      maxNodes: 500,
      maxEdges: 2000,
      maxQueryLimit: 20,
      maxInputBytes: 131072,
      maxOutputTokens: 1024,
      timeoutMs: 60000,
      provider: undefined,
      model: undefined,
    })
    expect(() => resolveConfig({ provider: 'p' })).toThrow('must be set together')
    expect(normalizeNodeId('  Project X ')).toBe('project x')
    expect(normalizeRelation('  Worked On ')).toBe('worked_on')
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const graph = new EvolutionGraph(ctx, {})
    expect(() => graph.read(scope)).toThrow('not started yet')
    expect(() => graph.answer(scope, 'a', 'b')).toThrow('not started yet')
  })

  it('merges triples, reinforcing a repeat instead of duplicating it', async () => {
    const h = await harness()
    try {
      const first = await h.graph.observe(scope, [
        { from: 'Project X', relation: 'Worked On', to: 'Alice', toKind: 'person' },
        { from: 'project x', relation: 'worked_on', to: 'Alice', toKind: 'person' },
        { from: 'Project X', relation: 'uses', to: 'PostgreSQL' },
      ])
      expect(first).toEqual({ addedNodes: 3, addedEdges: 2, reinforcedEdges: 1, skipped: 0 })
      const record = h.graph.read(scope)
      expect(record?.nodes).toEqual([
        { id: 'project x', label: 'Project X', kind: null },
        { id: 'alice', label: 'Alice', kind: 'person' },
        { id: 'postgresql', label: 'PostgreSQL', kind: null },
      ])
      expect(record?.edges).toMatchObject([
        { from: 'project x', relation: 'worked_on', to: 'alice', count: 2 },
        { from: 'project x', relation: 'uses', to: 'postgresql', count: 1 },
      ])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('fills a kind it did not know and keeps the first label', async () => {
    const h = await harness()
    try {
      await h.graph.observe(scope, [{ from: 'Project X', relation: 'uses', to: 'PostgreSQL' }])
      await h.graph.observe(scope, [{ from: 'project x', relation: 'uses', to: 'postgresql', fromKind: 'project', toKind: 'database' }])
      expect(h.graph.read(scope)?.nodes).toEqual([
        { id: 'project x', label: 'Project X', kind: 'project' },
        { id: 'postgresql', label: 'PostgreSQL', kind: 'database' },
      ])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('drops unreadable and over-capacity triples, reporting the count', async () => {
    const h = await harness({ maxNodes: 2, maxEdges: 1 })
    try {
      const result = await h.graph.observe(scope, [
        { from: '  ', relation: 'uses', to: 'PostgreSQL' },
        { from: 'A', relation: 'uses', to: 'B' },
        { from: 'C', relation: 'uses', to: 'D' },
        { from: 'A', relation: 'depends_on', to: 'B' },
      ])
      expect(result).toEqual({ addedNodes: 2, addedEdges: 1, reinforcedEdges: 0, skipped: 3 })
      expect(h.graph.read(scope)?.edges).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('keeps scopes independent', async () => {
    const h = await harness()
    try {
      await h.graph.observe(scope, [{ from: 'A', relation: 'uses', to: 'B' }])
      expect(h.graph.read(other)).toBeUndefined()
      expect(h.graph.answer(other, 'A', 'uses')).toBeUndefined()
      expect(h.graph.expand(other, 'A')).toEqual([])
      expect(h.graph.find(other, '')).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('answers a relation query by traversal', async () => {
    const h = await harness()
    try {
      await h.graph.observe(scope, [
        { from: 'Project X', relation: 'worked_on', to: 'Alice' },
        { from: 'Project X', relation: 'worked_on', to: 'Alice' },
        { from: 'Project X', relation: 'worked_on', to: 'Bob' },
        { from: 'Project X', relation: 'worked_on', to: 'Carol' },
        { from: 'Project X', relation: 'uses', to: 'PostgreSQL' },
      ])
      expect(h.graph.answer(scope, 'Project X', 'worked on')).toMatchObject({
        subject: { id: 'project x' },
        relation: 'worked_on',
        objects: [{ id: 'alice' }, { id: 'bob' }, { id: 'carol' }],
      })
      expect(h.graph.answer(scope, 'Project X', 'uses', 1)?.objects).toHaveLength(1)
      expect(h.graph.answer(scope, 'Project X', 'owns')?.objects).toEqual([])
      expect(h.graph.answer(scope, 'Unknown', 'worked_on')).toBeUndefined()
    } finally {
      await h.fiber.dispose()
    }
  })

  it('expands a neighbourhood in both directions', async () => {
    const h = await harness()
    try {
      await h.graph.observe(scope, [
        { from: 'Project X', relation: 'worked_on', to: 'Alice' },
        { from: 'Alice', relation: 'owns', to: 'Laptop' },
        { from: 'Project X', relation: 'uses', to: 'PostgreSQL' },
      ])
      const one = h.graph.expand(scope, 'Alice')
      expect(one.map(reach => [reach.node.id, reach.depth, reach.path])).toEqual([
        ['alice', 0, []],
        ['project x', 1, ['worked_on']],
        ['laptop', 1, ['owns']],
      ])
      const two = h.graph.expand(scope, 'Alice', 2)
      expect(two.map(reach => reach.node.id)).toEqual(['alice', 'project x', 'laptop', 'postgresql'])
      expect(two.find(reach => reach.node.id === 'postgresql')?.path).toEqual(['worked_on', 'uses'])
      expect(h.graph.expand(scope, 'Alice', 2, 2)).toHaveLength(2)
      expect(h.graph.expand(scope, 'Missing')).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('finds entities by label, most connected first', async () => {
    const h = await harness()
    try {
      await h.graph.observe(scope, [
        { from: 'Project X', relation: 'uses', to: 'PostgreSQL' },
        { from: 'Project Y', relation: 'uses', to: 'PostgreSQL' },
        { from: 'Alice', relation: 'owns', to: 'Laptop' },
      ])
      expect(h.graph.find(scope, 'project').map(node => node.id)).toEqual(['project x', 'project y'])
      // An empty query matches every node, most connected first.
      expect(h.graph.find(scope, '').map(node => node.id)).toEqual(['postgresql', 'alice', 'laptop', 'project x', 'project y'])
      expect(h.graph.find(scope, 'nothing')).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('extracts triples with one deterministic call and merges them', async () => {
    const h = await harness(
      { provider: 'stub', model: 'stub-model', maxInputBytes: 8 },
      answer('```json\n{"triples":[{"from":"Project X","relation":"Uses","to":"PostgreSQL","toKind":"database"}]}\n```'),
    )
    try {
      const result = await h.graph.extract(scope, 'a very long source text', { provider: 'stub', model: 'stub-model' }, new AbortController().signal)
      expect(result).toEqual({ observed: 1, addedNodes: 2, addedEdges: 1, reinforcedEdges: 0, skipped: 0 })
      expect(h.graph.answer(scope, 'project x', 'uses')?.objects).toEqual([
        { id: 'postgresql', label: 'PostgreSQL', kind: 'database' },
      ])
      expect(h.calls[0]).toMatchObject({ provider: 'stub', model: 'stub-model', temperature: 0, purpose: 'evolution-review' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rejects an unreadable extraction instead of storing a partial graph', async () => {
    const prose = await harness({}, answer('Project X uses PostgreSQL.'))
    try {
      await expect(prose.graph.extract(scope, 'text', { provider: 'p', model: 'm' }, new AbortController().signal))
        .rejects.toThrow('did not return JSON')
      expect(prose.graph.read(scope)).toBeUndefined()
    } finally {
      await prose.fiber.dispose()
    }
    const failing = await harness({}, [{ type: 'finish', reason: { kind: 'error', failure: { message: 'upstream down', code: 'X' } } }])
    try {
      await expect(failing.graph.extract(scope, 'text', { provider: 'p', model: 'm' }, new AbortController().signal))
        .rejects.toThrow('extraction failed: upstream down')
    } finally {
      await failing.fiber.dispose()
    }
    const toolCall = await harness({}, [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('c'), name: 'x', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    try {
      await expect(toolCall.graph.extract(scope, 'text', { provider: 'p', model: 'm' }, new AbortController().signal))
        .rejects.toThrow('must return text only')
    } finally {
      await toolCall.fiber.dispose()
    }
  })

  it('validates the extraction answer at its boundary', () => {
    expect(parseTriples('{"triples":[]}')).toEqual([])
    expect(parseTriples('{"triples":[{"from":"A","relation":"r","to":"B"}]}\n```'))
      .toEqual([{ from: 'A', relation: 'r', to: 'B', fromKind: null, toKind: null }])
    expect(parseTriples('{"triples":[{"from":"A","relation":"r","to":"B","fromKind":"person","toKind":"team"}]}'))
      .toEqual([{ from: 'A', relation: 'r', to: 'B', fromKind: 'person', toKind: 'team' }])
    // Unreadable entries are dropped, not stored as empty nodes.
    expect(parseTriples('{"triples":[{"from":"A"},"x",null,{"from":"A","relation":"r","to":"B","fromKind":7}]}'))
      .toEqual([{ from: 'A', relation: 'r', to: 'B', fromKind: null, toKind: null }])
    expect(() => parseTriples('not json')).toThrow('did not return JSON')
    expect(() => parseTriples('[]')).toThrow('did not return a JSON object')
    expect(() => parseTriples('{"triples":{}}')).toThrow('returned no triples array')
  })
})
