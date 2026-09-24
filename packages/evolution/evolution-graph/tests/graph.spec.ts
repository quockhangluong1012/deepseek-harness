import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import EvolutionMemoryStore, {
  EvolutionScopeId,
  type EvolutionExtraction,
  type LessonArtifactInput,
} from '@deepseek-ai/dsh-evolution-memory'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionGraph, {
  Config,
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
  return { ctx, fiber, graph: ctx.evolutionGraph, calls, facility }
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

  it('refuses to load with a profile that can never name a scope', async () => {
    // `EvolutionScopeId` builds `<profile>:<workspace>`, so accepting this
    // profile would empty every read under it instead of failing at load.
    await expect(harness({ profile: '' })).rejects.toThrow('profile must be non-empty')
    await expect(harness({ profile: 'team:eu' })).rejects.toThrow("profile must not contain ':'")
    // The schema refuses the same values before a mount is even attempted.
    expect(() => Config({ profile: '' })).toThrow(/regexp/)
    expect(() => Config({ profile: 'team:eu' })).toThrow(/regexp/)
    expect(Config({ profile: 'team' }).profile).toBe('team')
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

  it('clears the buffer even when extraction fails, reporting the failure', async () => {
    const session = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const h = await producerHarness({}, answer('not json'), {
      workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] },
      sessions: { get: () => session },
    })
    try {
      h.ctx.emit('session/event', session as never, messageEvent('user/message', [{ type: 'text', text: 'Ava worked on Atlas' }]) as never)
      // The batch is spent, and the failure reaches the runner instead of
      // being recorded as a run that succeeded.
      await expect(h.tasks[0]?.run(new AbortController().signal))
        .rejects.toThrow(/default:ws: .*did not return JSON/)
      expect(h.calls).toHaveLength(1)
      expect(h.graph.read(EvolutionScopeId('default', 'ws'))).toBeUndefined()
      // At most once: the failed batch is not retried, so the next run is clean.
      await expect(h.tasks[0]?.run(new AbortController().signal)).resolves.toBeUndefined()
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

  it('reports the abort instead of resolving when the signal is already aborted', async () => {
    const session = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const h = await producerHarness({}, answer('{"triples":[]}'), {
      workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] },
      sessions: { get: () => session },
    })
    try {
      h.ctx.emit('session/event', session as never, messageEvent('user/message', [{ type: 'text', text: 'Ava worked on Atlas' }]) as never)
      const aborted = new AbortController()
      aborted.abort()
      // The abort joins the sweep's failures: an aborted run reports instead
      // of resolving as a success.
      await expect(h.tasks[0]?.run(aborted.signal)).rejects.toThrow('default:ws: run aborted')
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
      // The failing scope does not stop the one behind it: both calls happen,
      // and only then does the sweep report the failure.
      await expect(h.tasks[0]?.run(new AbortController().signal)).rejects.toThrow(/default:a: .*did not return JSON/)
      expect(h.calls).toHaveLength(2)
      expect(h.graph.read(EvolutionScopeId('default', 'a'))).toBeUndefined()
      expect(h.graph.find(EvolutionScopeId('default', 'b'), 'bo')).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('reports every failed scope in one error after extracting the rest', async () => {
    const first = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const second = { id: 's2', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const third = { id: 's3', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const h = await producerHarness({}, answer('{"triples":[]}'), {
      workspaces: {
        list: () => [
          { id: 'a', sessionIds: ['s1'] },
          { id: 'b', sessionIds: ['s2'] },
          { id: 'c', sessionIds: ['s3'] },
        ],
      },
      sessions: {
        get: (id: string) => (id === 's1' ? first : id === 's2' ? second : third),
      },
      answers: [
        answer('not json'),
        answer('not json'),
        answer('{"triples":[{"from":"Bo","relation":"owns","to":"Car"}]}'),
      ],
    })
    try {
      h.ctx.emit('session/event', first as never, messageEvent('user/message', [{ type: 'text', text: 'the first scope' }]) as never)
      h.ctx.emit('session/event', second as never, messageEvent('user/message', [{ type: 'text', text: 'the second scope' }]) as never)
      h.ctx.emit('session/event', third as never, messageEvent('user/message', [{ type: 'text', text: 'the third scope' }]) as never)
      // One error names both failures with their own causes, and the scope
      // that still works was extracted before the sweep reported them.
      await expect(h.tasks[0]?.run(new AbortController().signal))
        .rejects.toThrow(/default:a: .*did not return JSON; default:b: .*did not return JSON/)
      expect(h.calls).toHaveLength(3)
      expect(h.graph.find(EvolutionScopeId('default', 'c'), 'bo')).toHaveLength(1)
      expect(h.graph.read(EvolutionScopeId('default', 'a'))).toBeUndefined()
      expect(h.graph.read(EvolutionScopeId('default', 'b'))).toBeUndefined()
    } finally {
      await h.fiber.dispose()
    }
  })

  it('reports a cause that is not an Error', async () => {
    const session = { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
    const h = await producerHarness({}, answer('{"triples":[]}'), {
      workspaces: { list: () => [{ id: 'ws', sessionIds: ['s1'] }] },
      sessions: { get: () => session },
      // The model seam is a foreign value: it may throw anything, and the
      // report still has to name what it threw.
      onCall: () => {
        throw 'route refused'
      },
    })
    try {
      h.ctx.emit('session/event', session as never, messageEvent('user/message', [{ type: 'text', text: 'Ava worked on Atlas' }]) as never)
      await expect(h.tasks[0]?.run(new AbortController().signal)).rejects.toThrow('default:ws: route refused')
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
      // The abort joins the sweep's failures: the run reports instead of
      // resolving, after the first scope, before any work for the second
      // one — its batch is still there for the next run.
      await expect(h.tasks[0]?.run(controller.signal)).rejects.toThrow(': run aborted')
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

describe('claim graph', () => {
  const T0 = '2026-09-22T00:00:00.000Z'
  const T1 = '2026-09-22T01:00:00.000Z'
  const T2 = '2026-09-22T02:00:00.000Z'
  const T3 = '2026-09-22T03:00:00.000Z'
  const T4 = '2026-09-22T04:00:00.000Z'

  /** One memory-provenance record, as the reviewer stamps it on a batch. */
  function extraction(sessionId: string): EvolutionExtraction {
    return {
      at: T0,
      sessionId,
      provider: 'stub',
      model: 'stub-model',
      origin: 'background_review',
      inputBytes: 10,
      truncated: false,
    }
  }

  /** One caller-supplied candidate, with the fields a test varies pinned. */
  function candidate(statement: string, source: string): LessonArtifactInput {
    return {
      statement,
      source,
      conditions: '',
      evidence: 'fact',
      confidence: 0.9,
      scope: 'project',
      sourceRefs: [`session:${source}`],
      trajectoryRefs: [`run:${source}`],
      lineage: { origin: source },
    }
  }

  /**
   * A context with the graph and the store that produces its claims, so one
   * test can drive a whole reviewer decision batch through both.
   * @returns the mounted graph, the memory store, and the domain facility.
   */
  async function producerHarness() {
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    const memory = await ctx.plugin(EvolutionMemoryStore, { capacityBytes: 65536 })
    const fiber = await ctx.plugin(EvolutionGraph, {})
    return { ctx, memory, fiber, graph: ctx.evolutionGraph, store: ctx.evolutionMemory, facility }
  }

  it('raises belief with independent evidence and never with a re-read source', async () => {
    const h = await harness()
    try {
      const recorded = await h.graph.recordClaims(scope, [{
        statement: 'PostgreSQL holds the facts',
        supportedBy: [{ source: 'adr-1', quality: 0.8, reliability: 0.5 }],
        observedIn: ['s1', ''],
        derivedFrom: ['an earlier scope note'],
        usedBy: ['skill:sql'],
      }], T0)
      expect(recorded).toEqual({ added: 1, updated: 0, retired: 0, skipped: 0 })
      // One source is worth half its own strength: 1/2 * 0.8 * 0.5.
      expect(h.graph.claim(scope, 'postgresql holds the facts')).toEqual({
        id: 'postgresql holds the facts',
        statement: 'PostgreSQL holds the facts',
        status: 'active',
        retiredBy: null,
        confidence: 0.2,
        evidenceQuality: 0.8,
        sourceReliability: 0.5,
        independentSupport: 1,
        contradictionCount: 0,
        recency: T0,
        supportedBy: [{
          source: 'adr-1',
          quality: 0.8,
          reliability: 0.5,
          firstAt: T0,
          lastAt: T0,
          count: 1,
        }],
        contradictedBy: [],
        observedIn: ['s1'],
        supersedes: [],
        derivedFrom: ['an earlier scope note'],
        usedBy: ['skill:sql'],
        createdAt: T0,
        updatedAt: T0,
      })

      // A second, independent source adds support: 2/3 * 1 * 1.
      await h.graph.recordClaims(scope, [{
        statement: 'postgresql holds the facts',
        supportedBy: [{ source: 'session-b', quality: 1, reliability: 1 }],
      }], T1)
      const supported = h.graph.claim(scope, 'postgresql holds the facts')
      expect(supported).toMatchObject({
        confidence: 2 / 3,
        evidenceQuality: 1,
        sourceReliability: 1,
        independentSupport: 2,
        recency: T1,
      })

      // Re-reading one of them changes no belief input, however it is
      // graded: a source attests once, and only a new source adds support.
      const reread = await h.graph.recordClaims(scope, [{
        statement: 'PostgreSQL holds the facts',
        supportedBy: [{ source: 'session-b', quality: 0.1, reliability: 0.1 }],
      }], T2)
      expect(reread).toEqual({ added: 0, updated: 1, retired: 0, skipped: 0 })
      expect(h.graph.claim(scope, 'postgresql holds the facts')).toMatchObject({
        confidence: 2 / 3,
        independentSupport: 2,
        recency: T2,
        supportedBy: [
          { source: 'adr-1', count: 1 },
          { source: 'session-b', quality: 1, reliability: 1, firstAt: T1, lastAt: T2, count: 2 },
        ],
      })

      // A contradiction divides the belief and is counted; the claim keeps
      // standing at a lower belief until something supersedes it.
      await h.graph.recordClaims(scope, [{
        statement: 'PostgreSQL holds the facts',
        contradictedBy: [{ source: 'session-c' }],
      }], T3)
      expect(h.graph.claim(scope, 'postgresql holds the facts')).toMatchObject({
        status: 'active',
        confidence: 2 / 3 / 2,
        contradictionCount: 1,
        recency: T3,
        contradictedBy: [{ source: 'session-c', quality: 1, reliability: 1, firstAt: T3, lastAt: T3, count: 1 }],
      })
      // One contradicting source contradicting twice is still one source.
      await h.graph.recordClaims(scope, [{
        statement: 'postgresql holds the facts',
        contradictedBy: [{ source: 'session-c' }],
      }], T4)
      expect(h.graph.claim(scope, 'postgresql holds the facts')).toMatchObject({
        confidence: 2 / 3 / 2,
        contradictionCount: 1,
        contradictedBy: [{ source: 'session-c', lastAt: T4, count: 2 }],
      })
      // A second, independent contradiction divides the belief again.
      await h.graph.recordClaims(scope, [{
        statement: 'postgresql holds the facts',
        contradictedBy: [{ source: 'session-d' }],
      }], T4)
      expect(h.graph.claim(scope, 'postgresql holds the facts')).toMatchObject({
        confidence: 2 / 3 / 3,
        contradictionCount: 2,
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('drops blank statements and evidence, and refuses claims past the cap', async () => {
    const h = await harness({ maxClaims: 1 })
    try {
      expect(await h.graph.recordClaims(scope, [{ statement: '   ' }], T0))
        .toEqual({ added: 0, updated: 0, retired: 0, skipped: 1 })
      // A batch that stored nothing reaches no write at all.
      expect(h.graph.read(scope)).toBeUndefined()
      expect(await h.graph.recordClaims(scope, [
        { statement: 'first fact', supportedBy: [{ source: '  ' }, { source: ' s1 ' }] },
        { statement: 'second fact' },
      ], T0)).toEqual({ added: 1, updated: 0, retired: 0, skipped: 1 })
      // A claim the scope already holds is still writable at the cap: only
      // new statements are refused.
      expect(await h.graph.recordClaims(scope, [{ statement: 'first fact', supportedBy: [{ source: 's1' }] }], T1))
        .toEqual({ added: 0, updated: 1, retired: 0, skipped: 0 })
      expect(h.graph.claims(scope).map(claim => claim.id)).toEqual(['first fact'])
      expect(h.graph.claim(scope, 'first fact')?.supportedBy).toEqual([
        { source: 's1', quality: 1, reliability: 1, firstAt: T0, lastAt: T1, count: 2 },
      ])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('answers queries with active claims only and caps what one returns', async () => {
    const h = await harness()
    try {
      expect(h.graph.claims(scope)).toEqual([])
      expect(h.graph.claims(other)).toEqual([])
      expect(h.graph.claim(scope, 'unheard of')).toBeUndefined()
      await h.graph.recordClaims(other, [{ statement: 'another scope holds this' }], T0)
      await h.graph.recordClaims(scope, [
        { statement: 'prefers terse answers', supportedBy: [{ source: 's1' }] },
        { statement: 'use postgres 14', supportedBy: [{ source: 's1' }] },
        {
          statement: 'use postgres 16',
          supportedBy: [{ source: 's1' }, { source: 's2' }],
          supersedes: ['use postgres 14'],
        },
      ], T0)
      // Best-supported first; a retired claim answers nothing.
      expect(h.graph.claims(scope).map(claim => claim.id)).toEqual(['use postgres 16', 'prefers terse answers'])
      expect(h.graph.claims(scope, 'POSTGRES').map(claim => claim.id)).toEqual(['use postgres 16'])
      expect(h.graph.claims(scope, 'use postgres 14')).toEqual([])
      expect(h.graph.claims(scope, 'use postgres', 1)).toHaveLength(1)
      expect(h.graph.claims(other).map(claim => claim.id)).toEqual(['another scope holds this'])
      // A retired claim stays readable by identity, naming what retired it.
      expect(h.graph.claim(scope, 'Use Postgres 14')).toMatchObject({
        status: 'retired',
        retiredBy: 'use postgres 16',
      })
      expect(h.graph.claim(other, 'another scope holds this')?.status).toBe('active')
    } finally {
      await h.fiber.dispose()
    }
    const capped = await harness({ maxQueryLimit: 1 })
    try {
      await capped.graph.recordClaims(scope, [{ statement: 'one' }, { statement: 'two' }], T0)
      expect(capped.graph.claims(scope)).toHaveLength(1)
      expect(capped.graph.claims(scope, '', 5)).toHaveLength(1)
    } finally {
      await capped.fiber.dispose()
    }
  })

  it('retires whichever claim a supersedes names, whatever the order', async () => {
    const h = await harness()
    try {
      await h.graph.recordClaims(scope, [
        { statement: 'the newer fact', supersedes: ['the older fact', '  unheard of  ', 'the newer fact'] },
        { statement: 'the older fact', supportedBy: [{ source: 's1' }] },
      ], T0)
      expect(h.graph.claim(scope, 'the older fact')).toMatchObject({
        status: 'retired',
        retiredBy: 'the newer fact',
      })
      expect(h.graph.claim(scope, 'the newer fact')).toMatchObject({ status: 'active', retiredBy: null })
      // Retiring an already retired claim again leaves the first retirer named.
      expect(await h.graph.recordClaims(scope, [{ statement: 'the latest fact', supersedes: ['the older fact'] }], T1))
        .toEqual({ added: 1, updated: 0, retired: 0, skipped: 0 })
      expect(h.graph.claim(scope, 'the older fact')).toMatchObject({ retiredBy: 'the newer fact' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('records the store decision batch as claim edges', async () => {
    const h = await producerHarness()
    try {
      await h.store.applyExtractionDecisions(
        scope,
        [{ kind: 'new', candidate: candidate('Postgres is the store', 's1') }],
        extraction('s1'),
      )
      await vi.waitFor(() => {
        expect(h.graph.claims(scope)).toHaveLength(1)
      })
      expect(h.graph.claim(scope, 'Postgres is the store')).toMatchObject({
        independentSupport: 1,
        confidence: 0.45,
        observedIn: ['s1'],
        supportedBy: [{ source: 's1', quality: 1, reliability: 0.9, count: 1 }],
      })

      // The same session confirming a fact it already stated is one source;
      // a second session is a second one.
      await h.store.applyExtractionDecisions(scope, [{ kind: 'confirms', artifactId: 'postgres is the store' }], extraction('s1'))
      await vi.waitFor(() => {
        expect(h.graph.claim(scope, 'Postgres is the store')?.supportedBy).toHaveLength(1)
      })
      expect(h.graph.claim(scope, 'Postgres is the store')).toMatchObject({
        independentSupport: 1,
        confidence: 0.45,
        supportedBy: [{ source: 's1', count: 2 }],
      })
      await h.store.applyExtractionDecisions(scope, [{ kind: 'confirms', artifactId: 'postgres is the store' }], extraction('s2'))
      await vi.waitFor(() => {
        expect(h.graph.claim(scope, 'Postgres is the store')).toMatchObject({
          independentSupport: 2,
          confidence: 0.6,
        })
      })

      // A contradiction without a correction lowers the standing it lands on.
      await h.store.applyExtractionDecisions(scope, [{ kind: 'contradicts', artifactId: 'postgres is the store' }], extraction('s3'))
      await vi.waitFor(() => {
        expect(h.graph.claim(scope, 'Postgres is the store')).toMatchObject({
          status: 'active',
          contradictionCount: 1,
          confidence: 0.3,
          contradictedBy: [{ source: 's3' }],
        })
      })

      // A correction is a claim of its own, which retires the one it corrects.
      await h.store.applyExtractionDecisions(scope, [{
        kind: 'contradicts',
        artifactId: 'postgres is the store',
        statement: 'Postgres 16 is the store',
        confidence: 0.8,
      }], extraction('s4'))
      await vi.waitFor(() => {
        expect(h.graph.claims(scope).map(claim => claim.id)).toEqual(['postgres 16 is the store'])
      })
      expect(h.graph.claim(scope, 'Postgres is the store')).toMatchObject({
        status: 'retired',
        retiredBy: 'postgres 16 is the store',
        contradictionCount: 2,
      })
      // Two independent contradictions divide the belief again (2/3 * 0.9 / 3).
      expect(h.graph.claim(scope, 'Postgres is the store')?.confidence).toBeCloseTo(0.2, 10)
      expect(h.graph.claim(scope, 'postgres 16 is the store')).toMatchObject({
        independentSupport: 1,
        confidence: 0.4,
        supersedes: ['postgres is the store'],
        supportedBy: [{ source: 's4', quality: 1, reliability: 0.8 }],
      })

      // A decision naming an artifact the batch never held evidences nothing,
      // and a batch of only such decisions reaches no write.
      const before = h.graph.read(scope)?.updatedAt
      const settled = await h.store.applyExtractionDecisions(
        scope,
        [{ kind: 'confirms', artifactId: 'unheard of' }],
        extraction('s9'),
      )
      expect(settled.agentLessons.map(artifact => artifact.statement)).toEqual(['Postgres 16 is the store'])
      // One macrotask, so a fold for that batch would already have landed.
      const tick: PromiseWithResolvers<void> = Promise.withResolvers()
      setTimeout(tick.resolve, 0)
      await tick.promise
      expect(h.graph.read(scope)?.updatedAt).toBe(before)
    } finally {
      await h.memory.dispose()
      await h.fiber.dispose()
    }
  })

  it('logs a claim write that fails instead of failing the memory write', async () => {
    const h = await producerHarness()
    const warn = vi.spyOn(h.ctx.logger, 'warn')
    try {
      await h.store.applyExtractionDecisions(
        scope,
        [{ kind: 'new', candidate: candidate('a durable fact', 's1') }],
        extraction('s1'),
      )
      // The domain the claims would land in is gone; the batch that published
      // them is already durable, so the failure is reported, not thrown.
      await h.facility.get('evolution_graph')?.close()
      await h.store.applyExtractionDecisions(
        scope,
        [{ kind: 'new', candidate: candidate('another durable fact', 's1') }],
        extraction('s1'),
      )
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('claim write'))
      })
    } finally {
      warn.mockRestore()
      await h.memory.dispose()
      await h.fiber.dispose()
    }
  })
})
