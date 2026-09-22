import { describe, expect, it } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import EvolutionHeartbeat from '@deepseek-ai/dsh-evolution-heartbeat'
import EvolutionRouter from '@deepseek-ai/dsh-evolution-router'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionSleeptime, { ANTICIPATION_TASK_NAME } from '../src/index.ts'

/** The recorded-evidence seams a case mounts, `false` leaving one unmounted. */
interface Sources {
  /** The routing store whose measured outcomes are the route occurrences. */
  router?: boolean
  /** The skill-telemetry store naming the skills and their sessions. */
  telemetry?: readonly { name: string; sessionIds: readonly string[] }[]
  /** Learning-trace rows by session id; a null entry records no updated instant. */
  traces?: Record<string, { tokens: number; updatedAt: string | null }>
}

/** Recorded-evidence stubs stand in for the trace projection, which needs a session backend. */
function stubSources(ctx: Context, sources: Sources): void {
  if (sources.telemetry !== undefined) {
    ctx.provide('evolutionSkillTelemetry', {
      entries: () => sources.telemetry?.map(entry => ({ name: entry.name, usage: { sessionIds: entry.sessionIds } })),
    } as never)
  }
  if (sources.traces !== undefined) {
    ctx.provide('evolutionTrace', {
      summary: async (sessionIds: readonly string[]) => sessionIds
        .filter(id => sources.traces?.[id] !== undefined)
        .map(id => ({ sessionId: id, tokens: sources.traces?.[id]?.tokens ?? 0, updatedAt: sources.traces?.[id]?.updatedAt ?? null })),
    } as never)
  }
}

async function boot(sources: Sources = {}, config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  // Disabled so no timer starts: the case drives the pass through `runTask`.
  await ctx.plugin(EvolutionHeartbeat, { enabled: false })
  if (sources.router !== false) await ctx.plugin(EvolutionRouter, {})
  stubSources(ctx, sources)
  const fiber = await ctx.plugin(EvolutionSleeptime, config ?? {})
  return { ctx, fiber, store: ctx.evolutionSleeptime, router: ctx.evolutionRouter, heartbeat: ctx.evolutionHeartbeat }
}

/** Record one measured route outcome of `taskClass` now, the recurrence evidence. */
async function observe(router: EvolutionRouter, taskClass: string, tokens = 4000): Promise<string> {
  const outcome = await router.observe({
    taskClass,
    role: 'task-execution',
    provider: 'deepseek',
    model: 'chat',
    pass: true,
    tokens,
    wallTimeMs: 1000,
  })
  return outcome.at
}

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString()

