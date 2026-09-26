import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import ScheduleRoutines from '../src/index.ts'
import type { RoutineId } from '../src/index.ts'
import type { RoutinesState } from '../src/spec.ts'

interface TableStub {
  state: RoutinesState | undefined
  readonly puts: RoutinesState[]
}

interface Harness {
  readonly ctx: Context
  readonly table: TableStub
  readonly starts: { readonly sessionId: string; readonly message: UserMessage }[]
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
  stop(): Promise<void>
}

/** Minimal in-memory stand-in for one domain table. */
function tableStub(initial?: RoutinesState): TableStub {
  const stub: TableStub = {
    state: initial,
    puts: [],
  }
  return stub
}

async function harness(options: { readonly state?: RoutinesState; readonly failStart?: boolean } = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  const table = tableStub(options.state)
  const startList: Harness['starts'][number][] = []
  const session = { id: 'routine-session', header: { cwd: '/workspace' } }
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
  } as never)
  ctx.provide('permissionPresets', { resolve: () => ({}), set: () => {} } as never)
  ctx.provide('agentPresets', {
    resolve: async (id: string) => ({ id }),
    acquireScope: async () => ({ [Symbol.asyncDispose]: async () => {} }),
    mount: async () => ({}),
  } as never)
  ctx.provide('workspaceRegistry', {
    create: async (path: string) => ({ path, attachSession: async () => {}, detachSession: async () => {} }),
  } as never)
  ctx.provide('sessionTitle', { rename: () => ({}) } as never)
  ctx.provide('agents', {
    create: async (createOptions: { sessionId: string; setup?: (agentCtx: unknown) => Promise<void> }) => {
      if (options.failStart === true) throw new Error('agent creation failed')
      await createOptions.setup?.({ on: () => () => {} })
      return {
        agent: {
          session,
          followup: (message: UserMessage) => {
            startList.push({ sessionId: createOptions.sessionId, message })
          },
        },
        dispose: async () => {},
      }
    },
  } as never)
  ctx.provide('storageDomain', {
    open: async () => ({
      table: () => ({
        get: () => table.state,
        put: async (_key: string, value: RoutinesState) => {
          table.state = value
          table.puts.push(value)
        },
        delete: async () => true,
        update: async (_key: string, fn: (current: RoutinesState) => RoutinesState) => {
          const next = fn(table.state as RoutinesState)
          table.state = next
          return next
        },
        entries: () => [][Symbol.iterator](),
        keys: () => [][Symbol.iterator](),
        size: 0,
      }),
      close: async () => {},
    }),
  } as never)

  const plugin = await ctx.plugin(ScheduleRoutines, { tickSeconds: 3600 })
  return {
    ctx,
    table,
    starts: startList,
    plugin,
    stop: () => plugin.dispose(),
  }
}

async function run(test: Harness, input: string): Promise<CommandExecution> {
  const stubAgent = {
    session: {
      id: 'caller',
      header: { cwd: '/caller-workspace' },
      append: () => ({}),
    },
  }
  const execution = await test.ctx.commands.execute(stubAgent as never, `/routine${input}`, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`/routine${input} was not registered`)
  return execution
}

const base = new Date(Math.floor(Date.now() / 1000) * 1000)

beforeEach(() => {
  // Only the clock is faked: the scheduler's real tick timer stays inert, and
  // every due instant in these tests is decided by the mocked `Date`.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(base)
})

afterEach(() => {
  vi.useRealTimers()
})

/** ISO instant `hours` after the test's base instant, so mount-time catch-up never touches a fixture. */
function at(hours: number): string {
  return new Date(base.getTime() + hours * 3_600_000).toISOString()
}

