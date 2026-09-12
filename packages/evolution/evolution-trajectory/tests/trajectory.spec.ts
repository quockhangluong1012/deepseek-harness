import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { SessionEvent, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import EvolutionTrajectoryExporter, { resolveConfig } from '../src/index.ts'
import type { Config } from '../src/index.ts'

type MessageId = SessionEventMap['user/message']['id']

/** One stored logical session log served by the fake persistence backend. */
interface StoredLog {
  readonly events: SessionEvent[]
}

const sid = (id: string): SessionId => id as SessionId
const messageId = (seq: number): MessageId => brandString<MessageId>(`m${seq}`)

function turnStart(turn: number, seq: number): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn } }
}

function humanMessage(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: seq,
    data: {
      id: messageId(seq),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  }
}

/** One scripted turn: a human prompt and no assistant reply. */
function scriptedTurn(text: string): SessionEvent[] {
  return [turnStart(1, 0), humanMessage(1, text)]
}

interface BootOptions {
  readonly logs?: Map<string, StoredLog>
  readonly workspace?: Record<string, readonly string[]>
  readonly archived?: readonly string[]
  /** Live-session store; `null` mounts none, omission mounts an empty one. */
  readonly sessions?: {
    get(id: SessionId): object | undefined
    flush(session: object): Promise<boolean>
  } | null
  readonly config?: Config
}

interface Harness {
  readonly exporter: EvolutionTrajectoryExporter
  readonly logs: Map<string, StoredLog>
}

async function boot(options: BootOptions = {}): Promise<Harness> {
  const ctx = new Context()
  ctx.provide('typert', {} as never)
  const logs = options.logs ?? new Map<string, StoredLog>()
  ctx.provide('sessionPersistence', {
    open: async (id: SessionId) => {
      const stored = logs.get(String(id))
      if (stored === undefined) throw new SessionPersistenceNotFoundError(id)
      return {
        read: async () => ({ eventState: 'detached', events: stored.events }),
        close: async () => {},
      }
    },
  } as never)
  const workspace = options.workspace ?? {}
  const archived = options.archived ?? []
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => workspace[String(id)] === undefined
      ? undefined
      : { id, sessionIds: (workspace[String(id)] ?? []).map(sid) },
    archivedSessionIds: archived.map(sid),
  } as never)
  const liveStore = options.sessions === null
    ? undefined
    : options.sessions ?? { get: () => undefined, flush: async () => true }
  if (liveStore !== undefined) ctx.provide('sessions', liveStore as never)
  await ctx.plugin(EvolutionTrajectoryExporter, options.config ?? {})
  return { exporter: ctx.evolutionTrajectory, logs }
}

const roots: string[] = []
const previousHome = process.env['DSH_HOME']

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-evolution-trajectory-'))
  roots.push(dir)
  return dir
}

