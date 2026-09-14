/**
 * The fixture transport answers every `evolution` Scope verb and the
 * `evolutionCurator` status face the journey page drives: reads and writes over
 * one in-memory Scope record, staged decisions that retire their entry and
 * count a resolution, the four timeline windows, and a follow generation whose
 * baseline precedes every upsert.
 */
import { describe, expect, it } from 'vitest'
import { createFixtureFaces } from '../src/client/fixture.ts'
import type { ClientConnectionRpc, ConnectionRpcResult } from '../src/rpc.ts'

interface EvolutionValue {
  readonly workspaceId: string
  readonly instructions: string
  readonly lessons: readonly { readonly statement: string }[]
  readonly profile: string
  readonly instructionsUpdatedAt: string | null
  readonly contextItems: readonly { readonly id: string; readonly label: string }[]
  readonly staged: readonly { readonly id: string }[]
  readonly resolutions: readonly { readonly id: string; readonly decision: string }[]
  readonly usage: { readonly usedBytes: number; readonly capacityBytes: number }
}

interface TimelineDay {
  readonly day: string
  readonly deltas: readonly { readonly kind: string; readonly gist: string }[]
  readonly contextAttached: number
  readonly outputsIndexed: number
  readonly stagedOpened: number
  readonly stagedApproved: number
  readonly stagedRejected: number
}

interface Timeline {
  readonly range: string
  readonly days: readonly TimelineDay[]
  readonly cumulative: { readonly usedBytes: number; readonly capacityBytes: number; readonly digest: string }
  readonly pending: readonly { readonly id: string; readonly kind: string; readonly op: string; readonly gist: string }[]
}

const SCOPE = 'fx-ws-fixture'
const OTHER = 'fx-ws-home'

/** Open one evolution follow iteration and return its first frame plus the live iterator. */
async function openEvolution(rpc: ClientConnectionRpc, signal?: AbortSignal): Promise<{
  first: unknown
  iterator: AsyncIterator<unknown>
}> {
  const stream = rpc.open?.('/api', 'evolution/follow', { args: {} }, signal ?? new AbortController().signal)
  if (stream === undefined) throw new Error('fixture evolution/follow stream is unavailable')
  const iterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]()
  const first = await iterator.next()
  return { first: first.value, iterator }
}

async function read(rpc: ClientConnectionRpc, scopeId: string): Promise<EvolutionValue> {
  const result = await rpc.call('/api', 'evolution/read', { args: { request: { scopeId } } }) as ConnectionRpcResult<EvolutionValue>
  if (!result.ok) throw new Error(`evolution/read failed: ${result.error.code}`)
  return result.value
}

async function write(
  rpc: ClientConnectionRpc,
  endpoint: string,
  request: Record<string, unknown>,
): Promise<EvolutionValue> {
  const result = await rpc.call('/api', endpoint, { args: { request: { scopeId: SCOPE, ...request } } }) as ConnectionRpcResult<EvolutionValue>
  if (!result.ok) throw new Error(`${endpoint} failed: ${result.error.code}`)
  return result.value
}

async function timeline(rpc: ClientConnectionRpc, range: string): Promise<Timeline> {
  const result = await rpc.call('/api', 'evolution/timeline', { args: { request: { scopeId: SCOPE, range } } }) as ConnectionRpcResult<Timeline>
  if (!result.ok) throw new Error(`evolution/timeline failed: ${result.error.code}`)
  return result.value
}