describe('routine scheduler', () => {
  it('stores a routine due one cadence from creation and lists it', async () => {
    const test = await harness()
    try {
      const record = await test.ctx.routines.create(
        { title: 'Nightly sweep', workspacePath: '/workspace', prompt: 'Sweep the tree.', everyMinutes: 30 },
      )

      expect(record).toMatchObject({
        title: 'Nightly sweep',
        workspacePath: '/workspace',
        everyMinutes: 30,
        enabled: true,
        createdAt: base.toISOString(),
        lastFiredAt: null,
        nextDueAt: at(0.5),
      })
      expect(test.ctx.routines.list().map(candidate => candidate.id)).toEqual([record.id])
      expect(test.table.state?.routines).toHaveLength(1)
    } finally {
      await test.stop()
    }
  })

  it('starts exactly one Session per due instant and advances past missed ones', async () => {
    const test = await harness({
      state: {
        routines: [{
          id: 'routine-1',
          title: 'Sweep',
          workspacePath: '/workspace',
          prompt: 'Sweep the tree.',
          agentPreset: 'standard',
          permissionPreset: 'read-only',
          everyMinutes: 60,
          enabled: true,
          createdAt: at(-4),
          lastFiredAt: null,
          // Ten cadences behind the evaluation instant: one start, then the
          // cursor jumps past every occurrence that elapsed while down.
          nextDueAt: at(1),
        }],
      },
    })
    try {
      const evaluation = new Date(base.getTime() + 10 * 3_600_000)
      vi.setSystemTime(evaluation)
      const first = await test.ctx.routines.runDue()
      const second = await test.ctx.routines.runDue()

      expect(first).toHaveLength(1)
      expect(second).toEqual([])
      expect(test.starts).toHaveLength(1)
      expect(test.starts[0]?.sessionId).toMatch(/^routine-/u)
      expect(test.table.state?.routines[0]).toMatchObject({
        lastFiredAt: evaluation.toISOString(),
        nextDueAt: at(11),
      })
      const message = test.starts[0]?.message
      expect(message?.source).toMatchObject({ kind: 'routine', routineId: 'routine-1', form: 'notice' })
    } finally {
      await test.stop()
    }
  })

  it('leaves a paused routine alone and advances a failing one instead of retrying', async () => {
    const paused = await harness({
      state: {
        routines: [{
          id: 'routine-paused',
          title: 'Paused',
          workspacePath: '/workspace',
          prompt: 'Do nothing.',
          agentPreset: 'standard',
          permissionPreset: 'read-only',
          everyMinutes: 60,
          enabled: false,
          createdAt: at(-4),
          lastFiredAt: null,
          nextDueAt: at(1),
        }],
      },
    })
    try {
      vi.setSystemTime(new Date(base.getTime() + 10 * 3_600_000))
      expect(await paused.ctx.routines.runDue()).toEqual([])
      expect(paused.starts).toEqual([])
      expect(paused.table.state?.routines[0]?.nextDueAt).toBe(at(1))
    } finally {
      await paused.stop()
    }

    const failing = await harness({
      failStart: true,
      state: {
        routines: [{
          id: 'routine-failing',
          title: 'Failing',
          workspacePath: '/workspace',
          prompt: 'Fail.',
          agentPreset: 'standard',
          permissionPreset: 'read-only',
          everyMinutes: 60,
          enabled: true,
          createdAt: at(-4),
          lastFiredAt: null,
          nextDueAt: at(1),
        }],
      },
    })
    try {
      vi.setSystemTime(new Date(base.getTime() + 10 * 3_600_000))
      expect(await failing.ctx.routines.runDue()).toEqual([])
      expect(failing.starts).toEqual([])
      // A failed start still advances the cadence, so the next tick cannot spin.
      expect(failing.table.state?.routines[0]).toMatchObject({ lastFiredAt: null, nextDueAt: at(11) })
    } finally {
      await failing.stop()
    }
  })

  it('rejects unsupported definitions and unknown ids', async () => {
    const test = await harness()
    try {
      await expect(test.ctx.routines.create(
        { title: 'Relative', workspacePath: 'workspace', prompt: 'x', everyMinutes: 5 },
      )).rejects.toThrow('workspacePath must be absolute')
      await expect(test.ctx.routines.create(
        { title: 'Blank', workspacePath: '/workspace', prompt: '   ', everyMinutes: 5 },
      )).rejects.toThrow('prompt must not be blank')
      await expect(test.ctx.routines.create(
        { title: 'Fast', workspacePath: '/workspace', prompt: 'x', everyMinutes: 0 },
      )).rejects.toThrow('positive whole number of minutes')
      await expect(test.ctx.routines.remove('routine-missing' as RoutineId))
        .rejects.toThrow("no routine 'routine-missing'")
      await expect(test.ctx.routines.setEnabled('routine-missing' as RoutineId, false))
        .rejects.toThrow("no routine 'routine-missing'")
    } finally {
      await test.stop()
    }
  })
})

