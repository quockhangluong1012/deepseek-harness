import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import type { EvolutionScopeId as ScopeId } from '@deepseek-ai/dsh-evolution-memory'
import EvolutionGraph from '@deepseek-ai/dsh-evolution-graph'
import type {} from '@deepseek-ai/dsh-evolution-reviewer'
import type { PassSummary, PurgeReport, RollbackReport } from '@deepseek-ai/dsh-evolution-curator'
import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import { dayKeyUTC7 } from '@deepseek-ai/dsh-usage-ledger'
import { unzipSync, strFromU8 } from 'fflate'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as commandEvolution from '../src/index.ts'
import { buildLearnPrompt, stagedFailureText } from '../src/index.ts'

interface ReviewerStub {
  calls: { scope: unknown; signal: AbortSignal }[]
  operation: (() => Promise<undefined>) | undefined
  failure: unknown
}

/** Curator and telemetry state the `/curator` command reads, when provided. */
interface GovernanceStubs {
  lastRunAt?: string | null
  passes?: PassSummary[]
  entries?: { name: string; usage: SkillUsageRecord }[]
  /** Dry-run flags passed to `run`, in call order. */
  runs?: boolean[]
  /** Tracked-skill count the fake pass reports. */
  scanned?: number
  /** Movements the fake pass reports. */
  transitions?: { name: string; from: string; to: string; reason: string }[]
  skippedPinned?: number
  skippedProtected?: number
  skippedExcluded?: number
  passId?: string | null
  /** Names passed to `adopt`, in call order. */
  adoptCalls?: string[]
  /** Error `adopt` throws, or the record it returns. */
  adoptResult?: SkillUsageRecord | Error
  /** Dry-run flags passed to `purge`, in call order. */
  purgeCalls?: boolean[]
  /** Outcome `purge` reports. */
  purgeResult?: PurgeReport
  /** Pass ids passed to `rollbackPass`, in call order. */
  rollbackCalls?: string[]
  /** Error `rollbackPass` throws, or the report it returns. */
  rollbackResult?: RollbackReport | Error
  /** (name, pinned) pairs passed to `setPinned`, in call order. */
  setPinnedCalls?: { name: string; pinned: boolean }[]
  /** Error `setPinned` throws. */
  setPinnedError?: Error
}

/** Trajectory-export state the `/trajectory` command reads, when provided. */
interface TrajectoryStub {
  /** Session exports in call order. */
  sessions: { sessionId: string; options: { out?: string } | undefined }[]
  /** Scope exports in call order. */
  scopes: { scopeId: string; options: { out?: string } | undefined }[]
  /** Export outcome reported for both verbs. */
  result?: { path: string; conversations: number; bytes: number }
  /** When set, both verbs reject with this value. */
  failure?: unknown
}

/** Skill-catalog state the `/suggestions` command reads, when provided. */
interface SkillsStub {
  /** Summaries `list` reports, in order. */
  summaries: { name: string; description: string }[]
  /** Definitions `get` reports by name; a missing name reads as undefined. */
  definitions: Record<string, unknown>
  /** Lookup options `list` received, in call order. */
  lists: { cwd?: string }[]
  /** Names `get` received, in call order. */
  gets: string[]
}

interface DreamingStub {
  runs: Array<{ phase: string; scopeId: string; sessionIds: string[] }>
  cycles: Array<{ scopeId: string; sessionIds: string[] }>
  failure?: Error
  record?: { narratives: Array<{ themes: Array<{ key: string; candidates: number }> }> }
}

interface Harness {
  ctx: Context
  plugin: Awaited<ReturnType<Context['plugin']>>
  workspaces: Map<string, { id: WorkspaceId; title: string; path: string; sessionIds: SessionId[] }>
  dir: string
  reviewer: ReviewerStub
  trajectory: TrajectoryStub
  skills: SkillsStub
  dream: DreamingStub
  /** Ordinary turns the invoking agent queued. */
  followups: unknown[]
  scope: (name: string) => ScopeId
}

async function harness(
  withReviewer = true,
  governance?: GovernanceStubs,
  extra: { trajectory?: boolean; skills?: boolean; graph?: boolean; dream?: boolean } = {},
): Promise<Harness> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'evc-')))
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const { default: EvolutionMemoryStore } = await import('@deepseek-ai/dsh-evolution-memory')
  await ctx.plugin(EvolutionMemoryStore, { capacityBytes: 65536 })
  await ctx.plugin(SessionStore)
  const workspaces = new Map<string, { id: WorkspaceId; title: string; path: string; sessionIds: SessionId[] }>()
  ctx.provide('workspaceRegistry', {
    list: () => [...workspaces.values()],
    get: (id: WorkspaceId) => workspaces.get(String(id)),
  } as never)
  const reviewer: ReviewerStub = { calls: [], operation: undefined, failure: undefined }
  if (withReviewer) {
    ctx.provide('evolutionReviewer', {
      rebuild: async (scopeId: unknown, signal: AbortSignal) => {
        reviewer.calls.push({ scope: scopeId, signal })
        if (reviewer.operation !== undefined) return reviewer.operation()
        if (reviewer.failure !== undefined) throw reviewer.failure
      },
    } as never)
  }
  if (governance?.entries !== undefined || governance?.setPinnedCalls !== undefined || governance?.setPinnedError !== undefined) {
    ctx.provide('evolutionSkillTelemetry', {
      entries: () => governance.entries ?? [],
      setPinned: async (name: string, pinned: boolean) => {
        governance.setPinnedCalls?.push({ name, pinned })
        if (governance.setPinnedError !== undefined) throw governance.setPinnedError
        return { name, useCount: 0, viewCount: 0, patchCount: 0, lastUsedAt: null, sessionIds: [], lastViewedAt: null, lastPatchedAt: null, createdAt: '2026-01-01T00:00:00.000Z', state: 'active', pinned, createdBy: null, absorbedInto: null, archivedAt: null } as SkillUsageRecord
      },
    } as never)
  } else if (governance?.entries !== undefined) {
    ctx.provide('evolutionSkillTelemetry', { entries: () => governance.entries } as never)
  }
  if (governance !== undefined) {
    ctx.provide('evolutionCurator', {
      lastRunAt: () => governance.lastRunAt ?? null,
      passes: async () => governance.passes ?? [],
      run: async (options: { dryRun?: boolean } = {}) => {
        governance.runs?.push(options.dryRun === true)
        return {
          at: '2026-09-12T01:00:00.000Z',
          dryRun: options.dryRun === true,
          scanned: governance.scanned ?? 0,
          transitions: governance.transitions ?? [],
          skippedPinned: governance.skippedPinned ?? 0,
          skippedProtected: governance.skippedProtected ?? 0,
          skippedExcluded: governance.skippedExcluded ?? 0,
          passId: options.dryRun === true ? null : governance.passId ?? null,
          snapshot: null,
        }
      },
      adopt: async (name: string) => {
        governance.adoptCalls?.push(name)
        if (governance.adoptResult instanceof Error) throw governance.adoptResult
        return governance.adoptResult ?? { name, useCount: 0, viewCount: 0, patchCount: 0, lastUsedAt: null, sessionIds: [], lastViewedAt: null, lastPatchedAt: null, createdAt: '2026-01-01T00:00:00.000Z', state: 'active', pinned: false, createdBy: 'agent', absorbedInto: null, archivedAt: null } as SkillUsageRecord
      },
      purge: async (options: { dryRun?: boolean } = {}) => {
        governance.purgeCalls?.push(options.dryRun === true)
        return governance.purgeResult ?? { at: '2026-09-12T01:00:00.000Z', dryRun: options.dryRun === true, purged: [], skippedPinned: 0 } as PurgeReport
      },
      rollbackPass: async (passId: string) => {
        governance.rollbackCalls?.push(passId)
        if (governance.rollbackResult instanceof Error) throw governance.rollbackResult
        return governance.rollbackResult ?? { at: '2026-09-12T01:00:00.000Z', label: `pass '${passId}'`, restored: [], preRollback: 'sha', restoredDirs: [] } as RollbackReport
      },
    } as never)
  }
  const trajectory: TrajectoryStub = { sessions: [], scopes: [] }
  if (extra.trajectory === true) {
    ctx.provide('evolutionTrajectory', {
      exportSession: async (sessionId: string, options: { out?: string } | undefined) => {
        trajectory.sessions.push({ sessionId, options })
        if (trajectory.failure !== undefined) throw trajectory.failure
        return trajectory.result ?? { path: 'session.zip', conversations: 1, bytes: 10 }
      },
      exportScope: async (scopeId: string, options: { out?: string } | undefined) => {
        trajectory.scopes.push({ scopeId, options })
        if (trajectory.failure !== undefined) throw trajectory.failure
        return trajectory.result ?? { path: 'scope.zip', conversations: 2, bytes: 20 }
      },
    } as never)
  }
  const dream: DreamingStub = { runs: [], cycles: [] }
  if (extra.dream === true) {
    ctx.provide('evolutionDreaming', {
      run: async (phase: string, scopeId: string, sessionIds: readonly string[]) => {
        dream.runs.push({ phase, scopeId, sessionIds: [...sessionIds] })
        if (dream.failure !== undefined) throw dream.failure
        return { phase, scopeId, scanned: 2, staged: 2, promoted: 1, pruned: 0 }
      },
      dream: async (scopeId: string, sessionIds: readonly string[]) => {
        dream.cycles.push({ scopeId, sessionIds: [...sessionIds] })
        if (dream.failure !== undefined) throw dream.failure
        return { scopeId, scanned: 2, staged: 2, promoted: 1, pruned: 0, phases: [] }
      },
      read: () => dream.record,
    } as never)
  }
  const skills: SkillsStub = { summaries: [], definitions: {}, lists: [], gets: [] }
  if (extra.skills === true) {
    ctx.provide('skills', {
      list: async (options: { cwd?: string } = {}) => {
        skills.lists.push(options)
        return skills.summaries
      },
      get: async (name: string) => {
        skills.gets.push(name)
        return skills.definitions[name]
      },
    } as never)
  }
  if (extra.graph === true) {
    await ctx.plugin(EvolutionGraph, {})
  }
  const plugin = await ctx.plugin(commandEvolution, { profile: 'test' })
  return {
    ctx,
    plugin,
    workspaces,
    dir,
    reviewer,
    trajectory,
    dream,
    skills,
    followups: [],
    scope: (name: string) => EvolutionScopeId('test', name),
  }
}

