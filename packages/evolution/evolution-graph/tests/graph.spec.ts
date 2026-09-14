import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionGraph, {
  EVOLUTION_GRAPH_EXTRACT_TASK,
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

describe('heartbeat extraction', () => {
  /**
   * One session event for a message whose content is the given blocks.
   * @param type - which of the two message events the producer reads to build.
   * @param content - the message's content blocks.
   * @returns the event as it would be published on `session/event`.
   */
  function messageEvent(
    type: 'user/message' | 'assistant/message',
    content: Array<Record<string, unknown>>,
  ): unknown {
    const message = {
      id: 'm1',
      role: type === 'user/message' ? 'user' : 'assistant',
      content,
      source: { kind: 'plugin', plugin: 'test' },
    }
    return type === 'user/message'
      ? { type, seq: 1, time: 0, data: message }
      : { type, seq: 1, time: 0, data: { turn: 1, step: 1, message, stream: [] } }
  }

  /**
   * A context with every seam the producer reads, so one test can drive a
   * whole extraction run. The workspace and session seams are fakes rather
   * than mounts: the producer reaches both structurally.
   * @param config - plugin configuration.
   * @param chunks - the extraction answer the model streams, for every call.
   * @param seams - workspace roster, session lookup, the model seam, a per-call answer script, and a per-call hook.
   * @returns the mounted graph, the recorded calls, and the registered tasks.
   */
  async function producerHarness(
    config: Record<string, unknown> = {},
    chunks: StreamChunk[] = answer('{"triples":[]}'),
    seams: {
      workspaces?: unknown
      sessions?: unknown
      llm?: boolean
      answers?: readonly StreamChunk[][]
      onCall?: (ctx: Context, call: number) => void
    } = {},
  ) {
    const tasks: Array<{
      name: string
      intervalHours: number
      run: (signal: AbortSignal) => Promise<void> | void
    }> = []
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    const calls: GenerateOptions[] = []
    const sequences = seams.answers ?? [chunks]
    const provideLlm = (): void => {
      ctx.provide('llm', {
        stream: (options: GenerateOptions) => {
          calls.push(options)
          // The script is one sequence per call; a short script repeats its
          // last entry, and the harness always passes at least one.
          const sequence = sequences[Math.min(calls.length - 1, sequences.length - 1)] as StreamChunk[]
          seams.onCall?.(ctx, calls.length)
          return (async function* () {
            yield* sequence
          })()
        },
      } as never)
    }
    if (seams.llm !== false) provideLlm()
    ctx.provide('evolutionHeartbeat', {
      register: (task: {
        name: string
        intervalHours: number
        run: (signal: AbortSignal) => Promise<void> | void
      }) => {
        tasks.push(task)
        return () => {}
      },
    } as never)
    if (seams.workspaces !== undefined) ctx.provide('workspaceRegistry', seams.workspaces as never)
    if (seams.sessions !== undefined) ctx.provide('sessions', seams.sessions as never)
    const fiber = await ctx.plugin(EvolutionGraph, config)
    return { ctx, fiber, graph: ctx.evolutionGraph, calls, tasks, provideLlm }
  }

  it('registers the extract task on the heartbeat seam', async () => {
    const h = await producerHarness()
    try {
      expect(h.tasks).toHaveLength(1)
      expect(h.tasks[0]?.name).toBe('evolution-graph-extract')
      expect(h.tasks[0]?.name).toBe(EVOLUTION_GRAPH_EXTRACT_TASK)
      expect(h.tasks[0]?.intervalHours).toBe(6)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('extracts buffered scope text and clears the buffer on success', async () => {
    const session = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const h = await producerHarness(
      {},
      answer('{"triples":[{"from":"Ava","relation":"worked_on","to":"Atlas"}]}'),
      { workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] }, sessions: { get: () => session } },
    )
    try {
      h.ctx.emit('session/event', session as never, messageEvent('user/message', [{ type: 'text', text: 'Ava worked on Atlas' }]) as never)
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0]).toMatchObject({ provider: 'p', model: 'm' })
      expect(h.graph.find(EvolutionScopeId('default', 'ws'), 'ava')).toHaveLength(1)
      // The batch was consumed: an idle scope costs a second run nothing.
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('makes no LLM call when no scope has buffered text', async () => {
    const h = await producerHarness({}, answer('{"triples":[]}'), {
      workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] },
      sessions: { get: () => undefined },
    })
    try {
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(0)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('extracts through the configured route without a session to ask', async () => {
    const h = await producerHarness(
      { provider: 'cfg', model: 'cfg-model' },
      answer('{"triples":[{"from":"Ava","relation":"worked_on","to":"Atlas"}]}'),
      { workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] } },
    )
    try {
      h.ctx.emit('session/event', { id: 's1' } as never, messageEvent('user/message', [{ type: 'text', text: 'Ava worked on Atlas' }]) as never)
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0]).toMatchObject({ provider: 'cfg', model: 'cfg-model' })
      expect(h.graph.find(EvolutionScopeId('default', 'ws'), 'ava')).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('skips scopes whose route cannot be resolved', async () => {
    let live: unknown
    const h = await producerHarness(
      {},
      answer('{"triples":[{"from":"Ava","relation":"worked_on","to":"Atlas"}]}'),
      { workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] }, sessions: { get: () => live } },
    )
    try {
      h.ctx.emit('session/event', { id: 's1' } as never, messageEvent('user/message', [{ type: 'text', text: 'Ava worked on Atlas' }]) as never)
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(0)
      live = { id: 's1', requestHeader: () => undefined }
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(0)
      // The buffer survived both runs, so a route that appears later still extracts it.
      live = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0]).toMatchObject({ provider: 'p', model: 'm' })
      expect(h.graph.find(EvolutionScopeId('default', 'ws'), 'ava')).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('clears the buffer even when extraction fails', async () => {
    const session = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const h = await producerHarness({}, answer('not json'), {
      workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] },
      sessions: { get: () => session },
    })
    try {
      h.ctx.emit('session/event', session as never, messageEvent('user/message', [{ type: 'text', text: 'Ava worked on Atlas' }]) as never)
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(1)
      expect(h.graph.read(EvolutionScopeId('default', 'ws'))).toBeUndefined()
      // At most once: the failed batch is not retried.
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('buffers only user and assistant message text', async () => {
    const session = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const h = await producerHarness({}, answer('{"triples":[]}'), {
      workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] },
      sessions: { get: () => session },
    })
    try {
      h.ctx.emit('session/event', session as never, { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } } as never)
      h.ctx.emit('session/event', session as never, messageEvent('user/message', []) as never)
      h.ctx.emit('session/event', session as never, messageEvent('user/message', [{ type: 'text', text: 'from user' }]) as never)
      h.ctx.emit('session/event', session as never, messageEvent('assistant/message', [
        { type: 'reasoning', text: 'never buffered' },
        { type: 'text', text: 'from assistant' },
      ]) as never)
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(1)
      const sent = h.calls[0]?.messages[0]?.content.map(block => (block.type === 'text' ? block.text : '')).join('')
      expect(sent).toBe('from user\nfrom assistant')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('ignores messages it cannot place in a workspace', async () => {
    const unowned = await producerHarness({}, answer('{"triples":[]}'), {
      workspaces: { list: () => [{ id: 'ws', sessionIds: ['someone-else'] }] },
      sessions: { get: () => undefined },
    })
    const bare = await producerHarness()
    try {
      const text = messageEvent('user/message', [{ type: 'text', text: 'Ava worked on Atlas' }])
      unowned.ctx.emit('session/event', { id: 's1' } as never, text as never)
      await unowned.tasks[0]?.run(new AbortController().signal)
      expect(unowned.calls).toHaveLength(0)
      bare.ctx.emit('session/event', { id: 's1' } as never, text as never)
      await bare.tasks[0]?.run(new AbortController().signal)
      expect(bare.calls).toHaveLength(0)
    } finally {
      await unowned.fiber.dispose()
      await bare.fiber.dispose()
    }
  })

  it('stops before extracting when the signal is already aborted', async () => {
    const session = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const h = await producerHarness({}, answer('{"triples":[]}'), {
      workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] },
      sessions: { get: () => session },
    })
    try {
      h.ctx.emit('session/event', session as never, messageEvent('user/message', [{ type: 'text', text: 'Ava worked on Atlas' }]) as never)
      const aborted = new AbortController()
      aborted.abort()
      await h.tasks[0]?.run(aborted.signal)
      expect(h.calls).toHaveLength(0)
      // An aborted run spends nothing, so the next one still has the batch.
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('keeps buffered text until the llm seam is provided', async () => {
    const session = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const chunks = answer('{"triples":[{"from":"Ava","relation":"worked_on","to":"Atlas"}]}')
    const h = await producerHarness({}, chunks, {
      workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] },
      sessions: { get: () => session },
      llm: false,
    })
    try {
      h.ctx.emit('session/event', session as never, messageEvent('user/message', [{ type: 'text', text: 'Ava worked on Atlas' }]) as never)
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(0)
      h.provideLlm()
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(1)
      expect(h.graph.find(EvolutionScopeId('default', 'ws'), 'ava')).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('drops text larger than the input budget and keeps the newest', async () => {
    const session = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const h = await producerHarness({ maxInputBytes: 10 }, answer('{"triples":[]}'), {
      workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] },
      sessions: { get: () => session },
    })
    try {
      const emit = (text: string): void => {
        h.ctx.emit('session/event', session as never, messageEvent('user/message', [{ type: 'text', text }]) as never)
      }
      emit('aaaaaaaaaaaaaaaaaaaa')
      emit('aaaa')
      emit('bbbbbb')
      emit('cc')
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(1)
      const sent = h.calls[0]?.messages[0]?.content.map(block => (block.type === 'text' ? block.text : '')).join('')
      expect(sent).toBe('bbbbbb\ncc')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('drops an oversized message without opening a batch of its own', async () => {
    const session = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const h = await producerHarness({ maxInputBytes: 10 }, answer('{"triples":[]}'), {
      workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] },
      sessions: { get: () => session },
    })
    try {
      const emit = (text: string): void => {
        h.ctx.emit('session/event', session as never, messageEvent('user/message', [{ type: 'text', text }]) as never)
      }
      emit('r'.repeat(11))
      // Nothing was buffered, so the scope is idle: no call, no empty record,
      // and no entry left behind to pay again on the next run.
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(0)
      expect(h.graph.read(EvolutionScopeId('default', 'ws'))).toBeUndefined()
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(0)
      // A later message that fits still opens a batch on its own.
      emit('fits')
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('keeps text published while an extraction is in flight', async () => {
    const session = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const h = await producerHarness({}, answer('{"triples":[]}'), {
      workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] },
      sessions: { get: () => session },
      answers: [
        answer('{"triples":[{"from":"Ava","relation":"worked_on","to":"Atlas"}]}'),
        answer('{"triples":[{"from":"Bo","relation":"owns","to":"Car"}]}'),
      ],
      // The model is answering while the user keeps typing the same scope.
      onCall: (ctx) => {
        ctx.emit('session/event', session as never, messageEvent('user/message', [{ type: 'text', text: 'Bo owns Car' }]) as never)
      },
    })
    try {
      h.ctx.emit('session/event', session as never, messageEvent('user/message', [{ type: 'text', text: 'Ava worked on Atlas' }]) as never)
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(1)
      expect(h.graph.find(EvolutionScopeId('default', 'ws'), 'ava')).toHaveLength(1)
      // The late text survived the run it arrived during and is the next batch.
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(2)
      expect(h.graph.find(EvolutionScopeId('default', 'ws'), 'bo')).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('keeps the buffer when no session lookup is mounted', async () => {
    const h = await producerHarness({}, answer('{"triples":[{"from":"Ava","relation":"worked_on","to":"Atlas"}]}'), {
      workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] },
    })
    try {
      h.ctx.emit('session/event', { id: 's1' } as never, messageEvent('user/message', [{ type: 'text', text: 'Ava worked on Atlas' }]) as never)
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(0)
      h.ctx.provide('sessions', { get: () => ({ requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }) } as never)
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(1)
      expect(h.graph.find(EvolutionScopeId('default', 'ws'), 'ava')).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('isolates a failing scope from the rest of the sweep', async () => {
    const first = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const second = { id: 's2', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const h = await producerHarness({}, answer('{"triples":[]}'), {
      workspaces: { list: () => [{ id: 'a', sessionIds: ['s1'] }, { id: 'b', sessionIds: ['s2'] }] },
      sessions: { get: (id: string) => (id === 's1' ? first : second) },
      answers: [answer('not json'), answer('{"triples":[{"from":"Bo","relation":"owns","to":"Car"}]}')],
    })
    try {
      h.ctx.emit('session/event', first as never, messageEvent('user/message', [{ type: 'text', text: 'the first scope' }]) as never)
      h.ctx.emit('session/event', second as never, messageEvent('user/message', [{ type: 'text', text: 'the second scope' }]) as never)
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(2)
      expect(h.graph.read(EvolutionScopeId('default', 'a'))).toBeUndefined()
      expect(h.graph.find(EvolutionScopeId('default', 'b'), 'bo')).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('leaves later scopes buffered when the run aborts mid-sweep', async () => {
    const controller = new AbortController()
    const first = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const second = { id: 's2', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const h = await producerHarness({}, answer('{"triples":[]}'), {
      workspaces: { list: () => [{ id: 'a', sessionIds: ['s1'] }, { id: 'b', sessionIds: ['s2'] }] },
      sessions: { get: (id: string) => (id === 's1' ? first : second) },
      onCall: () => {
        controller.abort()
      },
    })
    try {
      h.ctx.emit('session/event', first as never, messageEvent('user/message', [{ type: 'text', text: 'the first scope' }]) as never)
      h.ctx.emit('session/event', second as never, messageEvent('user/message', [{ type: 'text', text: 'the second scope' }]) as never)
      await h.tasks[0]?.run(controller.signal)
      // The abort ended the sweep after the first scope, before any work for
      // the second one: its batch is still there for the next run.
      expect(h.calls).toHaveLength(1)
      expect(h.graph.read(EvolutionScopeId('default', 'a'))).toBeUndefined()
      expect(h.graph.read(EvolutionScopeId('default', 'b'))).toBeUndefined()
      await h.tasks[0]?.run(new AbortController().signal)
      expect(h.calls).toHaveLength(2)
      expect(h.graph.read(EvolutionScopeId('default', 'b'))).toBeDefined()
    } finally {
      await h.fiber.dispose()
    }
  })
})