describe('/routine command', () => {
  it('adds a routine in the invoking session workspace and manages it', async () => {
    const test = await harness()
    try {
      expect((await run(test, '')).result).toEqual({ kind: 'success', text: 'No routines.' })

      const added = await run(test, ' add 15 Summarize the open pull requests')
      const text = added.result.kind === 'success' ? added.result.text ?? '' : ''
      const id = /Routine '([^']+)' runs every 15m in ([^;]+);/u.exec(text)
      expect(id?.[2]).toBe('/caller-workspace')
      const routineId = (id?.[1] ?? '') as RoutineId
      expect(test.ctx.routines.list()[0]).toMatchObject({
        prompt: 'Summarize the open pull requests',
        title: 'Summarize the open pull requests',
        workspacePath: '/caller-workspace',
        everyMinutes: 15,
      })

      expect((await run(test, ` pause ${routineId}`)).result).toEqual({
        kind: 'success',
        text: `Routine '${routineId}' is now paused.`,
      })
      expect((await run(test, ` resume ${routineId}`)).result).toEqual({
        kind: 'success',
        text: `Routine '${routineId}' is now active.`,
      })
      const listed = await run(test, '')
      expect(listed.result.kind === 'success' ? listed.result.text ?? '' : '').toContain('Summarize the open pull requests')

      expect((await run(test, ` remove ${routineId}`)).result).toEqual({
        kind: 'success',
        text: `Removed routine '${routineId}'.`,
      })
      expect(test.ctx.routines.list()).toEqual([])
    } finally {
      await test.stop()
    }
  })

  it('reports usage for malformed input and unknown ids', async () => {
    const test = await harness()
    try {
      const usage = { kind: 'error', text: 'Usage: /routine | /routine add <minutes> <prompt> | /routine pause <id> | /routine resume <id> | /routine remove <id>' }
      expect((await run(test, ' frobnicate')).result).toEqual(usage)
      expect((await run(test, ' add 15')).result).toEqual(usage)
      expect((await run(test, ' add soon do it')).result).toEqual(usage)
      expect((await run(test, ' pause routine-missing')).result).toEqual({
        kind: 'error',
        text: "No routine 'routine-missing'.",
      })
    } finally {
      await test.stop()
    }
  })

  it('fails loud at load when the configured presets are unknown', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    ctx.provide('permissionPresets', {
      resolve: () => { throw new Error('permission: unknown preset "nope"') },
    } as never)
    ctx.provide('agentPresets', { resolve: async (id: string) => ({ id }) } as never)
    ctx.provide('agentDefaultModel', { currentSelection: vi.fn() } as never)
    ctx.provide('workspaceRegistry', { create: vi.fn() } as never)
    ctx.provide('sessionTitle', { rename: vi.fn() } as never)
    ctx.provide('agents', { create: vi.fn() } as never)
    ctx.provide('storageDomain', { open: vi.fn() } as never)

    await expect(ctx.plugin(ScheduleRoutines, { permissionPreset: 'nope' }))
      .rejects.toThrow('unknown preset "nope"')
  })
})