/** Every test exports under a throwaway harness home, never the developer's own. */
beforeEach(async () => {
  process.env['DSH_HOME'] = await tempDir()
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('the evolution trajectory Remote namespace', () => {
  it('publishes the two export verbs under its own namespace', async () => {
    const { exporter } = await boot()

    expect(exporter.typertRemote.serviceKey).toBe('evolutionTrajectory')
    expect(exporter.typertRemote.namespace).toBe('evolutionTrajectory')
    expect(remoteMethods(exporter)).toEqual([
      { method: 'exportSession', invocation: { kind: 'direct' } },
      { method: 'exportScope', invocation: { kind: 'direct' } },
    ])
    expect(exporter.toShareGpt({ sessionId: 's1', events: scriptedTurn('hello') })).toEqual([
      { id: 's1#1', conversations: [{ from: 'human', value: 'hello' }] },
    ])
  })

  it('resolves the configured export directory and leaves the default to the harness home', () => {
    expect(resolveConfig()).toEqual({ outDir: undefined })
    expect(resolveConfig({ outDir: 'D:/exports' })).toEqual({ outDir: 'D:/exports' })
  })

  it('writes one file per Session and reports its real size', async () => {
    const dir = await tempDir()
    const target = join(dir, 'nested', 'out.json')
    const { exporter } = await boot({ logs: new Map([['s1', { events: scriptedTurn('hello') }]]) })

    const result = await exporter.exportSession('s1', { out: target })

    const text = await readFile(target, 'utf8')
    expect(JSON.parse(text)).toEqual([
      { id: 's1#1', conversations: [{ from: 'human', value: 'hello' }] },
    ])
    expect(result).toEqual({ path: target, conversations: 1, bytes: Buffer.byteLength(text, 'utf8') })
  })

  it('lands the default export under the harness home, never the project directory', async () => {
    const { exporter } = await boot({ logs: new Map([['s-1', { events: scriptedTurn('hello') }]]) })

    const result = await exporter.exportSession('s-1')

    expect(result.path).toBe(join(process.env['DSH_HOME'] ?? '', 'evolution-trajectories', 's-1.sharegpt.json'))
    expect(JSON.parse(await readFile(result.path, 'utf8'))).toHaveLength(1)
  })

  it('neutralizes a Session id that would otherwise shape a path', async () => {
    const { exporter } = await boot({
      logs: new Map([
        ['a/b..c', { events: scriptedTurn('hello') }],
        ['..', { events: scriptedTurn('hello') }],
      ]),
    })

    const nested = await exporter.exportSession('a/b..c')
    const dotSegment = await exporter.exportSession('..')

    const home = join(process.env['DSH_HOME'] ?? '', 'evolution-trajectories')
    expect(nested.path).toBe(join(home, 'a_b..c.sharegpt.json'))
    expect(dotSegment.path).toBe(join(home, 'session.sharegpt.json'))
    expect((await stat(nested.path)).isFile()).toBe(true)
  })

  it('uses the configured export directory when a call names none', async () => {
    const dir = await tempDir()
    const { exporter } = await boot({
      logs: new Map([['s1', { events: scriptedTurn('hello') }]]),
      workspace: { 'ws-1': ['s1'] },
      config: { outDir: dir },
    })

    const session = await exporter.exportSession('s1')
    const scope = await exporter.exportScope('default:ws-1')

    expect(session.path).toBe(join(dir, 's1.sharegpt.json'))
    expect(scope).toEqual({ path: dir, conversations: 1, bytes: session.bytes })
  })

  it('exports a stored Session when no live-session store is mounted', async () => {
    const dir = await tempDir()
    const { exporter } = await boot({
      logs: new Map([['s1', { events: scriptedTurn('hello') }]]),
      sessions: null,
    })

    const result = await exporter.exportSession('s1', { out: join(dir, 'out.json') })

    expect(result.conversations).toBe(1)
  })

  it('lets a storage failure other than absence stay loud', async () => {
    const ctx = new Context()
    ctx.provide('typert', {} as never)
    ctx.provide('sessionPersistence', {
      open: async () => {
        throw new Error('log is unreadable')
      },
    } as never)
    ctx.provide('workspaceRegistry', {} as never)
    await ctx.plugin(EvolutionTrajectoryExporter)

    await expect(ctx.evolutionTrajectory.exportSession('s1')).rejects.toThrow('log is unreadable')
  })

  it('rejects a Session storage does not hold', async () => {
    const { exporter } = await boot()

    const failure = await exporter.exportSession('missing').catch((error: unknown) => error)

    expect(remoteErrorOf(failure)).toMatchObject({
      code: 'session/not-found',
      details: { sessionId: 'missing' },
    })
  })

  it('exports an empty array for a Session that produced no message', async () => {
    const dir = await tempDir()
    const target = join(dir, 'empty.json')
    const { exporter } = await boot({ logs: new Map([['s1', { events: [] }]]) })

    const result = await exporter.exportSession('s1', { out: target })

    expect(await readFile(target, 'utf8')).toBe('[]\n')
    expect(result).toEqual({ path: target, conversations: 0, bytes: 3 })
  })

  it('flushes a live Session so its last turn reaches the export', async () => {
    const logs = new Map([['s1', { events: scriptedTurn('first') }]])
    const { exporter } = await boot({
      logs,
      sessions: {
        get: (id: SessionId) => (String(id) === 's1' ? {} : undefined),
        flush: async () => {
          logs.get('s1')?.events.push(humanMessage(2, 'second'))
          return true
        },
      },
    })

    const result = await exporter.exportSession('s1')

    expect(JSON.parse(await readFile(result.path, 'utf8'))).toEqual([{
      id: 's1#1',
      conversations: [{ from: 'human', value: 'first' }, { from: 'human', value: 'second' }],
    }])
  })
})

describe('scope export', () => {
  it('writes one file per non-archived Session and sums the totals', async () => {
    const dir = await tempDir()
    const { exporter } = await boot({
      logs: new Map([
        ['a', { events: scriptedTurn('one') }],
        ['b', { events: scriptedTurn('archived') }],
        ['c', { events: scriptedTurn('two') }],
      ]),
      workspace: { 'ws-1': ['a', 'b', 'c'] },
      archived: ['b'],
    })

    const result = await exporter.exportScope('default:ws-1', { out: dir })

    const files = (await readdir(dir)).sort()
    expect(files).toEqual(['a.sharegpt.json', 'c.sharegpt.json'])
    const sizes = await Promise.all(files.map(async file =>
      Buffer.byteLength(await readFile(join(dir, file), 'utf8'), 'utf8')))
    expect(result).toEqual({
      path: dir,
      conversations: 2,
      bytes: sizes.reduce((total, size) => total + size, 0),
    })
    expect(JSON.parse(await readFile(join(dir, 'a.sharegpt.json'), 'utf8'))).toEqual([
      { id: 'a#1', conversations: [{ from: 'human', value: 'one' }] },
    ])
  })

  it('skips a rostered Session whose log is gone instead of failing the scope', async () => {
    const dir = await tempDir()
    const { exporter } = await boot({
      logs: new Map([['a', { events: scriptedTurn('one') }]]),
      workspace: { 'ws-1': ['a', 'gone'] },
    })

    const result = await exporter.exportScope('default:ws-1', { out: dir })

    expect(await readdir(dir)).toEqual(['a.sharegpt.json'])
    expect(result.conversations).toBe(1)
  })

  it('creates the destination and reports zeros for a scope with no Session', async () => {
    const dir = await tempDir()
    const { exporter } = await boot({ workspace: { 'ws-1': [] } })

    const result = await exporter.exportScope('default:ws-1', { out: dir })

    expect(result).toEqual({ path: dir, conversations: 0, bytes: 0 })
    expect(await readdir(dir)).toEqual([])
  })

  it('rejects a scope that names no registered Workspace', async () => {
    const { exporter } = await boot()

    const failure = await exporter.exportScope('default:nope').catch((error: unknown) => error)

    expect(remoteErrorOf(failure)).toMatchObject({
      code: 'workspace/not-found',
      details: { workspaceId: 'nope' },
    })
  })

  it('resolves a scope key that carries no profile separator', async () => {
    const dir = await tempDir()
    const { exporter } = await boot({
      logs: new Map([['a', { events: scriptedTurn('one') }]]),
      workspace: { 'ws-1': ['a'] },
    })

    const result = await exporter.exportScope('ws-1', { out: dir })

    expect(result.conversations).toBe(1)
    expect(await readdir(dir)).toEqual(['a.sharegpt.json'])
  })
})