describe('evolution sleeptime anticipation pass', () => {
  it('anticipates the class the router recorded and precomputes its artifact once', async () => {
    const { fiber, store, router, heartbeat } = await boot({ router: true })
    try {
      for (let i = 0; i < 3; i += 1) await observe(router, 'writer')
      await heartbeat.runTask(ANTICIPATION_TASK_NAME)
      const tasks = store.tasks()
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({
        taskId: 'route:writer',
        domain: 'route',
        scope: 'writer',
        likelihood: 1,
        expectedQueries: 3,
        expectedSavingTokens: 4000,
      })
      const artifacts = store.artifacts()
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0]).toMatchObject({
        artifactId: 'route:writer',
        taskId: 'route:writer',
        kind: 'summary',
        offlineCostTokens: 2000,
        hits: 0,
        savedTokens: 0,
        servedThroughAt: null,
      })
      expect(artifacts[0]?.summary).toContain('route:writer recurred 3 times')
      // The plan states why it ran: the recorded recurrence is the justification.
      expect(artifacts[0]?.decisionReason).toContain('net 10000 tokens')
    } finally {
      await fiber.dispose()
    }
  })

  it('records neither a second task nor a second artifact on the next pass', async () => {
    const { fiber, store, router, heartbeat } = await boot({ router: true })
    try {
      for (let i = 0; i < 3; i += 1) await observe(router, 'writer')
      await heartbeat.runTask(ANTICIPATION_TASK_NAME)
      const first = store.artifacts()[0]
      await heartbeat.runTask(ANTICIPATION_TASK_NAME)
      expect(store.tasks()).toHaveLength(1)
      expect(store.artifacts()).toHaveLength(1)
      expect(store.artifacts()[0]).toEqual(first)
      expect(store.artifacts()[0]?.hits).toBe(0)
    } finally {
      await fiber.dispose()
    }
  })

  it('records nothing when no source recorded recurrence', async () => {
    const { fiber, store, heartbeat } = await boot({ router: true })
    try {
      await heartbeat.runTask(ANTICIPATION_TASK_NAME)
      expect(store.tasks()).toEqual([])
      expect(store.artifacts()).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('records a hit when a later recorded occurrence consumes the artifact', async () => {
    const { fiber, store, router, heartbeat } = await boot({ router: true })
    try {
      for (let i = 0; i < 3; i += 1) await observe(router, 'writer')
      await heartbeat.runTask(ANTICIPATION_TASK_NAME)
      await delay(5)
      const consumedAt = await observe(router, 'writer', 900)
      await delay(5)
      await heartbeat.runTask(ANTICIPATION_TASK_NAME)
      const accounted = store.artifacts()[0]
      expect(accounted).toMatchObject({ hits: 1, savedTokens: 900, servedThroughAt: consumedAt })
      // The cursor is what keeps the same occurrence from counting twice.
      await heartbeat.runTask(ANTICIPATION_TASK_NAME)
      expect(store.artifacts()[0]?.hits).toBe(1)
      await heartbeat.runTask(ANTICIPATION_TASK_NAME)
      expect(store.artifacts()[0]?.hits).toBe(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('skips a task the plan rates but no recorded recurrence stands behind', async () => {
    const { fiber, store, heartbeat } = await boot()
    try {
      await store.anticipate({
        taskId: 'operator:nightly-review',
        domain: 'operator',
        likelihood: 1,
        expectedQueries: 10,
        expectedSavingTokens: 100_000,
      })
      // The plan rates it, so a pass that precomputed on the plan's word alone
      // would spend the offline budget on an invented future.
      expect(store.plan().map(decision => decision.taskId)).toEqual(['operator:nightly-review'])
      await heartbeat.runTask(ANTICIPATION_TASK_NAME)
      expect(store.artifacts()).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('derives recurrence from skill telemetry token-accounted by the trace store', async () => {
    const { fiber, store, heartbeat } = await boot({
      router: false,
      telemetry: [
        { name: 'pdf-extract', sessionIds: ['s1', 's2', 's3', 's4'] },
        { name: 'never-loaded', sessionIds: [] },
      ],
      traces: {
        s1: { tokens: 4000, updatedAt: hoursAgo(3) },
        s2: { tokens: 5000, updatedAt: hoursAgo(2) },
        s3: { tokens: 6000, updatedAt: hoursAgo(1) },
        s4: { tokens: 7000, updatedAt: null },
      },
    })
    try {
      await heartbeat.runTask(ANTICIPATION_TASK_NAME)
      const tasks = store.tasks()
      // The trace row with no recorded instant and the skill no session loaded
      // are not occurrences, so the recurred class is the only anticipation.
      expect(tasks.map(task => task.taskId)).toEqual(['skill:pdf-extract'])
      expect(tasks[0]).toMatchObject({ expectedQueries: 3, expectedSavingTokens: 5000 })
      expect(store.artifacts()[0]).toMatchObject({ artifactId: 'skill:pdf-extract', hits: 0 })
    } finally {
      await fiber.dispose()
    }
  })

  it('anticipates nothing from telemetry while the trace store is unmounted', async () => {
    const { fiber, store, heartbeat } = await boot({
      router: false,
      telemetry: [{ name: 'pdf-extract', sessionIds: ['s1', 's2', 's3'] }],
    })
    try {
      await heartbeat.runTask(ANTICIPATION_TASK_NAME)
      expect(store.tasks()).toEqual([])
      expect(store.artifacts()).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('stops before the skill sources when the pass is aborted', async () => {
    const { fiber, store, router } = await boot({
      router: true,
      telemetry: [{ name: 'pdf-extract', sessionIds: ['s1', 's2', 's3'] }],
      traces: {
        s1: { tokens: 100, updatedAt: hoursAgo(3) },
        s2: { tokens: 100, updatedAt: hoursAgo(2) },
        s3: { tokens: 100, updatedAt: hoursAgo(1) },
      },
    })
    try {
      for (let i = 0; i < 3; i += 1) await observe(router, 'writer')
      const controller = new AbortController()
      controller.abort()
      await store.anticipateAll(controller.signal)
      // The route occurrences were read before the abort; the skill pass never ran.
      expect(store.tasks().map(task => task.taskId)).toEqual(['route:writer'])
    } finally {
      await fiber.dispose()
    }
  })

  it('honors explicit recurrence and cadence choices', async () => {
    const { fiber, store, router, heartbeat } = await boot({ router: true }, {
      minRecurrences: 2,
      recurrenceWindowHours: 1,
      maxPerPass: 1,
      intervalHours: 12,
    })
    try {
      // Two occurrences inside the window recur under `minRecurrences: 2`, and
      // the likelier class is the one the pass takes.
      await observe(router, 'reader', 8000)
      await observe(router, 'reader', 8000)
      for (let i = 0; i < 3; i += 1) await observe(router, 'writer')
      await heartbeat.runTask(ANTICIPATION_TASK_NAME)
      expect(store.tasks().map(task => task.taskId)).toEqual(['route:writer'])
      expect(store.artifacts().map(artifact => artifact.artifactId)).toEqual(['route:writer'])
      expect(heartbeat.state(ANTICIPATION_TASK_NAME)[0]?.intervalHours).toBe(12)
    } finally {
      await fiber.dispose()
    }
  })

  it('ignores recorded occurrences older than the recurrence window', async () => {
    const { fiber, store, heartbeat } = await boot({
      router: false,
      telemetry: [{ name: 'pdf-extract', sessionIds: ['s1', 's2', 's3'] }],
      traces: {
        s1: { tokens: 100, updatedAt: hoursAgo(300) },
        s2: { tokens: 100, updatedAt: hoursAgo(250) },
        s3: { tokens: 100, updatedAt: hoursAgo(200) },
      },
    }, { minRecurrences: 2, recurrenceWindowHours: 168 })
    try {
      await heartbeat.runTask(ANTICIPATION_TASK_NAME)
      expect(store.tasks()).toEqual([])
      expect(store.artifacts()).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })
})
