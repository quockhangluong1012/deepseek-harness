import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionHeartbeat, { resolveConfig } from '../src/index.ts'
import type { HeartbeatReport } from '../src/types.ts'

const HOUR = 3_600_000
const T0 = Date.parse('2026-06-01T00:00:00.000Z')

afterEach(() => {
  vi.useRealTimers()
})

async function harness(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const baseline = vi.isFakeTimers() ? vi.getTimerCount() : 0
  const fiber = await ctx.plugin(EvolutionHeartbeat, config)
  return { ctx, fiber, heartbeat: ctx.evolutionHeartbeat, baseline, pool }
}

describe('evolution heartbeat', () => {
  it('resolves engine defaults', () => {
    expect(resolveConfig({})).toEqual({ enabled: true, tickMinutes: 15, minIdleHours: 2 })
    expect(resolveConfig({ enabled: false, tickMinutes: 5, minIdleHours: 0 }))
      .toEqual({ enabled: false, tickMinutes: 5, minIdleHours: 0 })
  })

  it('reads throw before the engine starts', () => {
    const ctx = new Context()
    const heartbeat = new EvolutionHeartbeat(ctx, {})
    expect(() => heartbeat.lastRunAt('anything')).toThrow('not started yet')
    expect(() => heartbeat.state()).toThrow('not started yet')
  })

  it('does not wait for the start-time due pass before the plugin resolves', async () => {
    const pending = Promise.withResolvers<HeartbeatReport>()
    const spy = vi.spyOn(EvolutionHeartbeat.prototype, 'runDue').mockReturnValue(pending.promise)
    try {
      let mounted = false
      const promise = harness().then((h) => {
        mounted = true
        return h
      })
      // If startup still awaited the pass, `mounted` would never flip while
      // `pending` is unresolved: this is the observable startup contract.
      await vi.waitFor(() => { expect(mounted).toBe(true) }, { timeout: 1000, interval: 5 })
      pending.resolve({ at: new Date().toISOString(), tasks: [] })
      const h = await promise
      await h.fiber.dispose()
    } finally {
      spy.mockRestore()
    }
  })

  it('seeds a newly registered task and defers one interval', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({ intervalHours: 1, minIdleHours: 2 })
    try {
      const runs: number[] = []
      h.heartbeat.register({ name: 'maintenance', intervalHours: 24, run: () => { runs.push(Date.now()) } })
      expect(await h.heartbeat.runDue()).toMatchObject({ tasks: [{ name: 'maintenance', outcome: 'seeded' }] })
      expect(runs).toEqual([])
      expect(h.heartbeat.lastRunAt('maintenance')).toBe(new Date(T0).toISOString())

      vi.setSystemTime(T0 + 23 * HOUR)
      expect(await h.heartbeat.runDue()).toMatchObject({
        tasks: [{ name: 'maintenance', outcome: 'deferred', reason: 'interval 24h has not elapsed' }],
      })
      expect(runs).toEqual([])

      vi.setSystemTime(T0 + 25 * HOUR)
      expect(await h.heartbeat.runDue()).toMatchObject({ tasks: [{ name: 'maintenance', outcome: 'ran' }] })
      expect(runs).toEqual([T0 + 25 * HOUR])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('holds a due task back until the host is idle', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({ intervalHours: 1, minIdleHours: 2 })
    try {
      const runs: number[] = []
      h.heartbeat.register({ name: 'maintenance', intervalHours: 1, run: () => { runs.push(Date.now()) } })
      await h.heartbeat.runDue()

      vi.setSystemTime(T0 + 3 * HOUR)
      h.ctx.emit('session/event', undefined as never, undefined as never)
      expect(await h.heartbeat.runDue()).toMatchObject({
        tasks: [{ name: 'maintenance', outcome: 'deferred', reason: 'idle 2h has not been observed' }],
      })
      expect(runs).toEqual([])

      vi.setSystemTime(T0 + 3 * HOUR + 3 * HOUR)
      expect(await h.heartbeat.runDue()).toMatchObject({ tasks: [{ name: 'maintenance', outcome: 'ran' }] })
      expect(runs).toEqual([T0 + 6 * HOUR])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('honours a per-task idle threshold above the engine default', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({ intervalHours: 1, minIdleHours: 1 })
    try {
      h.heartbeat.register({ name: 'patient', intervalHours: 1, minIdleHours: 8, run: () => {} })
      await h.heartbeat.runDue()
      vi.setSystemTime(T0 + 2 * HOUR)
      expect(await h.heartbeat.runDue({ idleMs: 2 * HOUR })).toMatchObject({
        tasks: [{ name: 'patient', outcome: 'deferred', reason: 'idle 8h has not been observed' }],
      })
      expect(await h.heartbeat.runDue({ idleMs: 8 * HOUR })).toMatchObject({ tasks: [{ name: 'patient', outcome: 'ran' }] })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('records a failure without stopping the rest of the pass', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({ intervalHours: 1, minIdleHours: 2 })
    try {
      const ran: string[] = []
      h.heartbeat.register({ name: 'first', intervalHours: 1, run: () => { throw new Error('boom') } })
      h.heartbeat.register({ name: 'second', intervalHours: 1, run: () => { ran.push('second') } })
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a task may reject with a non-Error reason.
      h.heartbeat.register({ name: 'third', intervalHours: 1, run: () => Promise.reject('plain') })
      await h.heartbeat.runDue({ force: true })
      const pass = await h.heartbeat.runDue({ force: true })
      expect(pass.tasks).toEqual([
        { name: 'first', outcome: 'failed', error: 'boom' },
        { name: 'second', outcome: 'ran' },
        { name: 'third', outcome: 'failed', error: 'plain' },
      ])
      expect(ran).toEqual(['second', 'second'])
      expect(h.heartbeat.state('first')).toMatchObject([{ lastError: 'boom' }])
      expect(h.heartbeat.lastRunAt('first')).toBe(new Date(T0).toISOString())
      expect(h.heartbeat.state('second')).toMatchObject([{ lastError: null }])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('forces a run past the interval and the idle gate', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({ intervalHours: 1, minIdleHours: 100 })
    try {
      const runs: number[] = []
      h.heartbeat.register({ name: 'maintenance', intervalHours: 24, run: () => { runs.push(Date.now()) } })
      await h.heartbeat.runDue()
      expect(await h.heartbeat.runDue()).toMatchObject({ tasks: [{ outcome: 'deferred' }] })
      expect(await h.heartbeat.runDue({ force: true })).toMatchObject({ tasks: [{ outcome: 'ran' }] })
      expect(runs).toEqual([T0])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('reports the schedule without running anything', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({ intervalHours: 1, minIdleHours: 0 })
    try {
      h.heartbeat.register({ name: 'maintenance', intervalHours: 6, run: () => {} })
      expect(h.heartbeat.state('maintenance')).toEqual([{
        name: 'maintenance',
        intervalHours: 6,
        minIdleHours: 0,
        lastRunAt: null,
        lastError: null,
        due: true,
      }])
      expect(h.heartbeat.state('missing')).toEqual([])
      expect(h.heartbeat.lastRunAt('missing')).toBeNull()
      await h.heartbeat.runDue()
      expect(h.heartbeat.state('maintenance')).toMatchObject([{ lastRunAt: new Date(T0).toISOString(), due: false }])
      expect(h.heartbeat.state()).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('runs one task on demand and removes it on disposal', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness()
    try {
      const runs: number[] = []
      const dispose = h.heartbeat.register({ name: 'maintenance', intervalHours: 1, run: () => { runs.push(Date.now()) } })
      expect(await h.heartbeat.runTask('maintenance')).toEqual({ name: 'maintenance', outcome: 'ran' })
      expect(await h.heartbeat.runTask('missing')).toBeUndefined()
      await dispose()
      await dispose()
      expect(runs).toEqual([T0])
      expect(await h.heartbeat.runDue()).toMatchObject({ tasks: [] })
      expect(h.heartbeat.state()).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rejects an unusable registration', async () => {
    const h = await harness()
    try {
      h.heartbeat.register({ name: 'taken', intervalHours: 1, run: () => {} })
      expect(() => h.heartbeat.register({ name: 'taken', intervalHours: 1, run: () => {} }))
        .toThrow("task 'taken' is already registered")
      expect(() => h.heartbeat.register({ name: 'bad name', intervalHours: 1, run: () => {} }))
        .toThrow('must match')
      expect(() => h.heartbeat.register({ name: 'fast', intervalHours: 0.5, run: () => {} }))
        .toThrow('intervalHours must be at least 1')
      expect(() => h.heartbeat.register({ name: 'needy', intervalHours: 1, minIdleHours: -1, run: () => {} }))
        .toThrow('minIdleHours must not be negative')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('seeds on the scheduled tick and runs on the next one', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({ tickMinutes: 10, intervalHours: 1, minIdleHours: 0 })
    try {
      const runs: number[] = []
      h.heartbeat.register({ name: 'maintenance', intervalHours: 1, run: () => { runs.push(Date.now()) } })
      // The start-time due pass seeds the task at T0; the 10-minute tick
      // defers it, and the tick after the interval elapses runs it.
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(h.heartbeat.lastRunAt('maintenance')).toBe(new Date(T0).toISOString())
      expect(runs).toEqual([])
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(runs).toEqual([T0 + 60 * 60_000])
      expect(h.heartbeat.lastRunAt('maintenance')).toBe(new Date(T0 + 60 * 60_000).toISOString())
    } finally {
      await h.fiber.dispose()
    }
  })

  it('runs one due pass at a time and answers a re-entrant call with it', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({ intervalHours: 1, minIdleHours: 0 })
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    try {
      let runs = 0
      h.heartbeat.register({
        name: 'slow',
        intervalHours: 1,
        run: async () => {
          runs += 1
          started.resolve(undefined)
          await release.promise
        },
      })
      await h.heartbeat.runDue()
      vi.setSystemTime(T0 + 2 * HOUR)
      const first = h.heartbeat.runDue()
      await started.promise
      const second = h.heartbeat.runDue()
      // The second call joins the pass already running instead of starting one.
      expect(second).toBe(first)
      release.resolve(undefined)
      await expect(second).resolves.toMatchObject({ tasks: [{ name: 'slow', outcome: 'ran' }] })
      expect(runs).toBe(1)
      // Once the pass settles, the next call starts a fresh one.
      expect(h.heartbeat.runDue()).not.toBe(first)
    } finally {
      release.resolve(undefined)
      await h.fiber.dispose()
    }
  })

  it('schedules the start-time due pass after the mounting turn', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({ intervalHours: 1, minIdleHours: 0 })
    try {
      const runs: string[] = []
      h.heartbeat.register({ name: 'early', intervalHours: 1, run: () => { runs.push('early') } })
      // No pass runs inside `init`: the pending zero-delay timer is what seeds
      // the task registered after the mount, and it still only seeds.
      expect(h.heartbeat.lastRunAt('early')).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      expect(h.heartbeat.lastRunAt('early')).toBe(new Date(T0).toISOString())
      expect(runs).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('contains a scheduled pass that cannot write its bookkeeping', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({ tickMinutes: 10, intervalHours: 1, minIdleHours: 0 })
    try {
      const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
      h.heartbeat.register({ name: 'maintenance', intervalHours: 1, run: () => {} })
      h.pool.failNextWrites = 1
      await vi.advanceTimersByTimeAsync(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('scheduled pass failed'))
      expect(h.heartbeat.lastRunAt('maintenance')).toBeNull()
      // The failed start pass leaves the schedule intact: the tick seeds it.
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1)
      expect(h.heartbeat.lastRunAt('maintenance')).toBe(new Date(T0 + 10 * 60_000).toISOString())
    } finally {
      await h.fiber.dispose()
    }
  })

  it('aborts and drains every active task before plugin disposal resolves', async () => {
    const h = await harness()
    const names = ['first', 'second']
    const started = new Map(names.map(name => [name, Promise.withResolvers<undefined>()] as const))
    const release = new Map(names.map(name => [name, Promise.withResolvers<undefined>()] as const))
    const aborted = new Set<string>()
    for (const name of names) {
      h.heartbeat.register({
        name,
        intervalHours: 1,
        run: async (signal) => {
          started.get(name)!.resolve(undefined)
          signal.addEventListener('abort', () => { aborted.add(name) }, { once: true })
          await release.get(name)!.promise
        },
      })
    }
    const runs = names.map(name => h.heartbeat.runTask(name))
    await Promise.all([...started.values()].map(value => value.promise))
    let disposed = false
    const disposal = h.fiber.dispose().then(() => { disposed = true })
    try {
      await vi.waitFor(() => { expect([...aborted].sort()).toEqual(names) })
      expect(disposed).toBe(false)
      release.get(names[0]!)!.resolve(undefined)
      await runs[0]
      expect(disposed).toBe(false)
      release.get(names[1]!)!.resolve(undefined)
      await Promise.all([disposal, ...runs])
      expect(disposed).toBe(true)
    } finally {
      for (const value of release.values()) value.resolve(undefined)
      await Promise.allSettled([disposal, ...runs])
      await h.fiber.dispose()
    }
  })

  it('drains a task before its provider plugin unloads', async () => {
    const h = await harness()
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let signal: AbortSignal | undefined
    const ownerPlugin = Object.assign((ctx: Context) => {
      ctx.effect(() => ctx.evolutionHeartbeat.register({
        name: 'owned',
        intervalHours: 1,
        run: async (taskSignal) => {
          signal = taskSignal
          started.resolve(undefined)
          await release.promise
        },
      }))
    }, { inject: ['evolutionHeartbeat'] })
    const owner = await h.ctx.plugin(ownerPlugin)
    const running = h.heartbeat.runTask('owned')
    await started.promise
    let disposed = false
    const disposal = owner.dispose().then(() => { disposed = true })
    try {
      await vi.waitFor(() => { expect(signal?.aborted).toBe(true) })
      expect(disposed).toBe(false)
      release.resolve(undefined)
      await Promise.all([disposal, running])
      expect(disposed).toBe(true)
      await expect(running).resolves.toMatchObject({ outcome: 'deferred' })
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([disposal, running])
      await h.fiber.dispose()
    }
  })

  it('owns no timer while disabled and releases both handles on disposal', async () => {
    vi.useFakeTimers({ now: T0 })
    const off = await harness({ enabled: false })
    try {
      expect(vi.getTimerCount()).toBe(off.baseline)
      expect(await off.heartbeat.runDue()).toMatchObject({ tasks: [] })
    } finally {
      await off.fiber.dispose()
    }
    const on = await harness()
    try {
      // The pending start-time due pass plus the repeating tick; the start
      // handle is released once it fires.
      expect(vi.getTimerCount()).toBe(on.baseline + 2)
      await vi.advanceTimersByTimeAsync(1)
      expect(vi.getTimerCount()).toBe(on.baseline + 1)
    } finally {
      await on.fiber.dispose()
    }
    expect(vi.getTimerCount()).toBe(on.baseline)
  })
})
