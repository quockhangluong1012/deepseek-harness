/** `applyHunks()` writes one listed file's accepted hunks and keeps its rejected ones, in one atomic replacement. */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as WorkspaceChanges from '../src/index.ts'
import { endTurn, git, mutate, scratchDir, settle, startTurn, SUBPROCESS_TEST_TIMEOUT_MS } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

const signal = new AbortController().signal

/** Two changed lines, eight lines apart, so their hunks never merge. */
const BEFORE = `${[
  '{',
  '  "name": "app",',
  '  "port": 8080,',
  '  "host": "localhost",',
  '  "secure": false,',
  '  "timeout": 30,',
  '  "keepAlive": true,',
  '  "logLevel": "info",',
  '  "region": "eu",',
  '  "shards": 2,',
  '  "queue": "default",',
  '  "retries": 3,',
  '  "tail": true',
  '}',
].join('\n')}\n`
const AFTER = BEFORE.replace('8080', '9090').replace('"retries": 3,', '"retries": 5,')

/** One recorded mutation of the turn. */
type Mutation = (session: Session) => Promise<unknown>

async function boot(config: Partial<WorkspaceChanges.Config> = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(WorkspaceChanges, config as WorkspaceChanges.Config)
  return ctx
}

/** The announced sequence and the index of one file in the turn's summarized changes. */
function listed(ctx: Context, session: Session, path: string): { seq: number; index: number } {
  const event = session.snapshotEvents().filter(candidate => candidate.type === 'workspace/changes').at(-1)
  if (event === undefined) throw new Error('the turn announced no workspace/changes event')
  const index = ctx.workspaceChanges.summary(session.id, event.seq)?.files.findIndex(file => file.path === path) ?? -1
  if (index < 0) throw new Error(`the summary does not list ${path}`)
  return { seq: event.seq, index }
}

/** Open turn 1, apply its recorded mutations, and close it. */
async function turn(ctx: Context, id: string, cwd: string, mutations: readonly Mutation[]): Promise<Session> {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
  startTurn(session, 1)
  await settle(ctx, session)
  for (const mutation of mutations) await mutation(session)
  endTurn(session, 1)
  await settle(ctx, session)
  return session
}

/** A file-tool write of one path, captured around the call. */
function written(ctx: Context, cwd: string, path: string, content: string): Mutation {
  return session => mutate(ctx, session, 1, 'write', { file_path: path, content }, () => writeFile(join(cwd, path), content))
}

/** A repository holding the comparison fixture at its turn-start content. */
async function repository(path = 'app.json', content = BEFORE): Promise<string> {
  const cwd = await scratchDir('dsh-workspace-hunks-repo-', cleanups)
  git(cwd, 'init', '-q', '-b', 'main')
  await writeFile(join(cwd, path), content)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'init')
  return cwd
}

