/**
 * Tests for artifact retrieval over a REAL local store: the files
 * `LocalSpillStore.saveText` wrote are found by search, read whole or windowed,
 * projected by a pattern, compared by diff, and retained under a summary budget.
 * A locator this backend did not store — a path outside the root, a path that is
 * not a session artifact path, a symlink, or an unknown name — is refused, and a
 * retrieval leaves the stored bytes untouched.
 */

import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ArtifactLocatorError, SpillLocator } from '@deepseek-ai/dsh-spill'
import LocalSpillStore, { sessionDir } from '@deepseek-ai/dsh-spill-local'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-artifact-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Mount the real backend on a fresh context and dispose it with the test. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LocalSpillStore, { root, cleanupPeriodDays: 0 })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return ctx
}

/** Save one artifact through the storage seam and return its locator. */
async function save(ctx: Context, name: string, content: string, session = 'sess-1') {
  return await ctx.spillStore.saveText({
    owner: { sessionId: SessionId(session) },
    source: { kind: 'tool', toolName: 'web_fetch', callId: ToolCallId('call-1'), label: 'result' },
    suggestedName: name,
    content,
  })
}

describe('search', () => {
  it('lists the session artifacts newest first and filters by stored name', async () => {
    const ctx = await mount()
    const older = await save(ctx, 'older.txt', 'old')
    const newer = await save(ctx, 'newer.txt', 'new')
    await utimes(String(older.locator), 1_000, 1_000)
    await utimes(String(newer.locator), 2_000, 2_000)

    const all = await ctx.artifacts.search({ owner: { sessionId: SessionId('sess-1') } })
    expect(all.map(match => match.locator)).toEqual([newer.locator, older.locator])
    expect(all.map(match => match.bytes)).toEqual([3, 3])
    expect(all[0]?.savedAt).toBe(new Date(2_000_000).toISOString())
    expect(all[0]?.name.endsWith('-newer.txt')).toBe(true)

    const filtered = await ctx.artifacts.search({ owner: { sessionId: SessionId('sess-1') }, name: 'newer' })
    expect(filtered.map(match => match.locator)).toEqual([newer.locator])

    const limited = await ctx.artifacts.search({ owner: { sessionId: SessionId('sess-1') }, limit: 1 })
    expect(limited).toHaveLength(1)
  })

  it('returns nothing for an unknown name and for a session with no artifacts', async () => {
    const ctx = await mount()
    await save(ctx, 'web_fetch.txt', 'body')
    expect(await ctx.artifacts.search({ owner: { sessionId: SessionId('sess-1') }, name: 'absent' })).toEqual([])
    expect(await ctx.artifacts.search({ owner: { sessionId: SessionId('other-session') } })).toEqual([])
  })
})

describe('read', () => {
  it('returns the stored text with its sizes, and one line window on request', async () => {
    const ctx = await mount()
    const ref = await save(ctx, 'build.log', 'alpha\nbeta\ngamma\ndelta')

    const whole = await ctx.artifacts.read({ locator: ref.locator })
    expect(whole).toEqual({
      text: 'alpha\nbeta\ngamma\ndelta', bytes: 22, lines: 4, totalBytes: 22, totalLines: 4, truncated: false,
    })

    const window = await ctx.artifacts.read({ locator: ref.locator, offset: 2, limit: 2 })
    expect(window).toEqual({
      text: 'beta\ngamma', bytes: 10, lines: 2, totalBytes: 22, totalLines: 4, truncated: true,
    })

    const past = await ctx.artifacts.read({ locator: ref.locator, offset: 99 })
    expect(past.text).toBe('')
    expect(past.truncated).toBe(true)
  })

  it('refuses a foreign locator, an unknown name, a directory, and a linked entry', async () => {
    const ctx = await mount()
    await save(ctx, 'web_fetch.txt', 'body')
    const session = sessionDir(root, 'sess-1')
    const foreign = join(root, '..', 'foreign.txt')
    writeFileSync(foreign, 'secret')
    onTestFinished(() => { rmSync(foreign, { force: true }) })
    // A junction on Windows, a directory symlink elsewhere: both are links, and
    // `lstat` reports neither as the regular file a stored artifact always is.
    const linked = join(session, 'linked.txt')
    symlinkSync(root, linked, 'junction')
    const traversal = join(session, '..', '..', 'escape.txt')

    for (const locator of [foreign, join(session, 'missing.txt'), session, root, linked, traversal]) {
      await expect(ctx.artifacts.read({ locator: SpillLocator(locator) })).rejects.toThrow(ArtifactLocatorError)
    }
  })

  it('leaves the stored artifact byte-identical', async () => {
    const ctx = await mount()
    const body = 'HEAD'.repeat(50) + 'TAIL'.repeat(50)
    const ref = await save(ctx, 'web_fetch.txt', body)

    await ctx.artifacts.read({ locator: ref.locator })
    await ctx.artifacts.extract({ locator: ref.locator, pattern: 'HEAD' })
    await ctx.artifacts.summarize({ locator: ref.locator, maxBytes: 16 })

    expect(await readFile(String(ref.locator), 'utf8')).toBe(body)
  })
})

