/**
 * UsageLedger service: live folding of billed attempts, per-step route
 * attribution, cursor-guarded backfill, throttle/mandatory writes, fail-soft
 * durability, and range summaries. The composition is real (SessionStore,
 * storage stack, Typert registry); only the clock and the write medium are
 * test-owned.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import UsageLedger from '../src/index.ts'
import type { UsageLedgerState } from '../src/spec.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface HarnessOptions {
  root?: string
  config?: { retentionDays: number; writeEveryEvents: number; writeIntervalMs: number }
}

async function harness(options: HarnessOptions = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-usage-dash-'))
  if (options.root === undefined) roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(UsageLedger, options.config ?? { retentionDays: 90, writeEveryEvents: 100, writeIntervalMs: 60_000 })
  return { ctx, root, ledger: ctx.usageLedger }
}

const USAGE: TokenUsage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, totalTokens: 180 }

function usageStream(usage: TokenUsage): SessionEvent<'assistant/message'>['data']['stream'] {
  return [{ type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage } }] as never
}

function answer(session: Session, turn: number, step: number, usage: TokenUsage = USAGE, provider = 'deepseek', model = 'deepseek-chat'): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider, model } }),
    stream: [],
    usage,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Total billed attempts in the stored ledger document, or undefined before the first write. */
async function storedRequests(root: string): Promise<number | undefined> {
  try {
    const document = JSON.parse(await readFile(join(root, 'usage_dashboard.json'), 'utf8')) as {
      tables?: { ledger?: { state?: UsageLedgerState } }
    }
    const state = document.tables?.ledger?.state
    if (state === undefined) return undefined
    return Object.values(state.daily).reduce((total, row) => total + row.requests, 0)
  } catch {
    return undefined
  }
}

describe('UsageLedger live fold', () => {
  it('counts one billed attempt with its route and cache share', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(SessionId('live-one'))
    answer(session, 1, 1)
    const summary = await ctx.usageLedger.summary('today', new AbortController().signal)
    expect(summary.range).toBe('today')
    expect(summary.totals).toMatchObject({ requests: 1, inputTokens: 130, outputTokens: 50, cacheReadTokens: 20 })
    expect(summary.totals.cacheHitAvg).toBeCloseTo(20 / 130)
    expect(summary.models).toHaveLength(1)
    expect(summary.models[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat', requests: 1 })
    expect(summary.daily.find(bucket => bucket.requests === 1)).toBeDefined()
  })

  it('counts a retried attempt before its settling message', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(SessionId('retry'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/attempt', { turn: 1, step: 1, stream: usageStream(USAGE) })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'deepseek', model: 'deepseek-chat' } }),
      stream: [],
      usage: USAGE,
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const summary = await ctx.usageLedger.summary('today', new AbortController().signal)
    expect(summary.totals.requests).toBe(2)
    expect(summary.models).toHaveLength(1)
    expect(summary.models[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat', requests: 2 })
  })

  it('attributes an attempt-only step to the unknown route', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(SessionId('failed'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/attempt', { turn: 1, step: 1, stream: usageStream(USAGE) })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const summary = await ctx.usageLedger.summary('today', new AbortController().signal)
    expect(summary.totals.requests).toBe(1)
    expect(summary.models[0]).toMatchObject({ provider: 'unknown', model: 'unknown', requests: 1 })
  })

  it('ignores samples and events without provable usage', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(SessionId('empty'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'deepseek', model: 'deepseek-chat' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const summary = await ctx.usageLedger.summary('today', new AbortController().signal)
    expect(summary.totals.requests).toBe(0)
  })

  it('skips fork-inherited events on the live path', async () => {
    const { ctx } = await harness()
    const parent = ctx.sessions.create(SessionId('fork-parent'))
    answer(parent, 1, 1)
    const before = await ctx.usageLedger.summary('today', new AbortController().signal)
    ctx.sessions.fork(parent)
    const after = await ctx.usageLedger.summary('today', new AbortController().signal)
    expect(after.totals).toEqual(before.totals)
  })

  it('skips usage samples that fail validation', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(SessionId('invalid'))
    const bad = { inputTokens: 5, outputTokens: 5, totalTokens: 1 }
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/attempt', { turn: 1, step: 1, stream: usageStream(bad) })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'deepseek', model: 'deepseek-chat' } }),
      stream: [],
      usage: bad,
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const summary = await ctx.usageLedger.summary('today', new AbortController().signal)
    expect(summary.totals.requests).toBe(0)
  })

  it('persists at session disposal with an armed timer', async () => {
    const { ctx, root } = await harness({ config: { retentionDays: 90, writeEveryEvents: 10_000, writeIntervalMs: 3_600_000 } })
    let session!: Session
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(SessionId('detach-flush'))
    }, { inject: ['sessions'] }))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'deepseek', model: 'deepseek-chat' } }),
      stream: [],
      usage: USAGE,
    }, { surfaceOp: 'append' })
    await owner.dispose()
    await vi.waitFor(async () => {
      expect(await storedRequests(root)).toBe(1)
    }, { timeout: 5_000 })
  })

  it('clears the armed timer through session disposal on teardown', async () => {
    const { ctx } = await harness({ config: { retentionDays: 90, writeEveryEvents: 10_000, writeIntervalMs: 3_600_000 } })
    const ledger = ctx.usageLedger
    const internals = ledger as unknown as { timer: ReturnType<typeof setTimeout> | undefined }
    const session = ctx.sessions.create(SessionId('armed'))
    session.append('turn/start', { turn: 1 })
    expect(internals.timer).toBeDefined()
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    expect(internals.timer).toBeUndefined()
    const summary = await ledger.summary('today', new AbortController().signal)
    expect(summary.totals.requests).toBe(0)
    expect(session.id).toBe(SessionId('armed'))
  })

  it('never refolds events past the cursor', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(SessionId('cursor'))
    answer(session, 1, 1)
    const ledger = ctx.usageLedger as unknown as { backfill(session: Session): void }
    ledger.backfill(session)
    const summary = await ctx.usageLedger.summary('today', new AbortController().signal)
    expect(summary.totals.requests).toBe(1)
  })
})

