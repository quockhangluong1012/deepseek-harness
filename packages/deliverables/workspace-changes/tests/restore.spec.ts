/** `restore()` rewinds a working directory to one turn's start, spanning every turn since. */
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
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

async function boot() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(WorkspaceChanges, {} as WorkspaceChanges.Config)
  return ctx
}

async function repository(): Promise<string> {
  const cwd = await scratchDir('dsh-workspace-restore-repo-', cleanups)
  git(cwd, 'init', '-q', '-b', 'main')
  await writeFile(join(cwd, 'a.txt'), 'l1\nl2\nl3\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'init')
  return cwd
}

/** The seq of the turn's `workspace/changes` announcement, for restore's turn argument. */
function turnSeq(ctx: Context, sessionId: ReturnType<typeof SessionId>, turn: number): number {
  const session = ctx.sessions.get(sessionId)!
  const event = session.snapshotEvents().find(event => event.type === 'workspace/changes' && event.data.turn === turn)
  if (event === undefined) throw new Error(`no workspace/changes announcement for turn ${turn}`)
  return event.seq
}

describe('workspace-changes restore', { timeout: SUBPROCESS_TEST_TIMEOUT_MS }, () => {
  it('rewinds an edited file back to its turn-start content', async () => {
    const cwd = await repository()
    const ctx = await boot()
    const session = ctx.sessions.create(SessionId('edit'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'edit', { file_path: 'a.txt', old_string: 'l2', new_string: 'l2 model' },
      () => writeFile(join(cwd, 'a.txt'), 'l1\nl2 model\nl3\n'))
    endTurn(session, 1)
    await settle(ctx, session)

    const result = await ctx.workspaceChanges.restore(session.id, turnSeq(ctx, session.id, 1), signal)
    expect(result).toEqual({ restored: ['a.txt'], skipped: [] })
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('l1\nl2\nl3\n')
  })

  it('undoes every intervening turn, not only the named turn', async () => {
    const cwd = await repository()
    const ctx = await boot()
    const session = ctx.sessions.create(SessionId('multi-turn'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'edit', { file_path: 'a.txt', old_string: 'l2', new_string: 'l2 turn1' },
      () => writeFile(join(cwd, 'a.txt'), 'l1\nl2 turn1\nl3\n'))
    endTurn(session, 1)
    await settle(ctx, session)
    const seqTurn1 = turnSeq(ctx, session.id, 1)

    startTurn(session, 2)
    await settle(ctx, session)
    await mutate(ctx, session, 2, 'edit', { file_path: 'a.txt', old_string: 'l3', new_string: 'l3 turn2' },
      () => writeFile(join(cwd, 'a.txt'), 'l1\nl2 turn1\nl3 turn2\n'))
    await mutate(ctx, session, 2, 'write', { file_path: 'new.txt', content: 'created in turn 2\n' },
      () => writeFile(join(cwd, 'new.txt'), 'created in turn 2\n'))
    endTurn(session, 2)
    await settle(ctx, session)

    // Rewinding to turn 1's start must undo BOTH turns: turn 2's edit to a.txt and its new file.
    const result = await ctx.workspaceChanges.restore(session.id, seqTurn1, signal)
    expect(result?.skipped).toEqual([])
    expect(result?.restored.sort()).toEqual(['a.txt', 'new.txt'])
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('l1\nl2\nl3\n')
    await expect(stat(join(cwd, 'new.txt'))).rejects.toThrow()
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('reverses a rename: recreates the old path and removes the new one', async () => {
    const cwd = await repository()
    const ctx = await boot()
    const session = ctx.sessions.create(SessionId('rename'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'bash', { command: 'git mv a.txt renamed.txt' },
      async () => { await rename(join(cwd, 'a.txt'), join(cwd, 'renamed.txt')) })
    endTurn(session, 1)
    await settle(ctx, session)

    const result = await ctx.workspaceChanges.restore(session.id, turnSeq(ctx, session.id, 1), signal)
    expect(result?.skipped).toEqual([])
    expect(result?.restored).toEqual(['a.txt'])
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('l1\nl2\nl3\n')
    await expect(stat(join(cwd, 'renamed.txt'))).rejects.toThrow()
  })

  it('skips a binary file and leaves it in place', async () => {
    const cwd = await repository()
    const ctx = await boot()
    const session = ctx.sessions.create(SessionId('binary'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'write', { file_path: 'bin.dat' },
      () => writeFile(join(cwd, 'bin.dat'), Uint8Array.of(0, 1, 2, 255)))
    endTurn(session, 1)
    await settle(ctx, session)

    const result = await ctx.workspaceChanges.restore(session.id, turnSeq(ctx, session.id, 1), signal)
    expect(result?.restored).toEqual([])
    expect(result?.skipped).toEqual([{ path: 'bin.dat', display: 'bin.dat', reason: 'binary' }])
    // Left untouched: the file the turn created is still present.
    await expect(stat(join(cwd, 'bin.dat'))).resolves.toBeDefined()
  })

  it('returns undefined for an unknown sequence', async () => {
    const cwd = await repository()
    const ctx = await boot()
    const session = ctx.sessions.create(SessionId('unknown'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    endTurn(session, 1)
    await settle(ctx, session)
    expect(await ctx.workspaceChanges.restore(session.id, 999_999, signal)).toBeUndefined()
  })

  it('returns undefined outside a git repository', async () => {
    const cwd = await scratchDir('dsh-workspace-restore-plain-', cleanups)
    await writeFile(join(cwd, 'existing.txt'), 'before\n')
    const ctx = await boot()
    const session = ctx.sessions.create(SessionId('plain'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'write', { file_path: 'existing.txt', content: 'after\n' },
      () => writeFile(join(cwd, 'existing.txt'), 'after\n'))
    endTurn(session, 1)
    await settle(ctx, session)

    expect(await ctx.workspaceChanges.restore(session.id, turnSeq(ctx, session.id, 1), signal)).toBeUndefined()
  })

  it('returns undefined once the session is disposed', async () => {
    const cwd = await repository()
    const ctx = await boot()
    const session = ctx.sessions.create(SessionId('disposed'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'edit', { file_path: 'a.txt', old_string: 'l2', new_string: 'l2 model' },
      () => writeFile(join(cwd, 'a.txt'), 'l1\nl2 model\nl3\n'))
    endTurn(session, 1)
    await settle(ctx, session)
    const seq = turnSeq(ctx, session.id, 1)
    ctx.emit('session/disposed', session)

    expect(await ctx.workspaceChanges.restore(session.id, seq, signal)).toBeUndefined()
  })
})
