/** Both tools resolve one recorded turn of the calling Session by reference and render it. */
import { rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { WorkspaceChanges, WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes'
import { renderDiff, renderSummary } from '../src/render.ts'
import * as ToolChanges from '../src/index.ts'
import { GIT_SUBPROCESS_TIMEOUT_MS, callingAgent, changesFixture, modelText, type ChangesFixture } from './support.ts'

const fixtures: ChangesFixture[] = []

/** One composed fixture, disposed after the test that asked for it. */
async function fixture(config?: { maxFileBytes?: number }): Promise<ChangesFixture> {
  const value = await changesFixture(config)
  fixtures.push(value)
  return value
}

afterEach(async () => {
  for (const value of fixtures.splice(0)) await value.dispose()
})

describe('turn_changes', () => {
  it('lists the latest recorded turn and an older turn by number', async () => {
    const { cwd, execute, recordTurn } = await fixture()
    await recordTurn(1, async () => { await writeFile(join(cwd, 'added.txt'), 'a\nb\n') })
    await recordTurn(2, async () => { await writeFile(join(cwd, 'tracked.txt'), 'one\ntwo\n') })

    const latest = await execute('turn_changes', {})
    expect(latest.isError).toBe(false)
    expect(modelText(latest)).toBe([
      `Turn 2 changed 1 file (+1 -0) under ${cwd}:`,
      '  tracked.txt (+1 -0)',
      'Read one file\'s diff with turn_diff (turn 2, path as listed).',
    ].join('\n'))

    const first = await execute('turn_changes', { turn: 1 })
    expect(modelText(first)).toBe([
      `Turn 1 changed 1 file (+2 -0) under ${cwd}:`,
      '  added.txt (+2 -0)',
      'Read one file\'s diff with turn_diff (turn 1, path as listed).',
    ].join('\n'))
  }, GIT_SUBPROCESS_TIMEOUT_MS)

  it('marks a binary file instead of counting its lines', async () => {
    const { cwd, execute, recordTurn } = await fixture()
    await recordTurn(1, async () => { await writeFile(join(cwd, 'bin.dat'), 'a\u0000b\n') })

    expect(modelText(await execute('turn_changes', {}))).toContain('  bin.dat (+0 -0) [binary]')
  }, GIT_SUBPROCESS_TIMEOUT_MS)
})

describe('turn_diff', () => {
  it('reads one listed file\'s hunks, including a file above the working directory', async () => {
    const { cwd, execute, recordTurn } = await fixture()
    const root = dirname(cwd)
    await recordTurn(1, async () => {
      await writeFile(join(cwd, 'tracked.txt'), 'one\ntwo\n')
      await writeFile(join(root, 'above.txt'), 'up\n')
    })

    expect(modelText(await execute('turn_changes', {}))).toContain('../above.txt (+1 -0)')

    const tracked = await execute('turn_diff', { path: 'tracked.txt' })
    expect(tracked.isError).toBe(false)
    expect(modelText(tracked)).toBe([
      'Turn 1, tracked.txt',
      '@@ -1,1 +1,2 @@',
      ' one',
      '+two',
    ].join('\n'))

    const above = await execute('turn_diff', { path: '../above.txt' })
    expect(modelText(above)).toContain('Turn 1, ../above.txt (created)')
    expect(modelText(above)).toContain('+up')
  }, GIT_SUBPROCESS_TIMEOUT_MS)

  it('renders a deleted file and refuses an oversized comparison', async () => {
    const { cwd, execute, recordTurn } = await fixture({ maxFileBytes: 32 })
    await recordTurn(1, async () => {
      await writeFile(join(cwd, 'gone.txt'), 'x\n')
      await writeFile(join(cwd, 'big.txt'), 'y'.repeat(200))
    })
    await recordTurn(2, async () => { await rm(join(cwd, 'gone.txt')) })

    const deleted = await execute('turn_diff', { turn: 2, path: 'gone.txt' })
    expect(modelText(deleted)).toContain('Turn 2, gone.txt (deleted)')
    expect(modelText(deleted)).toContain('-x')

    const oversized = await execute('turn_diff', { turn: 1, path: 'big.txt' })
    expect(modelText(oversized)).toContain('Turn 1, big.txt: over the comparison size cap, no line comparison.')
  }, GIT_SUBPROCESS_TIMEOUT_MS)

  it('refuses work without a calling agent and names an unlisted file', async () => {
    const { cwd, execute, recordTurn } = await fixture()
    await recordTurn(1, async () => { await writeFile(join(cwd, 'a.txt'), 'a\n') })

    const detached = await execute('turn_changes', {}, false)
    expect(detached.isError).toBe(true)
    expect(modelText(detached)).toContain('require a calling agent Session')

    const unknown = await execute('turn_diff', { turn: 1, path: 'nope.txt' })
    expect(unknown.isError).toBe(true)
    expect(modelText(unknown)).toContain('turn 1 did not change a file listed as nope.txt')
  }, GIT_SUBPROCESS_TIMEOUT_MS)

  it('reports an unrecorded turn and a record this Host no longer serves', async () => {
    const { cwd, execute, recordTurn, appendUnrecorded } = await fixture()
    const none = await execute('turn_changes', {})
    expect(none.isError).toBe(true)
    expect(modelText(none)).toContain('this Session has recorded no turn changes yet')

    await recordTurn(1, async () => { await writeFile(join(cwd, 'a.txt'), 'a\n') })
    const unrecorded = await execute('turn_changes', { turn: 9 })
    expect(unrecorded.isError).toBe(true)
    expect(modelText(unrecorded)).toContain('turn 9 recorded no workspace changes in this Session')

    appendUnrecorded(7)
    const unserved = await execute('turn_changes', {})
    expect(unserved.isError).toBe(true)
    expect(modelText(unserved)).toContain('the recorded changes of turn 7 are not available in this Host process')
  }, GIT_SUBPROCESS_TIMEOUT_MS)
})

describe('a comparison the service no longer returns', () => {
  it('fails instead of reporting an empty diff', async () => {
    const ctx = new Context()
    const id = SessionId('tool-changes-stub')
    const session = Session.create(id, [], {
      version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: '/ws', isSeeded: false,
    })
    const summary: WorkspaceChangesSummary = {
      turn: 3,
      cwd: '/ws',
      files: [{ path: '/repo/a.txt', display: '../a.txt', added: 1, deleted: 0 }],
      total: 1,
      added: 1,
      deleted: 0,
    }
    const service: WorkspaceChanges = {
      summary: () => summary,
      diff: async () => undefined,
      applyHunks: async () => undefined,
      restore: async () => undefined,
    }
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    ctx.provide('workspaceChanges', service)
    await ctx.plugin(ToolChanges)
    const agent = await callingAgent(ctx, session)
    session.append('workspace/changes', { turn: 3 })

    const byDisplay = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('tool-changes-stub-display'),
      name: 'turn_diff',
      arguments: { path: '../a.txt' },
      agent,
    })
    expect(byDisplay.isError).toBe(true)
    expect(modelText(byDisplay)).toContain('is not available in this Host process')

    const byDurablePath = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('tool-changes-stub-path'),
      name: 'turn_diff',
      arguments: { path: '/repo/a.txt' },
      agent,
    })
    expect(modelText(byDurablePath)).toContain('is not available in this Host process')
    await ctx.fiber.dispose()
  })
})