describe('UsageLedger summary face', () => {
  it('rejects an unknown range and an aborted call', async () => {
    const { ctx } = await harness()
    const badRange = await Promise.resolve()
      .then(() => ctx.usageLedger.summary('yesterday' as never, new AbortController().signal))
      .then(() => 'resolved', (error: unknown) => error)
    expect(badRange).toMatchObject({ code: 'gateway/bad-request' })
    const controller = new AbortController()
    controller.abort()
    const aborted = await Promise.resolve()
      .then(() => ctx.usageLedger.summary('today', controller.signal))
      .then(() => 'resolved', (error: unknown) => error)
    expect(aborted).not.toBe('resolved')
  })
})

describe('UsageLedger durability', () => {
  it('backfills events committed before the ledger mounts', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const root = await mkdtemp(join(tmpdir(), 'dsh-usage-dash-'))
    roots.push(root)
    await ctx.plugin(Storage)
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('premount'))
    answer(session, 1, 1)
    await ctx.plugin(UsageLedger, { retentionDays: 90, writeEveryEvents: 100, writeIntervalMs: 60_000 })
    const summary = await ctx.usageLedger.summary('today', new AbortController().signal)
    expect(summary.totals.requests).toBe(1)
  })

  it('backfills live sessions on boot without double-counting later events', async () => {
    const first = await harness()
    const session = first.ctx.sessions.create(SessionId('backfill'))
    answer(session, 1, 1)
    const root = first.root
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    const second = await harness({ root })
    const resumed = second.ctx.usageLedger.summary('today', new AbortController().signal)
    await expect(resumed.then(summary => summary.totals.requests)).resolves.toBe(1)
    const live = second.ctx.sessions.create(SessionId('backfill-next'))
    answer(live, 1, 1)
    const summary = await second.ctx.usageLedger.summary('today', new AbortController().signal)
    expect(summary.totals.requests).toBe(2)
  })

  it('retains counters across a restart through the stored document', async () => {
    const first = await harness({ config: { retentionDays: 90, writeEveryEvents: 1, writeIntervalMs: 60_000 } })
    const session = first.ctx.sessions.create(SessionId('persist'))
    answer(session, 1, 1)
    const root = first.root
    await vi.waitFor(async () => {
      expect(await storedRequests(root)).toBe(1)
    }, { timeout: 5_000 })
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    const second = await harness({ root })
    const summary = await second.ctx.usageLedger.summary('today', new AbortController().signal)
    expect(summary.totals.requests).toBe(1)
  })

  it('flushes on the interval timer without a turn boundary', async () => {
    const first = await harness({ config: { retentionDays: 90, writeEveryEvents: 10_000, writeIntervalMs: 20 } })
    const session = first.ctx.sessions.create(SessionId('timer'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'deepseek', model: 'deepseek-chat' } }),
      stream: [],
      usage: USAGE,
    }, { surfaceOp: 'append' })
    await vi.waitFor(async () => {
      expect(await storedRequests(first.root)).toBe(1)
    }, { timeout: 5_000 })
  })

  it('stays available when a durable write fails, and heals on the next flush', async () => {
    const { ctx } = await harness({ config: { retentionDays: 90, writeEveryEvents: 1, writeIntervalMs: 60_000 } })
    const ledger = ctx.usageLedger
    const session = ctx.sessions.create(SessionId('fail-soft'))
    answer(session, 1, 1)
    const internals = ledger as unknown as { table?: { put(key: string, value: UsageLedgerState): Promise<void> } }
    const table = internals.table
    if (table === undefined) throw new Error('ledger table was not opened')
    const put = vi.spyOn(table, 'put')
    put.mockRejectedValueOnce(new Error('medium unavailable'))
    const warn = vi.spyOn(ctx.logger, 'warn')
    const retry = ctx.sessions.create(SessionId('fail-soft-next'))
    answer(retry, 1, 1)
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled()
    }, { timeout: 5_000 })
    const summary = await ledger.summary('today', new AbortController().signal)
    expect(summary.totals.requests).toBe(2)
    put.mockRestore()
  })
})

describe('UsageLedger uncovered guards', () => {
  it('ignores events outside a session’s owned range', () => {
    const ledger = new UsageLedger(new Context(), { retentionDays: 90, writeEveryEvents: 100, writeIntervalMs: 60_000 })
    const observe = ledger as unknown as { observe(session: Session, event: SessionEvent): void }
    const session = { isOwnSeq: () => false } as unknown as Session
    const event = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as unknown as SessionEvent
    expect(() => { observe.observe(session, event) }).not.toThrow()
  })

  it('flushes cleanly before the domain opens', async () => {
    const ledger = new UsageLedger(new Context(), { retentionDays: 90, writeEveryEvents: 100, writeIntervalMs: 60_000 })
    const flush = ledger as unknown as { flush(): Promise<void> }
    await expect(flush.flush()).resolves.toBeUndefined()
    const init = Service.init as unknown as symbol
    const initFn = ledger as unknown as Record<symbol, () => Promise<void>>
    expect(typeof initFn[init]).toBe('function')
  })
})