describe('extract', () => {
  it('projects the matching lines with 1-based numbers and counts every match', async () => {
    const ctx = await mount()
    const ref = await save(ctx, 'build.log', 'alpha\nERROR beta\ngamma\nERROR delta')

    const all = await ctx.artifacts.extract({ locator: ref.locator, pattern: '^ERROR' })
    expect(all.matches).toEqual([{ line: 2, text: 'ERROR beta' }, { line: 4, text: 'ERROR delta' }])
    expect(all.totalMatches).toBe(2)
    expect(all.truncated).toBe(false)

    const limited = await ctx.artifacts.extract({ locator: ref.locator, pattern: '^ERROR', limit: 1 })
    expect(limited.matches).toEqual([{ line: 2, text: 'ERROR beta' }])
    expect(limited.totalMatches).toBe(2)
    expect(limited.truncated).toBe(true)
  })

  it('projects nothing when no line matches', async () => {
    const ctx = await mount()
    const ref = await save(ctx, 'build.log', 'alpha\nbeta')
    expect(await ctx.artifacts.extract({ locator: ref.locator, pattern: '^ERROR' }))
      .toEqual({ matches: [], totalMatches: 0, truncated: false })
  })
})

describe('diff', () => {
  it('compares two artifacts into a unified patch with line counts', async () => {
    const ctx = await mount()
    const before = await save(ctx, 'before.txt', 'one\ntwo\nthree\n')
    const after = await save(ctx, 'after.txt', 'one\nTWO\nthree\nfour\n')

    const diff = await ctx.artifacts.diff({ left: before.locator, right: after.locator })
    expect(diff.patch.split('\n')[0]).toBe('@@ -1,3 +1,4 @@')
    expect(diff.patch).toContain('-two')
    expect(diff.patch).toContain('+TWO')
    expect(diff.patch).toContain('+four')
    expect(diff.added).toBe(2)
    expect(diff.deleted).toBe(1)
  })

  it('reports an empty patch for identical artifacts', async () => {
    const ctx = await mount()
    const left = await save(ctx, 'left.txt', 'same\ntext')
    const right = await save(ctx, 'right.txt', 'same\ntext')
    expect(await ctx.artifacts.diff({ left: left.locator, right: right.locator }))
      .toEqual({ patch: '', added: 0, deleted: 0 })
  })
})

describe('summarize', () => {
  it('retains the head and tail within the byte budget and reports the omitted middle', async () => {
    const ctx = await mount()
    const body = 'A'.repeat(50) + 'M'.repeat(900) + 'Z'.repeat(50)
    const ref = await save(ctx, 'web_fetch.txt', body)

    const summary = await ctx.artifacts.summarize({ locator: ref.locator, maxBytes: 100 })
    expect(summary.text).toBe('A'.repeat(50) + 'Z'.repeat(50))
    expect(summary.bytes).toBe(100)
    expect(summary.totalBytes).toBe(1000)
    expect(summary.omittedBytes).toBe(900)
    expect(summary.truncated).toBe(true)
  })

  it('returns an artifact that already fits whole', async () => {
    const ctx = await mount()
    const ref = await save(ctx, 'small.txt', 'short')
    expect(await ctx.artifacts.summarize({ locator: ref.locator, maxBytes: 100 }))
      .toEqual({ text: 'short', bytes: 5, totalBytes: 5, omittedBytes: 0, truncated: false })
  })
})