describe('model-facing rendering', () => {
  it('renders every summary shape the recorder can produce', () => {
    expect(renderSummary({ turn: 4, cwd: '/ws', files: [], total: 0, added: 0, deleted: 0 }))
      .toBe('Turn 4 changed 0 files (+0 -0) under /ws.')
    expect(renderSummary({
      turn: 4,
      cwd: '/ws',
      total: 5,
      added: 4,
      deleted: 2,
      files: [
        { path: 'a.txt', display: 'a.txt', added: 4, deleted: 2 },
        { path: 'b.bin', display: 'b.bin', added: 0, deleted: 0, binary: true },
        { path: 'c.txt', display: 'c.txt', added: 0, deleted: 0, oversized: true },
      ],
    })).toBe([
      'Turn 4 changed 5 files (+4 -2) under /ws:',
      '  a.txt (+4 -2)',
      '  b.bin (+0 -0) [binary]',
      '  c.txt (+0 -0) [over the size cap]',
      '  (listing the first 3 of 5)',
      'Read one file\'s diff with turn_diff (turn 4, path as listed).',
    ].join('\n'))
  })

  it('renders every comparison shape the service can return', () => {
    expect(renderDiff({ kind: 'binary', turn: 1, path: 'p', display: 'p' }))
      .toBe('Turn 1, p: binary content, no line comparison.')
    expect(renderDiff({ kind: 'oversized', turn: 1, path: 'p', display: 'p' }))
      .toBe('Turn 1, p: over the comparison size cap, no line comparison.')
    expect(renderDiff({
      kind: 'text', turn: 2, path: 'a', display: 'a', before: false, after: true, hunks: [], coarse: false,
    })).toBe('Turn 2, a (created): no line differences.')
    expect(renderDiff({
      kind: 'text',
      turn: 2,
      path: 'a',
      display: 'a',
      before: true,
      after: false,
      coarse: true,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-x'] }],
    })).toBe('Turn 2, a (deleted) [comparison timed out; every line shown as replaced]\n@@ -1,1 +0,0 @@\n-x')
    expect(renderDiff({
      kind: 'text',
      turn: 2,
      path: 'a',
      display: 'a',
      before: true,
      after: true,
      coarse: false,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' one', '+two'] }],
    })).toBe('Turn 2, a\n@@ -1,1 +1,2 @@\n one\n+two')
  })
})