async function shutdown(test: Harness): Promise<void> {
  await test.plugin.dispose()
  await rm(test.dir, { recursive: true, force: true })
}

function sessionIn(ctx: Context, dir: string, name: string): Session {
  return ctx.sessions.create(SessionId(name), { meta: { cwd: dir } })
}

/**
 * Build the invoking-agent stand-in.
 * @param session - the agent's session.
 * @param followups - sink for the ordinary turns the agent queues.
 * @returns the agent stand-in.
 */
function fakeAgent(session: Session, followups: unknown[] = []): Agent {
  return {
    session,
    status: 'idle',
    options: {},
    reserveTurnAdmission: () => () => undefined,
    followup: (message: unknown) => { followups.push(message) },
  } as unknown as Agent
}

async function run(
  test: Harness,
  session: Session,
  line: string,
  controller = new AbortController(),
): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>> {
  const execution = await test.ctx.commands.execute(fakeAgent(session, test.followups), line, [], controller.signal)
  if (execution === undefined) throw new Error(`command was not registered for '${line}'`)
  return execution
}

function commandIdOf(event: { data: unknown }): unknown {
  return (event.data as { commandId: unknown }).commandId
}

/** One telemetry record carrying the fields `/curator` reads. */
function usageRecord(overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return {
    useCount: 0,
    viewCount: 0,
    patchCount: 0,
    lastUsedAt: null,
    sessionIds: [],
    lastViewedAt: null,
    lastPatchedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    state: 'active',
    pinned: false,
    createdBy: null,
    absorbedInto: null,
    archivedAt: null,
    ...overrides,
  }
}

/** Assert the executor-owned lifecycle pair around one result. */
function expectLifecycle(test: Harness, session: Session, name: string, args: string, outcome: CommandResult): void {
  const pair = session.snapshotEvents()
    .filter(event => event.type === 'command/run' || event.type === 'command/done')
    .slice(-2)
  expect(pair).toHaveLength(2)
  const commandId = pair[0] === undefined ? undefined : commandIdOf(pair[0])
  expect(pair.map(event => ({ type: event.type, data: event.data }))).toEqual([
    { type: 'command/run', data: { commandId, name, args, source: { kind: 'user' } } },
    { type: 'command/done', data: { commandId, ...outcome } },
  ])
  void test
}

describe('@deepseek-ai/dsh-command-evolution registration', () => {
  it('registers memory and refine commands with Loader-safe exports and disposes both', async () => {
    const test = await harness()
    try {
      expect(commandEvolution.name).toBe('command-evolution')
      expect(commandEvolution.inject).toEqual(['commands', 'workspaceRegistry', 'evolutionMemory'])
      expect('default' in commandEvolution).toBe(false)
      const loader = Object.create(Loader.prototype) as Loader
      expect(loader.unwrapExports(commandEvolution)).toBe(commandEvolution)
      const agent = fakeAgent(sessionIn(test.ctx, test.dir, 'list-agent'))
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/memory',
        name: 'memory',
        description: 'Review staged evolution memory writes',
        input: { hint: 'pending | approve <id> | reject <id>' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/refine',
        name: 'refine',
        description: 'Rebuild evolution lessons from session history',
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/journey',
        name: 'journey',
        description: 'Show or export this scope\'s recorded evolution activity',
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/skills',
        name: 'skills',
        description: 'Review staged skill proposals',
        input: { hint: 'pending | approve <id>' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/curator',
        name: 'curator',
        description: 'Manage skill curation: status, pass history, adopt, purge, pin, and rollback',
        input: { hint: 'status | run | adopt <name> | purge | rollback | ledger | pin <name>' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/trajectory',
        name: 'trajectory',
        description: 'Export this session or this scope as share-ready conversations',
        input: { hint: '[--out <path>] [--all]' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/learn',
        name: 'learn',
        description: 'Research a topic and save it as a skill through the gated writer',
        input: { hint: 'What should the harness learn?' },
      })
      expect(test.ctx.commands.list(agent)).toContainEqual({
        definitionId: '@deepseek-ai/dsh-command-evolution/suggestions',
        name: 'suggestions',
        description: 'List blueprint-backed skills without scheduling them',
      })

      await test.plugin.dispose()
      expect(test.ctx.commands.find(agent, 'memory')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'refine')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'journey')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'skills')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'curator')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'trajectory')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'learn')).toBeUndefined()
      expect(test.ctx.commands.find(agent, 'suggestions')).toBeUndefined()
    } finally {
      await rm(test.dir, { recursive: true, force: true })
    }
  })

  it('rejects malformed scope namespaces loudly at load', async () => {
    const loadMessage = async (profile: string): Promise<string> => {
      const ctx = new Context()
      ctx.provide('commands', { register: () => () => undefined } as never)
      ctx.provide('workspaceRegistry', { list: () => [] } as never)
      ctx.provide('evolutionMemory', {} as never)
      try {
        await ctx.plugin(commandEvolution, { profile })
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      return 'loaded'
    }
    expect(await loadMessage('')).toContain('profile must be non-empty')
    expect(await loadMessage('a:b')).toContain("must not contain ':'")
    expect(await loadMessage('ok')).toBe('loaded')
  })
})