describe('fixture evolution transport', () => {
  it('serves the seeded Scope, an empty Scope, and a missing Workspace', async () => {
    const { rpc } = createFixtureFaces()
    const seeded = await read(rpc, SCOPE)
    expect(seeded).toMatchObject({
      workspaceId: SCOPE,
      instructions: 'Prefer tabs.',
      lessons: [{ statement: 'Fixture lessons.' }],
      profile: 'Fixture profile.',
      usage: { capacityBytes: 131072 },
    })
    expect(seeded.instructionsUpdatedAt).toEqual(expect.any(String))
    expect(seeded.usage.usedBytes).toBeGreaterThan(0)
    expect(seeded.contextItems).toHaveLength(1)
    expect(seeded.staged.map(entry => entry.id)).toEqual(['fx-staged-1'])
    expect(seeded.resolutions.map(entry => entry.decision)).toEqual(['approved', 'rejected', 'approved'])

    // A Workspace with no record reads as the empty projection.
    await expect(read(rpc, OTHER)).resolves.toMatchObject({
      workspaceId: OTHER,
      instructions: '',
      lessons: [],
      staged: [],
      usage: { usedBytes: 0, capacityBytes: 131072 },
    })

    const missing = await rpc.call('/api', 'evolution/read', { args: { request: { scopeId: 'nope' } } })
    expect(missing).toMatchObject({ ok: false, error: { code: 'workspace/not-found' } })
  })

  it('applies every write verb and publishes an upsert per write', async () => {
    const { rpc } = createFixtureFaces()
    const { first, iterator } = await openEvolution(rpc)
    expect(first).toMatchObject({ type: 'baseline' })
    expect((first as { values: readonly unknown[] }).values).toHaveLength(2)

    expect((await write(rpc, 'evolution/setInstructions', { instructions: 'Prefer spaces.' })).instructions).toBe('Prefer spaces.')
    expect((await write(rpc, 'evolution/setLessons', { artifacts: [
      { statement: 'Hand-written lessons.', source: 's1', conditions: '', evidence: 'inference', confidence: 0.5, scope: 'project' },
    ] })).lessons.map(lesson => lesson.statement)).toEqual(['Hand-written lessons.'])
    expect((await write(rpc, 'evolution/setProfile', { profile: 'Hand-written profile.' })).profile).toBe('Hand-written profile.')
    const text = await write(rpc, 'evolution/addContextItem', { kind: 'text', label: 'paste', text: 'pasted body' })
    expect(text.contextItems.map(item => item.label)).toEqual(['notes', 'paste'])
    const file = await write(rpc, 'evolution/addContextItem', { kind: 'file', label: 'readme', path: 'README.md' })
    expect(file.contextItems.map(item => item.label)).toEqual(['notes', 'paste', 'readme'])
    const removed = await write(rpc, 'evolution/removeContextItem', { itemId: 'fx-ctx-2' })
    expect(removed.contextItems.map(item => item.label)).toEqual(['notes', 'readme'])
    expect((await write(rpc, 'evolution/rebuildMemory', {})).lessons.map(lesson => lesson.statement))
      .toEqual(['Rebuilt fixture lessons.'])

    // Every write published exactly one upsert behind the baseline.
    const frames: unknown[] = []
    for (let index = 0; index < 7; index += 1) frames.push((await iterator.next()).value)
    expect(frames.every(frame => (frame as { type: string }).type === 'upsert')).toBe(true)
    await iterator.return?.(undefined)
  })

  it('retires a decided staged write into a counted resolution', async () => {
    const { rpc } = createFixtureFaces()
    const pending = await rpc.call('/api', 'evolution/listStaged', { args: { request: { scopeId: SCOPE } } })
    expect(pending).toMatchObject({
      ok: true,
      value: { staged: [{ id: 'fx-staged-1', kind: 'memory', op: 'replaceArtifacts' }] },
    })

    const approved = await write(rpc, 'evolution/approveStaged', { stagedId: 'fx-staged-1' })
    expect(approved.staged).toHaveLength(0)
    expect(approved.resolutions[0]).toMatchObject({ id: 'fx-staged-1', decision: 'approved' })

    const afterApproval = await timeline(rpc, '7d')
    expect(afterApproval.pending).toHaveLength(0)
    // The decision landed on today's bucket; the seed's own decisions already
    // prove the counter, so this only asserts the new one is counted too.
    expect(afterApproval.days.at(-1)?.stagedApproved).toBeGreaterThanOrEqual(1)

    // An unknown identity decides nothing; a rejection lands in the ledger.
    const unknown = await write(rpc, 'evolution/rejectStaged', { stagedId: 'fx-unknown' })
    expect(unknown.resolutions).toHaveLength(4)
    expect(unknown.staged).toHaveLength(0)
  })

  it('renders every window from the record it keeps', async () => {
    const { rpc } = createFixtureFaces()
    const week = await timeline(rpc, '7d')
    expect(week.range).toBe('7d')
    expect(week.days).toHaveLength(7)
    const active = week.days.find(day => day.deltas.length > 0)
    expect(active).toBeDefined()
    // The seeded Scope proves every delta family and both decisions.
    expect(new Set(active?.deltas.map(delta => delta.kind))).toEqual(
      new Set(['instructions', 'lessons', 'profile', 'context', 'outputs', 'staged']),
    )
    expect(active).toMatchObject({
      contextAttached: 1,
      outputsIndexed: 1,
      stagedOpened: 1,
      stagedApproved: 1,
      stagedRejected: 1,
    })
    expect(week.cumulative.capacityBytes).toBe(131072)
    expect(week.cumulative.usedBytes).toBeGreaterThan(0)
    expect(week.cumulative.digest).toMatch(/^fx-/)
    expect(week.pending.map(entry => entry.gist)).toEqual(['lesson: staged fixture note'])

    expect((await timeline(rpc, 'today')).days).toHaveLength(1)
    expect((await timeline(rpc, '30d')).days).toHaveLength(30)
    // `all` is data-only: the two days that carry a delta or a decision.
    const all = await timeline(rpc, 'all')
    expect(all.days).toHaveLength(2)
    expect(all.days.map(entry => entry.day)).toEqual([...all.days.map(entry => entry.day)].sort())

    const unknown = await rpc.call('/api', 'evolution/timeline', { args: { request: { scopeId: SCOPE, range: '90d' } } })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
  })

  it('streams one baseline per workspace then idles until aborted', async () => {
    const { rpc } = createFixtureFaces()
    const controller = new AbortController()
    const { first, iterator } = await openEvolution(rpc, controller.signal)
    expect(first).toMatchObject({
      type: 'baseline',
      values: [{ workspaceId: SCOPE }, { workspaceId: OTHER }],
    })
    // Nothing else arrives on its own; the abort ends the generation.
    const pending = iterator.next()
    controller.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
  })

  it('serves the curator status face and an empty deployment', async () => {
    const { rpc } = createFixtureFaces()
    const status = await rpc.call('/api', 'evolutionCurator/status', { args: {} })
    expect(status).toMatchObject({
      ok: true,
      value: { mounted: true, passes: [{ passId: 'fx-pass-1' }] },
    })

    const emptyFaces = createFixtureFaces({ empty: true })
    expect(await emptyFaces.rpc.call('/api', 'evolutionCurator/status', { args: {} })).toMatchObject({ ok: true })
    const { first } = await openEvolution(emptyFaces.rpc)
    expect(first).toMatchObject({ type: 'baseline', values: [] })
    const emptyRead = await emptyFaces.rpc.call('/api', 'evolution/read', { args: { request: { scopeId: SCOPE } } })
    expect(emptyRead).toMatchObject({ ok: false, error: { code: 'workspace/not-found' } })
  })
})