describe('workspace-changes applyHunks', { timeout: SUBPROCESS_TEST_TIMEOUT_MS }, () => {
  it('applies the accepted hunks and reverts the rejected ones, leaving the file intact around them', async () => {
    const cwd = await repository()
    const ctx = await boot()
    const session = await turn(ctx, 'hunks', cwd, [written(ctx, cwd, 'app.json', AFTER)])
    const { seq, index } = listed(ctx, session, 'app.json')
    expect(await ctx.workspaceChanges.diff(session.id, seq, index, signal))
      .toMatchObject({ kind: 'text', hunks: [{ oldStart: 1 }, { oldStart: 9 }] })

    const result = await ctx.workspaceChanges.applyHunks(session.id, seq, index, ['accept', 'reject'], signal)
    expect(result).toEqual({ path: 'app.json', display: 'app.json', accepted: [0], rejected: [1], exists: true })
    // The accepted hunk is applied while the rejected one keeps its turn-start line, so the document still parses.
    const mixed = await readFile(join(cwd, 'app.json'), 'utf8')
    expect(mixed).toBe(BEFORE.replace('8080', '9090'))
    expect(JSON.parse(mixed)).toEqual({ ...JSON.parse(BEFORE), port: 9090 })
  })

  it('writes each whole side when every hunk is decided the same way, and repeats the write unchanged', async () => {
    const cwd = await repository()
    const ctx = await boot()
    const session = await turn(ctx, 'all', cwd, [written(ctx, cwd, 'app.json', AFTER)])
    const { seq, index } = listed(ctx, session, 'app.json')
    const apply = (decisions: Array<'accept' | 'reject'>) =>
      ctx.workspaceChanges.applyHunks(session.id, seq, index, decisions, signal)
    const read = () => readFile(join(cwd, 'app.json'), 'utf8')

    expect(await apply(['reject', 'reject'])).toMatchObject({ accepted: [], rejected: [0, 1] })
    expect(await read()).toBe(BEFORE)
    // The same decisions write the same content again, from the recorded comparison rather than the file as it stands.
    await writeFile(join(cwd, 'app.json'), 'clobbered\n')
    expect(await apply(['reject', 'reject'])).toMatchObject({ exists: true })
    expect(await read()).toBe(BEFORE)
    expect(await apply(['accept', 'accept'])).toMatchObject({ accepted: [0, 1], rejected: [] })
    expect(await read()).toBe(AFTER)
    expect(await apply(['accept', 'accept'])).toMatchObject({ exists: true })
    expect(await read()).toBe(AFTER)
    // Each replacement renames its sibling over the target, so no temporary file survives.
    expect((await readdir(cwd)).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('removes a file the turn created when every hunk is rejected', async () => {
    const cwd = await repository()
    const ctx = await boot()
    const session = await turn(ctx, 'created', cwd, [written(ctx, cwd, 'notes.txt', 'one\ntwo\n')])
    const { seq, index } = listed(ctx, session, 'notes.txt')
    expect(await ctx.workspaceChanges.applyHunks(session.id, seq, index, ['reject'], signal))
      .toEqual({ path: 'notes.txt', display: 'notes.txt', accepted: [], rejected: [0], exists: false })
    await expect(stat(join(cwd, 'notes.txt'))).rejects.toThrow()
    expect(await ctx.workspaceChanges.applyHunks(session.id, seq, index, ['accept'], signal)).toMatchObject({ exists: true })
    expect(await readFile(join(cwd, 'notes.txt'), 'utf8')).toBe('one\ntwo\n')
  })

  it('removes a file the turn deleted when every hunk is accepted, and restores the rejected ones', async () => {
    const cwd = await repository('gone.txt', 'l1\nl2\nl3\n')
    const ctx = await boot()
    const session = await turn(ctx, 'deleted', cwd, [
      session_ => mutate(ctx, session_, 1, 'bash', { command: 'rm gone.txt' }, () => rm(join(cwd, 'gone.txt'))),
    ])
    const { seq, index } = listed(ctx, session, 'gone.txt')
    expect(await ctx.workspaceChanges.applyHunks(session.id, seq, index, ['reject'], signal))
      .toEqual({ path: 'gone.txt', display: 'gone.txt', accepted: [], rejected: [0], exists: true })
    expect(await readFile(join(cwd, 'gone.txt'), 'utf8')).toBe('l1\nl2\nl3\n')
    expect(await ctx.workspaceChanges.applyHunks(session.id, seq, index, ['accept'], signal)).toMatchObject({ exists: false })
    await expect(stat(join(cwd, 'gone.txt'))).rejects.toThrow()
  })

  it('decides a file outside any repository from the captured copies', async () => {
    const cwd = await scratchDir('dsh-workspace-hunks-plain-', cleanups)
    // Both sides come from captures here, so the file holds its turn-start content before the turn.
    await writeFile(join(cwd, 'app.json'), BEFORE)
    const ctx = await boot()
    const session = await turn(ctx, 'plain', cwd, [written(ctx, cwd, 'app.json', AFTER)])
    const { seq, index } = listed(ctx, session, 'app.json')
    expect(await ctx.workspaceChanges.applyHunks(session.id, seq, index, ['accept', 'reject'], signal))
      .toMatchObject({ accepted: [0], rejected: [1] })
    expect(await readFile(join(cwd, 'app.json'), 'utf8')).toBe(BEFORE.replace('8080', '9090'))
  })

  it('leaves the previous content in place and no temporary behind when the replacement fails', async () => {
    const cwd = await repository()
    const ctx = await boot()
    const session = await turn(ctx, 'blocked', cwd, [written(ctx, cwd, 'app.json', AFTER)])
    const { seq, index } = listed(ctx, session, 'app.json')
    // A directory in the target's place makes the rename fail after the sibling was written.
    await rm(join(cwd, 'app.json'))
    await mkdir(join(cwd, 'app.json'))
    await expect(ctx.workspaceChanges.applyHunks(session.id, seq, index, ['accept', 'accept'], signal)).rejects.toThrow()
    expect((await stat(join(cwd, 'app.json'))).isDirectory()).toBe(true)
    expect((await readdir(cwd)).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('refuses a comparison that is not text, an unknown file, and a decision count that does not match', async () => {
    const cwd = await repository()
    const ctx = await boot()
    const session = await turn(ctx, 'refusals', cwd, [
      written(ctx, cwd, 'app.json', AFTER),
      session_ => mutate(ctx, session_, 1, 'write', { file_path: 'bin.dat', content: 'x' },
        () => writeFile(join(cwd, 'bin.dat'), Uint8Array.of(0, 1, 2, 255))),
    ])
    const text = listed(ctx, session, 'app.json')
    const binary = listed(ctx, session, 'bin.dat')
    expect(await ctx.workspaceChanges.applyHunks(session.id, binary.seq, binary.index, ['accept'], signal)).toBeUndefined()
    expect(await ctx.workspaceChanges.applyHunks(session.id, text.seq, 99, ['accept', 'reject'], signal)).toBeUndefined()
    expect(await ctx.workspaceChanges.applyHunks(session.id, 999_999, text.index, ['accept', 'reject'], signal)).toBeUndefined()
    await expect(ctx.workspaceChanges.applyHunks(session.id, text.seq, text.index, ['accept'], signal))
      .rejects.toThrow('2 hunks need exactly 2 decisions, got 1')
  })

  it('refuses a snapshot side beyond the byte cap', async () => {
    const cwd = await repository()
    const ctx = await boot({ maxFileBytes: 8 })
    const session = await turn(ctx, 'capped', cwd, [
      session_ => mutate(ctx, session_, 1, 'bash', { command: 'edit app.json' }, () => writeFile(join(cwd, 'app.json'), AFTER)),
    ])
    const { seq, index } = listed(ctx, session, 'app.json')
    expect(await ctx.workspaceChanges.applyHunks(session.id, seq, index, ['accept', 'reject'], signal)).toBeUndefined()
    expect(await readFile(join(cwd, 'app.json'), 'utf8')).toBe(AFTER)
  })

  it('fails the read for a live Session and answers undefined once the Session is disposed', async () => {
    const cwd = await repository()
    const ctx = await boot()
    const session = await turn(ctx, 'disposed', cwd, [written(ctx, cwd, 'app.json', AFTER)])
    const { seq, index } = listed(ctx, session, 'app.json')
    await expect(ctx.workspaceChanges.applyHunks(session.id, seq, index, ['accept', 'reject'], AbortSignal.abort())).rejects.toThrow()
    const pending = ctx.workspaceChanges.applyHunks(session.id, seq, index, ['accept', 'reject'], signal)
    ctx.emit('session/disposed', session)
    expect(await pending).toBeUndefined()
    expect(await ctx.workspaceChanges.applyHunks(session.id, seq, index, ['accept', 'reject'], signal)).toBeUndefined()
  })

  it('answers undefined for a Session this Host never recorded', async () => {
    const cwd = await repository()
    const ctx = await boot()
    const session = await turn(ctx, 'elsewhere', cwd, [written(ctx, cwd, 'app.json', AFTER)])
    const { seq, index } = listed(ctx, session, 'app.json')
    expect(await ctx.workspaceChanges.applyHunks(SessionId('other'), seq, index, ['accept', 'reject'], signal)).toBeUndefined()
  })
})