describe('/memory human command', () => {
  it('reports usage for unknown and malformed inputs', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'usage')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const usage = { kind: 'error', text: 'Usage: /memory pending | approve <id> | reject <id>' } as const
      expect((await run(test, session, '/memory frobnicate')).result).toEqual(usage)
      expect((await run(test, session, '/memory pending extra')).result).toEqual(usage)
      expect((await run(test, session, '/memory approve')).result).toEqual(usage)
      expect((await run(test, session, '/memory approve a b')).result).toEqual(usage)
      expect((await run(test, session, '/memory reject')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('refuses sessions outside any workspace scope', async () => {
    const test = await harness()
    try {
      const homeless = test.ctx.sessions.create(SessionId('homeless'))
      expect((await run(test, homeless, '/memory pending')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
      const stray = test.ctx.sessions.create(SessionId('stray'), { meta: { cwd: join(test.dir, 'no-such-dir') } })
      expect((await run(test, stray, '/memory pending')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('resolves scopes through the canonical cwd fallback', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'fallback')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [] })
      expect((await run(test, session, '/memory pending')).result).toEqual({
        kind: 'success',
        text: 'No pending writes.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports no scope when the cwd matches no workspace', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'unmatched')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Elsewhere', path: join(test.dir, 'elsewhere'), sessionIds: [] })
      expect((await run(test, session, '/memory pending')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('lists pending writes honestly, empty and filled', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'pending')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const empty = await run(test, session, '/memory pending')
      expect(empty.result).toEqual({ kind: 'success', text: 'No pending writes.' })
      expectLifecycle(test, session, 'memory', ' pending', empty.result)
      // The bare command reports the same list: `pending` is the default verb.
      expect((await run(test, session, '/memory')).result).toEqual(empty.result)

      const first = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'setLessons',
        payload: { text: 'reviewed' }, originSessionId: 's1', gist: 'lessons from turn 1',
      })
      expect((await run(test, session, '/memory pending')).result).toEqual({
        kind: 'success',
        text: `1 pending write:\n- ${first.id} [memory:setLessons] lessons from turn 1 (session 's1', ${first.createdAt})`,
      })

      const second = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'skill', op: 'create',
        payload: { name: 'polish' }, originSessionId: 's2', gist: 'new skill polish',
      })
      expect((await run(test, session, '/memory pending')).result).toEqual({
        kind: 'success',
        text: `2 pending writes:\n- ${first.id} [memory:setLessons] lessons from turn 1 (session 's1', ${first.createdAt})\n- ${second.id} [skill:create] new skill polish (session 's2', ${second.createdAt})`,
      })
    } finally {
      await shutdown(test)
    }
  })

  it('approves memory writes and reports the applied op', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'approve')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'setLessons',
        payload: { text: 'tabs win' }, originSessionId: 's1', gist: 'lessons from turn 1',
      })
      const execution = await run(test, session, `/memory approve ${staged.id}`)
      expect(execution.result).toEqual({
        kind: 'success',
        text: 'Approved staged setLessons (lessons from turn 1).',
      })
      expectLifecycle(test, session, 'memory', ` approve ${staged.id}`, execution.result)
      expect(test.ctx.evolutionMemory.read(id)?.agentLessons).toBe('tabs win')
      expect(test.ctx.evolutionMemory.read(id)?.staged).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('rejects unknown staged ids on approve and reject', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'unknown')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/memory approve missing')).result).toEqual({
        kind: 'error',
        text: "No staged write 'missing'.",
      })
      expect((await run(test, session, '/memory reject missing')).result).toEqual({
        kind: 'error',
        text: "No staged write 'missing'.",
      })
    } finally {
      await shutdown(test)
    }
  })

  it('rejects staged writes without applying them', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'reject')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      await test.ctx.evolutionMemory.setLessons(id, 'keep me')
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'setLessons',
        payload: { text: 'drop me' }, originSessionId: 's1', gist: 'bad idea',
      })
      const execution = await run(test, session, `/memory reject ${staged.id}`)
      expect(execution.result).toEqual({ kind: 'success', text: `Rejected staged write '${staged.id}'.` })
      expect(test.ctx.evolutionMemory.read(id)?.agentLessons).toBe('keep me')
      expect(test.ctx.evolutionMemory.read(id)?.staged).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('routes skill approvals to /skills and keeps the entry', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'skill-approve')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'skill', op: 'create',
        payload: { name: 'polish' }, originSessionId: 's9', gist: 'new skill polish',
      })
      expect((await run(test, session, `/memory approve ${staged.id}`)).result).toEqual({
        kind: 'error',
        text: `Staged skill '${staged.id}' (create) is decided by '/skills approve ${staged.id}': write the skill with skill_manage first, then approve there to drop the entry.`,
      })
      expect(test.ctx.evolutionMemory.read(id)?.staged.map(entry => entry.id)).toEqual([staged.id])
    } finally {
      await shutdown(test)
    }
  })

  it('keeps the entry and names the code when caps reject an approval', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'cap-approve')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'setLessons',
        payload: { text: 'x'.repeat(70000) }, originSessionId: 's1', gist: 'oversized lessons',
      })
      expect((await run(test, session, `/memory approve ${staged.id}`)).result).toEqual({
        kind: 'error',
        text: `Cannot approve '${staged.id}' (evolution/too-large): evolution memory field 'agentLessons' is 70000 bytes, exceeding the 65536 byte cap. The entry stays staged.`,
      })
      expect(test.ctx.evolutionMemory.read(id)?.staged.map(entry => entry.id)).toEqual([staged.id])
    } finally {
      await shutdown(test)
    }
  })

  it('propagates unexpected store failures instead of converting them', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'explode')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'explode', payload: {}, originSessionId: 's1', gist: 'boom',
      })
      await expect(run(test, session, `/memory approve ${staged.id}`)).rejects.toThrow("unknown staged memory op 'explode'")
    } finally {
      await shutdown(test)
    }
  })
})

describe('/dream human command', () => {
  it('reports usage for an unknown phase and for trailing arguments', async () => {
    const test = await harness(true, undefined, { dream: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'dream-usage')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const usage = { kind: 'error', text: 'Usage: /dream [light|rem|deep]' } as const
      expect((await run(test, session, '/dream nightly')).result).toEqual(usage)
      expect((await run(test, session, '/dream light extra')).result).toEqual(usage)
      expect(test.dream.runs).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('says so when dreaming is not mounted', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'dream-unmounted')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/dream')).result).toEqual({
        kind: 'error',
        text: 'Dreaming consolidation is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('runs one phase for the scope sessions', async () => {
    const test = await harness(true, undefined, { dream: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'dream-phase')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/dream deep')).result).toEqual({
        kind: 'success',
        text: 'Dream deep: scanned 2, staged 2, promoted 1, pruned 0.',
      })
      expect(test.dream.runs).toEqual([{ phase: 'deep', scopeId: test.scope('ws-1'), sessionIds: [session.id] }])
      expect(test.dream.cycles).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('runs the full cycle and names the strongest themes', async () => {
    const test = await harness(true, undefined, { dream: true })
    test.dream.record = { narratives: [{ themes: [{ key: 'bash', candidates: 3 }, { key: 'pwsh', candidates: 1 }] }] }
    try {
      const session = sessionIn(test.ctx, test.dir, 'dream-cycle')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id, SessionId('other')] })
      expect((await run(test, session, '/dream')).result).toEqual({
        kind: 'success',
        text: 'Dream cycle: scanned 2, staged 2, promoted 1, pruned 0.'
          + '\nTop themes: bash (3), pwsh (1).',
      })
      expect(test.dream.cycles).toEqual([{ scopeId: test.scope('ws-1'), sessionIds: [session.id, 'other'] }])
    } finally {
      await shutdown(test)
    }
  })

  it('omits the theme line when the cycle recorded none', async () => {
    const test = await harness(true, undefined, { dream: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'dream-no-themes')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/dream')).result).toEqual({
        kind: 'success',
        text: 'Dream cycle: scanned 2, staged 2, promoted 1, pruned 0.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports a failed pass', async () => {
    const test = await harness(true, undefined, { dream: true })
    test.dream.failure = new Error('dreaming exploded')
    try {
      const session = sessionIn(test.ctx, test.dir, 'dream-failure')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/dream')).result).toEqual({ kind: 'error', text: 'dreaming exploded' })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/graph human command', () => {
  it('reports usage for missing and trailing arguments', async () => {
    const test = await harness(true, undefined, { graph: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'graph-usage')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const usage = { kind: 'error', text: 'Usage: /graph <entity> [relation]' } as const
      expect((await run(test, session, '/graph')).result).toEqual(usage)
      expect((await run(test, session, '/graph A b c')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('says so when the graph is not mounted', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'graph-unmounted')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/graph A')).result).toEqual({
        kind: 'error',
        text: 'The knowledge graph is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('answers a named relation and lists connections without one', async () => {
    const test = await harness(true, undefined, { graph: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'graph')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      await test.ctx.evolutionGraph.observe(test.scope('ws-1'), [
        { from: 'Project X', relation: 'worked_on', to: 'Alice' },
        { from: 'Project X', relation: 'uses', to: 'PostgreSQL' },
      ])
      expect((await run(test, session, '/graph "Project X" worked_on')).result).toEqual({
        kind: 'success',
        text: 'Project X —worked_on→ Alice',
      })
      expect((await run(test, session, '/graph "Project X" owns')).result).toEqual({
        kind: 'success',
        text: "Project X has no 'owns' relation.",
      })
      const connections = await run(test, session, '/graph "Project X"')
      expect(connections.result).toMatchObject({ kind: 'success' })
      expect((connections.result as { text: string }).text).toContain('- worked_on → Alice')
      expect((connections.result as { text: string }).text).toContain('- uses → PostgreSQL')
      // An unquoted single-word entity needs no quoting; an unquoted
      // multi-word one is a grammar error, not a silent partial name.
      expect((await run(test, session, '/graph alice')).result).toMatchObject({ kind: 'success' })
      expect((await run(test, session, '/graph Project X worked_on')).result).toEqual({
        kind: 'error',
        text: 'Usage: /graph <entity> [relation]',
      })
      expect((await run(test, session, '/graph Unknown')).result).toEqual({
        kind: 'success',
        text: "No entity matching 'Unknown' in this scope's graph.",
      })
      expect((await run(test, session, '/graph Unknown worked_on')).result).toEqual({
        kind: 'success',
        text: "No entity matching 'Unknown' in this scope's graph.",
      })
    } finally {
      await shutdown(test)
    }
  })

})

describe('/journey human command', () => {
  it('reports usage for an unknown range and trailing arguments', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'journey-usage')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const usage = { kind: 'error', text: 'Usage: /journey [today | 7d | 30d | all]' } as const
      expect((await run(test, session, '/journey nope')).result).toEqual(usage)
      expect((await run(test, session, '/journey 7d extra')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('refuses sessions outside any workspace scope', async () => {
    const test = await harness()
    try {
      const homeless = test.ctx.sessions.create(SessionId('journey-homeless'))
      expect((await run(test, homeless, '/journey')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('renders the default seven-day window with the scope record behind it', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'journey')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      await test.ctx.evolutionMemory.recordOutputs(id, [
        { path: 'src/a.ts', tool: 'write', sessionId: 's-output', at: new Date().toISOString() },
      ])
      await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'setLessons',
        payload: { text: 'x' }, originSessionId: 's1', gist: 'lessons from turn 1',
      })
      const usage = test.ctx.evolutionMemory.usage(id)
      const today = dayKeyUTC7(Date.now())
      const start = dayKeyUTC7(Date.now() - 6 * 86_400_000)
      const percent = Math.round((usage.usedBytes / usage.capacityBytes) * 100)
      const execution = await run(test, session, '/journey')
      expect(execution.result).toEqual({
        kind: 'success',
        text: [
          `Journey (7d) · ${start}..${today}`,
          `${today}  outputs 1 · staged 1`,
          `Memory ${usage.usedBytes}/${usage.capacityBytes} bytes (${percent}%) · lessons 0 · profile 0 · digest ${test.ctx.evolutionMemory.digest(id)}`,
          '1 staged write; run /memory pending.',
        ].join('\n'),
      })
      expectLifecycle(test, session, 'journey', '', execution.result)
    } finally {
      await shutdown(test)
    }
  })

  it('reports the unbounded range with its active-day count', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'journey-all')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      await test.ctx.evolutionMemory.recordOutputs(id, [
        { path: 'src/old.ts', tool: 'write', sessionId: 's1', at: '2026-01-02T00:00:00.000Z' },
      ])
      const execution = await run(test, session, '/journey all')
      expect(execution.result.kind).toBe('success')
      const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
      expect(text.split('\n')).toEqual([
        'Journey (all) · all (1 active day)',
        '2026-01-02  outputs 1',
        text.split('\n')[2],
        'No staged writes.',
      ])
      expect(text.split('\n')[2]).toContain('digest ')
    } finally {
      await shutdown(test)
    }
  })

  it('exports journey timeline and session log to a zip file', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'journey-export')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      await test.ctx.evolutionMemory.recordOutputs(id, [
        { path: 'src/a.ts', tool: 'write', sessionId: 's-output', at: new Date().toISOString() },
      ])
      const outPath = join(test.dir, 'journey-test.zip')
      const execution = await run(test, session, `/journey export --out ${outPath}`)
      expect(execution.result).toEqual({
        kind: 'success',
        text: `Journey exported to ${outPath}`,
      })

      // Verify the zip structure and content
      const archive = unzipSync(new Uint8Array(await readFile(outPath)))
      expect(Object.keys(archive).sort()).toEqual(['session-log.jsonl', 'timeline.json'])

      const timeline = JSON.parse(strFromU8(archive['timeline.json']!))
      expect(timeline).toHaveProperty('days')
      expect(timeline).toHaveProperty('cumulative')
      expect(timeline).toHaveProperty('pending')

      const sessionLog = strFromU8(archive['session-log.jsonl']!)
      const lines = sessionLog.trim().split('\n')
      expect(lines.length).toBeGreaterThan(0)
      const header = JSON.parse(lines[0]!)
      expect(header.type).toBe('session')
      expect(header.id).toBe('journey-export')
    } finally {
      await shutdown(test)
    }
  })
})

describe('/skills human command', () => {
  it('reports usage for malformed invocations', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'skills-usage')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const usage = { kind: 'error', text: 'Usage: /skills pending | approve <id>' } as const
      expect((await run(test, session, '/skills pending extra')).result).toEqual(usage)
      expect((await run(test, session, '/skills approve')).result).toEqual(usage)
      expect((await run(test, session, '/skills approve a b')).result).toEqual(usage)
      expect((await run(test, session, '/skills diff abc')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('reports the honest empty state and lists only skill proposals', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'skills-pending')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/skills pending')).result).toEqual({
        kind: 'success',
        text: 'No pending skill proposals. Background review proposes skills once the reviewer fork lands; write one directly with skill_manage.',
      })
      // The bare command reports the same list: `pending` is the default verb.
      expect((await run(test, session, '/skills')).result).toEqual({
        kind: 'success',
        text: 'No pending skill proposals. Background review proposes skills once the reviewer fork lands; write one directly with skill_manage.',
      })

      await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'setLessons',
        payload: { text: 'x' }, originSessionId: 's1', gist: 'lessons from turn 1',
      })
      expect((await run(test, session, '/skills pending')).result).toEqual({
        kind: 'success',
        text: 'No pending skill proposals. Background review proposes skills once the reviewer fork lands; write one directly with skill_manage.',
      })

      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'skill', op: 'create',
        payload: { name: 'polish' }, originSessionId: 's2', gist: 'new skill polish',
      })
      expect((await run(test, session, '/skills pending')).result).toEqual({
        kind: 'success',
        text: `1 pending skill proposal:\n- ${staged.id} [skill:create] new skill polish (session 's2', ${staged.createdAt})`,
      })
    } finally {
      await shutdown(test)
    }
  })

  it('approves a staged skill after its write and drops the entry', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'skills-approve')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const staged = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'skill', op: 'create',
        payload: { name: 'polish' }, originSessionId: 's2', gist: 'new skill polish',
      })
      expect((await run(test, session, `/skills approve ${staged.id}`)).result).toEqual({
        kind: 'success',
        text: 'Approved staged skill create (new skill polish). The skill file itself is written by skill_manage; approve only after that write landed.',
      })
      expect(test.ctx.evolutionMemory.read(id)?.staged).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('refuses ids that are not staged skills and reports usage for diffs', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'skills-refuse')
      const id = test.scope('ws-1')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const memory = await test.ctx.evolutionMemory.stageWrite({
        scopeId: id, kind: 'memory', op: 'setLessons',
        payload: { text: 'x' }, originSessionId: 's1', gist: 'lessons',
      })
      expect((await run(test, session, `/skills approve ${memory.id}`)).result).toEqual({
        kind: 'error',
        text: `No staged skill '${memory.id}'.`,
      })
      expect((await run(test, session, '/skills approve nope')).result).toEqual({
        kind: 'error',
        text: "No staged skill 'nope'.",
      })
      expect((await run(test, session, `/skills diff ${memory.id}`)).result).toEqual({
        kind: 'error',
        text: 'Usage: /skills pending | approve <id>',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/curator human command', () => {
  it('reports usage for malformed invocations', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-usage')
      const usage = { kind: 'error', text: 'Usage: /curator status | run [--dry-run] | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name>' } as const
      expect((await run(test, session, '/curator')).result).toEqual(usage)
      expect((await run(test, session, '/curator status extra')).result).toEqual(usage)
      expect((await run(test, session, '/curator run extra')).result).toEqual(usage)
      expect((await run(test, session, '/curator run --dry-run --dry-run')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('reports a missing curator without resolving a scope', async () => {
    const test = await harness()
    try {
      const homeless = test.ctx.sessions.create(SessionId('curator-homeless'))
      expect((await run(test, homeless, '/curator status')).result).toEqual({
        kind: 'error',
        text: 'The evolution curator is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports bookkeeping, tracked-skill counts, and the newest recorded pass', async () => {
    const test = await harness(true, {
      lastRunAt: '2026-09-12T00:00:00.000Z',
      passes: [
        { passId: 'pass-2', at: '2026-09-12T00:00:00.000Z', snapshot: 'pass-2.tar.gz', transitions: 2 },
        { passId: 'pass-1', at: '2026-09-05T00:00:00.000Z', snapshot: 'pass-1.tar.gz', transitions: 1 },
      ],
      entries: [
        { name: 'alpha', usage: usageRecord({ state: 'active' }) },
        { name: 'beta', usage: usageRecord({ state: 'stale', pinned: true }) },
        { name: 'gamma', usage: usageRecord({ state: 'archived' }) },
        { name: 'delta', usage: usageRecord({ state: 'active' }) },
      ],
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator')
      expect((await run(test, session, '/curator status')).result).toEqual({
        kind: 'success',
        text: [
          'Curator: last pass 2026-09-12T00:00:00.000Z',
          'Tracked skills: 4 (active 2, stale 1, archived 1, pinned 1)',
          'Recorded passes: 2 · newest pass-2 at 2026-09-12T00:00:00.000Z (2 transitions)',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('runs one pass and reports its movements, skips, and snapshot', async () => {
    const runs: boolean[] = []
    const test = await harness(true, {
      runs, scanned: 5, passId: 'pass-3', skippedPinned: 1, skippedExcluded: 3,
      transitions: [{ name: 'drafts', from: 'stale', to: 'archived', reason: 'idle 95d' }],
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-run')
      expect((await run(test, session, '/curator run')).result).toEqual({
        kind: 'success',
        text: [
          'Curator pass complete at 2026-09-12T01:00:00.000Z: 5 tracked skills, 1 transition',
          '- drafts: stale → archived',
          'Skipped: 1 pinned, 0 protected, 3 bundled or hub',
          'Snapshot: pass-3',
        ].join('\n'),
      })
      expect(runs).toEqual([false])
    } finally {
      await shutdown(test)
    }
  })

  it('previews a pass with --dry-run and writes nothing', async () => {
    const runs: boolean[] = []
    const test = await harness(true, {
      runs, scanned: 2,
      transitions: [{ name: 'notes', from: 'active', to: 'stale', reason: 'idle 31d' }],
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-dry-run')
      expect((await run(test, session, '/curator run --dry-run')).result).toEqual({
        kind: 'success',
        text: [
          'Curator pass previewed at 2026-09-12T01:00:00.000Z: 2 tracked skills, 1 transition (no writes)',
          '- notes: active → stale',
          'Skipped: 0 pinned, 0 protected, 0 bundled or hub',
          'Snapshot: none',
        ].join('\n'),
      })
      expect(runs).toEqual([true])
    } finally {
      await shutdown(test)
    }
  })

  it('reports a pass without movements and a missing curator for run', async () => {
    const test = await harness(true, { scanned: 1 })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-quiet')
      expect((await run(test, session, '/curator run')).result).toEqual({
        kind: 'success',
        text: [
          'Curator pass complete at 2026-09-12T01:00:00.000Z: 1 tracked skill, 0 transitions',
          'Skipped: 0 pinned, 0 protected, 0 bundled or hub',
          'Snapshot: none',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
    const bare = await harness()
    try {
      const homeless = bare.ctx.sessions.create(SessionId('curator-run-unmounted'))
      expect((await run(bare, homeless, '/curator run')).result).toEqual({
        kind: 'error',
        text: 'The evolution curator is not mounted.',
      })
    } finally {
      await shutdown(bare)
    }
  })

  it('reports a single newest-pass transition in the singular', async () => {
    const test = await harness(true, {
      lastRunAt: '2026-09-12T00:00:00.000Z',
      passes: [{ passId: 'pass-9', at: '2026-09-12T00:00:00.000Z', snapshot: 'pass-9.tar.gz', transitions: 1 }],
      entries: [],
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-single')
      const execution = await run(test, session, '/curator status')
      expect(execution.result.kind).toBe('success')
      const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
      expect(text.split('\n')).toEqual([
        'Curator: last pass 2026-09-12T00:00:00.000Z',
        'Tracked skills: 0 (active 0, stale 0, archived 0, pinned 0)',
        'Recorded passes: 1 · newest pass-9 at 2026-09-12T00:00:00.000Z (1 transition)',
      ])
    } finally {
      await shutdown(test)
    }
  })

  it('reports bookkeeping without telemetry and before the first pass', async () => {
    const test = await harness(true, { lastRunAt: null, passes: [] })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-fresh')
      expect((await run(test, session, '/curator status')).result).toEqual({
        kind: 'success',
        text: [
          'Curator: last pass never',
          'Tracked skills: unavailable (skill telemetry is not mounted).',
          'Recorded passes: 0',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('refuses adopt without a name', async () => {
    const test = await harness(true, {})
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-adopt-usage')
      const usage = { kind: 'error', text: 'Usage: /curator status | run [--dry-run] | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name>' } as const
      expect((await run(test, session, '/curator adopt')).result).toEqual(usage)
      expect((await run(test, session, '/curator adopt a b')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('adopts a skill and reports success', async () => {
    const adoptCalls: string[] = []
    const test = await harness(true, { adoptCalls })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-adopt')
      expect((await run(test, session, '/curator adopt draft-skill')).result).toEqual({
        kind: 'success',
        text: `Adopted 'draft-skill' (state: active)`,
      })
      expect(adoptCalls).toEqual(['draft-skill'])
    } finally {
      await shutdown(test)
    }
  })

  it('reports an error from adopt', async () => {
    const adoptCalls: string[] = []
    const test = await harness(true, { adoptCalls, adoptResult: new Error('curator: adopt failed') })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-adopt-err')
      expect((await run(test, session, '/curator adopt bad')).result).toEqual({
        kind: 'error',
        text: 'curator: adopt failed',
      })
      expect(adoptCalls).toEqual(['bad'])
    } finally {
      await shutdown(test)
    }
  })

  it('refuses purge with extra arguments', async () => {
    const test = await harness(true, {})
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-purge-usage')
      const usage = { kind: 'error', text: 'Usage: /curator status | run [--dry-run] | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name>' } as const
      expect((await run(test, session, '/curator purge extra')).result).toEqual(usage)
      expect((await run(test, session, '/curator purge --dry-run extra')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('purges skills and reports the list', async () => {
    const purgeCalls: boolean[] = []
    const test = await harness(true, {
      purgeCalls,
      purgeResult: {
        at: '2026-09-12T03:00:00.000Z',
        dryRun: false,
        purged: [
          { name: 'old-stale', dir: null },
          { name: 'orphaned', dir: '/path/to/orphaned' },
        ],
        skippedPinned: 1,
      },
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-purge')
      expect((await run(test, session, '/curator purge')).result).toEqual({
        kind: 'success',
        text: [
          'Purge complete at 2026-09-12T03:00:00.000Z: 2 skills removed, 1 skipped (pinned)',
          '- old-stale',
          '- orphaned (/path/to/orphaned)',
        ].join('\n'),
      })
      expect(purgeCalls).toEqual([false])
    } finally {
      await shutdown(test)
    }
  })

  it('previews purge with --dry-run', async () => {
    const purgeCalls: boolean[] = []
    const test = await harness(true, {
      purgeCalls,
      purgeResult: {
        at: '2026-09-12T03:00:00.000Z',
        dryRun: true,
        purged: [{ name: 'old-stale', dir: null }],
        skippedPinned: 0,
      },
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-purge-dry')
      expect((await run(test, session, '/curator purge --dry-run')).result).toEqual({
        kind: 'success',
        text: 'Purge previewed at 2026-09-12T03:00:00.000Z: 1 skill, 0 skipped (pinned), no writes\n- old-stale',
      })
      expect(purgeCalls).toEqual([true])
    } finally {
      await shutdown(test)
    }
  })

  it('refuses rollback without --id', async () => {
    const test = await harness(true, {})
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-rollback-usage')
      const usage = { kind: 'error', text: 'Usage: /curator status | run [--dry-run] | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name>' } as const
      expect((await run(test, session, '/curator rollback')).result).toEqual(usage)
      expect((await run(test, session, '/curator rollback --id')).result).toEqual(usage)
      expect((await run(test, session, '/curator rollback --id a b')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('rolls back a pass and reports restored skills', async () => {
    const rollbackCalls: string[] = []
    const test = await harness(true, {
      rollbackCalls,
      rollbackResult: {
        at: '2026-09-12T04:00:00.000Z',
        label: "pass 'pass-3'",
        restored: [
          { name: 'drafts', from: 'archived', to: 'stale' },
          { name: 'notes', from: 'stale', to: 'active' },
        ],
        preRollback: 'sha256',
        restoredDirs: [],
      },
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-rollback')
      expect((await run(test, session, '/curator rollback --id pass-3')).result).toEqual({
        kind: 'success',
        text: [
          "Rolled back pass 'pass-3' at 2026-09-12T04:00:00.000Z: 2 skills restored",
          '- drafts: archived → stale',
          '- notes: stale → active',
        ].join('\n'),
      })
      expect(rollbackCalls).toEqual(['pass-3'])
    } finally {
      await shutdown(test)
    }
  })

  it('reports an error from rollback', async () => {
    const rollbackCalls: string[] = []
    const test = await harness(true, { rollbackCalls, rollbackResult: new Error('curator: unknown pass') })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-rollback-err')
      expect((await run(test, session, '/curator rollback --id ghost')).result).toEqual({
        kind: 'error',
        text: 'curator: unknown pass',
      })
      expect(rollbackCalls).toEqual(['ghost'])
    } finally {
      await shutdown(test)
    }
  })

  it('lists recorded passes via ledger', async () => {
    const test = await harness(true, {
      passes: [
        { passId: 'pass-2', at: '2026-09-12T00:00:00.000Z', snapshot: 'pass-2.tar.gz', transitions: 2 },
        { passId: 'pass-1', at: '2026-09-05T00:00:00.000Z', snapshot: 'pass-1.tar.gz', transitions: 1 },
      ],
    })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-ledger')
      expect((await run(test, session, '/curator ledger')).result).toEqual({
        kind: 'success',
        text: [
          '2 passes:',
          '- pass-2 at 2026-09-12T00:00:00.000Z: 2 transitions',
          '- pass-1 at 2026-09-05T00:00:00.000Z: 1 transition',
        ].join('\n'),
      })
    } finally {
      await shutdown(test)
    }
  })

  it('reports empty ledger', async () => {
    const test = await harness(true, { passes: [] })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-ledger-empty')
      expect((await run(test, session, '/curator ledger')).result).toEqual({
        kind: 'success',
        text: 'No recorded passes.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('pins a tracked skill', async () => {
    const setPinnedCalls: { name: string; pinned: boolean }[] = []
    const test = await harness(true, { setPinnedCalls })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-pin')
      expect((await run(test, session, '/curator pin draft-skill')).result).toEqual({
        kind: 'success',
        text: `Pinned 'draft-skill'`,
      })
      expect(setPinnedCalls).toEqual([{ name: 'draft-skill', pinned: true }])
    } finally {
      await shutdown(test)
    }
  })

  it('refuses pin without a name', async () => {
    const test = await harness(true, { setPinnedCalls: [] })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-pin-usage')
      const usage = { kind: 'error', text: 'Usage: /curator status | run [--dry-run] | adopt <name> | purge [--dry-run] | rollback --id <id> | ledger | pin <name> | unpin <name>' } as const
      expect((await run(test, session, '/curator pin')).result).toEqual(usage)
      expect((await run(test, session, '/curator pin a b')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('reports an error from pin', async () => {
    const setPinnedCalls: { name: string; pinned: boolean }[] = []
    const test = await harness(true, { setPinnedCalls, setPinnedError: new Error('telemetry: no record') })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-pin-err')
      expect((await run(test, session, '/curator pin ghost')).result).toEqual({
        kind: 'error',
        text: 'telemetry: no record',
      })
      expect(setPinnedCalls).toEqual([{ name: 'ghost', pinned: true }])
    } finally {
      await shutdown(test)
    }
  })

  it('unpins a tracked skill', async () => {
    const setPinnedCalls: { name: string; pinned: boolean }[] = []
    const test = await harness(true, { setPinnedCalls })
    try {
      const session = sessionIn(test.ctx, test.dir, 'curator-unpin')
      expect((await run(test, session, '/curator unpin draft-skill')).result).toEqual({
        kind: 'success',
        text: `Unpinned 'draft-skill'`,
      })
      expect(setPinnedCalls).toEqual([{ name: 'draft-skill', pinned: false }])
    } finally {
      await shutdown(test)
    }
  })

  it('reports a missing curator for verbs that need it', async () => {
    const test = await harness()
    try {
      const homeless = test.ctx.sessions.create(SessionId('curator-missing'))
      expect((await run(test, homeless, '/curator adopt x')).result).toEqual({
        kind: 'error',
        text: 'The evolution curator is not mounted.',
      })
      expect((await run(test, homeless, '/curator ledger')).result).toEqual({
        kind: 'error',
        text: 'The evolution curator is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })
})

describe('/trajectory human command', () => {
  it('reports usage for arguments outside the grammar', async () => {
    const test = await harness(true, undefined, { trajectory: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'trajectory-usage')
      const usage = { kind: 'error', text: 'Usage: /trajectory [--out <path>] [--all]' } as const
      expect((await run(test, session, '/trajectory extra')).result).toEqual(usage)
      expect((await run(test, session, '/trajectory --out')).result).toEqual(usage)
      expect((await run(test, session, '/trajectory --out --all')).result).toEqual(usage)
      expect((await run(test, session, '/trajectory --out a --out b')).result).toEqual(usage)
      expect((await run(test, session, '/trajectory --all --all')).result).toEqual(usage)
    } finally {
      await shutdown(test)
    }
  })

  it('reports a missing exporter without resolving a scope', async () => {
    const test = await harness()
    try {
      const homeless = test.ctx.sessions.create(SessionId('trajectory-homeless'))
      expect((await run(test, homeless, '/trajectory')).result).toEqual({
        kind: 'error',
        text: 'The evolution trajectory exporter is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('exports the invoking session with and without an output path', async () => {
    const test = await harness(true, undefined, { trajectory: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'trajectory-session')
      const first = await run(test, session, '/trajectory')
      expect(first.result).toEqual({ kind: 'success', text: 'Trajectory written to session.zip (1 conversation, 10 bytes).' })
      expectLifecycle(test, session, 'trajectory', '', first.result)
      await run(test, session, '/trajectory --out out/session.zip')
      expect(test.trajectory.sessions).toEqual([
        { sessionId: session.id, options: {} },
        { sessionId: session.id, options: { out: 'out/session.zip' } },
      ])
    } finally {
      await shutdown(test)
    }
  })

  it('exports the whole scope with --all and pluralizes its counts', async () => {
    const test = await harness(true, undefined, { trajectory: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'trajectory-scope')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      test.trajectory.result = { path: 'scope.zip', conversations: 3, bytes: 2048 }
      expect((await run(test, session, '/trajectory --all')).result).toEqual({
        kind: 'success',
        text: 'Trajectory written to scope.zip (3 conversations, 2048 bytes).',
      })
      expect(test.trajectory.scopes).toEqual([{ scopeId: test.scope('ws-1'), options: {} }])
    } finally {
      await shutdown(test)
    }
  })

  it('refuses --all outside every workspace scope', async () => {
    const test = await harness(true, undefined, { trajectory: true })
    try {
      const homeless = test.ctx.sessions.create(SessionId('trajectory-scope-homeless'))
      expect((await run(test, homeless, '/trajectory --all --out x.zip')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
      expect(test.trajectory.scopes).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('maps documented export failures and propagates unexpected ones', async () => {
    const test = await harness(true, undefined, { trajectory: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'trajectory-failure')
      test.trajectory.failure = new RemoteError('evolution/export-failed' as never, 'no events', {} as never)
      expect((await run(test, session, '/trajectory')).result).toEqual({
        kind: 'error',
        text: 'Trajectory export failed (evolution/export-failed): no events.',
      })
      test.trajectory.failure = new Error('disk on fire')
      await expect(run(test, session, '/trajectory')).rejects.toThrow('disk on fire')
    } finally {
      await shutdown(test)
    }
  })
})

describe('/learn human command', () => {
  it('reports usage for a bare invocation', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'learn-usage')
      expect((await run(test, session, '/learn')).result).toEqual({ kind: 'error', text: 'Usage: /learn <anything>' })
      expect((await run(test, session, '/learn   ')).result).toEqual({ kind: 'error', text: 'Usage: /learn <anything>' })
      expect(test.followups).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('queues one ordinary turn carrying the built prompt', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'learn-prompt')
      const execution = await run(test, session, '/learn  Rust async traits  ')
      expect(execution.result).toEqual({
        kind: 'success',
        text: "Started a learning turn for 'Rust async traits'. The skill lands only through the gated skill_manage write.",
      })
      expect(test.followups).toEqual([{
        role: 'user',
        source: { kind: 'plugin', plugin: 'command-evolution' },
        content: [{ type: 'text', text: buildLearnPrompt('Rust async traits') }],
        id: expect.any(String),
      }])
      const queued = test.followups[0] as { content: { text: string }[] }
      // The prompt names the topic, the gathering tools, and the gated save.
      expect(queued.content[0]?.text).toContain('Rust async traits')
      expect(queued.content[0]?.text).toContain('skill_manage')
      expect(queued.content[0]?.text).toContain('proposal-gated')
      // The command itself wrote no skill and logged no second turn.
      expectLifecycle(test, session, 'learn', '  Rust async traits  ', execution.result)
    } finally {
      await shutdown(test)
    }
  })
})

describe('/suggestions human command', () => {
  it('reports usage for any argument and a missing registry', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'suggestions-usage')
      expect((await run(test, session, '/suggestions now')).result).toEqual({
        kind: 'error',
        text: 'Usage: /suggestions (no arguments)',
      })
      expect((await run(test, session, '/suggestions')).result).toEqual({
        kind: 'error',
        text: 'The skill registry is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('lists only blueprint-backed skills and never schedules one', async () => {
    const test = await harness(true, undefined, { skills: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'suggestions')
      test.skills.summaries = [
        { name: 'plain', description: 'no blueprint' },
        { name: 'polish', description: 'Refresh the docs nightly' },
        { name: 'bad-schedule', description: 'non-string schedule' },
        { name: 'bad-prompt', description: 'non-string prompt' },
        { name: 'bad-deliver', description: 'unknown delivery mode' },
        { name: 'legacy', description: 'blueprint in the metadata bag' },
        { name: 'vanished', description: 'listed but not loadable' },
      ]
      test.skills.definitions = {
        plain: { name: 'plain', description: 'no blueprint' },
        polish: {
          name: 'polish',
          description: 'Refresh the docs nightly',
          blueprint: { schedule: '0 3 * * *', deliver: 'session', prompt: 'Refresh the docs' },
        },
        'bad-schedule': { name: 'bad-schedule', blueprint: { schedule: 7, deliver: 'session', prompt: 'x' } },
        'bad-prompt': { name: 'bad-prompt', blueprint: { schedule: '0 3 * * *', deliver: 'session', prompt: 42 } },
        'bad-deliver': { name: 'bad-deliver', blueprint: { schedule: '0 3 * * *', deliver: 'pipe', prompt: 'x' } },
        legacy: { name: 'legacy', metadata: { blueprint: { schedule: '0 4 * * *', deliver: 'file', prompt: 'Write the digest' } } },
      }
      const execution = await run(test, session, '/suggestions')
      expect(execution.result).toEqual({
        kind: 'success',
        text: [
          '2 suggested skills:',
          '- polish: Refresh the docs nightly (schedule 0 3 * * *, deliver session)',
          '- legacy: blueprint in the metadata bag (schedule 0 4 * * *, deliver file)',
          'Suggested only: this command installs no schedule; register the one a skill names when you trust it.',
        ].join('\n'),
      })
      expectLifecycle(test, session, 'suggestions', '', execution.result)
      expect(test.skills.lists).toEqual([{ cwd: test.dir, signal: expect.any(AbortSignal) }])
      expect(test.skills.gets).toEqual(['plain', 'polish', 'bad-schedule', 'bad-prompt', 'bad-deliver', 'legacy', 'vanished'])
    } finally {
      await shutdown(test)
    }
  })

  it('reports the honest empty state for a catalog without blueprints', async () => {
    const test = await harness(true, undefined, { skills: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'suggestions-empty')
      test.skills.summaries = [{ name: 'plain', description: 'no blueprint' }]
      test.skills.definitions = { plain: { name: 'plain', blueprint: 'nope' } }
      expect((await run(test, session, '/suggestions')).result).toEqual({
        kind: 'success',
        text: 'No blueprint-backed skills. A skill appears here when its frontmatter declares a blueprint; this command never installs the schedule it names.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('lists a single suggestion in the singular', async () => {
    const test = await harness(true, undefined, { skills: true })
    try {
      const session = sessionIn(test.ctx, test.dir, 'suggestions-one')
      test.skills.summaries = [{ name: 'polish', description: 'Refresh the docs nightly' }]
      test.skills.definitions = {
        polish: { name: 'polish', blueprint: { schedule: '0 3 * * *', deliver: 'session', prompt: 'Refresh' } },
      }
      const execution = await run(test, session, '/suggestions')
      expect(execution.result.kind).toBe('success')
      const text = execution.result.kind === 'success' ? execution.result.text ?? '' : ''
      expect(text.split('\n')[0]).toBe('1 suggested skill:')
    } finally {
      await shutdown(test)
    }
  })

  it('reads a session without a cwd as a global catalog lookup', async () => {
    const test = await harness(true, undefined, { skills: true })
    try {
      const session = test.ctx.sessions.create(SessionId('suggestions-no-cwd'))
      test.skills.summaries = [{ name: 'polish', description: 'Refresh the docs nightly' }]
      test.skills.definitions = {
        polish: { name: 'polish', blueprint: { schedule: '0 3 * * *', deliver: 'session', prompt: 'Refresh' } },
      }
      await run(test, session, '/suggestions')
      expect(test.skills.lists).toEqual([{ signal: expect.any(AbortSignal) }])
    } finally {
      await shutdown(test)
    }
  })
})

describe('stagedFailureText', () => {
  it('names missing entries and codes other Remote failures with their verb', () => {
    expect(stagedFailureText('approve', 'gone', new RemoteError('evolution/staged-not-found', 'gone', { stagedId: 'gone' }))).toBe(
      "No staged write 'gone'.",
    )
    expect(stagedFailureText('reject', 'kept', new RemoteError('evolution/capacity-exceeded', 'full', { usedBytes: 9, capacityBytes: 8 }))).toBe(
      "Cannot reject 'kept' (evolution/capacity-exceeded): full. The entry stays staged.",
    )
  })
})

describe('/refine human command', () => {
  it('reports usage for invocations with arguments and refuses scopeless sessions', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'refine-usage')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/refine now')).result).toEqual({
        kind: 'error',
        text: 'Usage: /refine (no arguments)',
      })
      const homeless = test.ctx.sessions.create(SessionId('refine-homeless'))
      expect((await run(test, homeless, '/refine')).result).toEqual({
        kind: 'error',
        text: 'This session is outside any workspace scope.',
      })
      expect(test.reviewer.calls).toEqual([])
    } finally {
      await shutdown(test)
    }
  })

  it('forwards the scope and signal to the reviewer rebuild', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'refine')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const controller = new AbortController()
      const execution = await run(test, session, '/refine', controller)
      expect(execution.result).toEqual({ kind: 'success', text: 'Memory rebuild complete.' })
      expect(test.reviewer.calls).toEqual([{ scope: test.scope('ws-1'), signal: controller.signal }])
    } finally {
      await shutdown(test)
    }
  })

  it('reports a missing reviewer without calling anything', async () => {
    const test = await harness(false)
    try {
      const session = sessionIn(test.ctx, test.dir, 'no-reviewer')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      expect((await run(test, session, '/refine')).result).toEqual({
        kind: 'error',
        text: 'The evolution reviewer is not mounted.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('maps rebuild Remote failures to direct errors', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'refine-fails')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      test.reviewer.failure = new RemoteError('evolution/extraction-failed', 'no route', { scopeId: 'test:ws-1' })
      expect((await run(test, session, '/refine')).result).toEqual({
        kind: 'error',
        text: 'Memory rebuild failed (evolution/extraction-failed): no route.',
      })
    } finally {
      await shutdown(test)
    }
  })

  it('preserves cancellation and unexpected rebuild failures', async () => {
    const cancelled = await harness()
    try {
      const session = sessionIn(cancelled.ctx, cancelled.dir, 'refine-cancelled')
      cancelled.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: cancelled.dir, sessionIds: [session.id] })
      const controller = new AbortController()
      const abort = new Error('operator cancelled')
      cancelled.reviewer.operation = () => {
        controller.abort(abort)
        return Promise.reject(abort)
      }
      await expect(run(cancelled, session, '/refine', controller)).rejects.toBe(abort)
      expectLifecycle(cancelled, session, 'refine', '', { kind: 'error', text: abort.message })
    } finally {
      await shutdown(cancelled)
    }

    const unexpected = await harness()
    try {
      const session = sessionIn(unexpected.ctx, unexpected.dir, 'refine-unexpected')
      unexpected.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: unexpected.dir, sessionIds: [session.id] })
      const bug = new Error('unexpected reviewer bug')
      unexpected.reviewer.failure = bug
      await expect(run(unexpected, session, '/refine')).rejects.toBe(bug)
    } finally {
      await shutdown(unexpected)
    }
  })
})

describe('command-evolution disposal', () => {
  it('drains in-flight handlers before plugin disposal settles', async () => {
    const test = await harness()
    try {
      const session = sessionIn(test.ctx, test.dir, 'drain')
      test.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: test.dir, sessionIds: [session.id] })
      const started = Promise.withResolvers<undefined>()
      const allow = Promise.withResolvers<undefined>()
      test.reviewer.operation = async () => {
        started.resolve(undefined)
        await allow.promise
      }
      const execution = run(test, session, '/refine')
      await started.promise
      let disposed = false
      const disposal = test.plugin.dispose()
      void disposal.then(() => { disposed = true })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(test.ctx.commands.find(fakeAgent(session), 'refine')).toBeUndefined()
      expect(disposed).toBe(false)
      allow.resolve(undefined)
      await execution
      await disposal
      expect(disposed).toBe(true)
    } finally {
      await rm(test.dir, { recursive: true, force: true })
    }
  })
})
