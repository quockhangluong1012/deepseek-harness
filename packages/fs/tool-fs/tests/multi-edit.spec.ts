/**
 * Batch-edit tests: argument validation, in-memory all-or-none application, and
 * the tool over a recording provider under the real observation policy — the
 * read-before-mutation guard, the stale guard, and CRLF preservation. The
 * provider records every accepted write, so "applied nothing" is asserted on
 * what the tool published, not on a rendered message.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { applyEdits, formatMultiEditOutput, parseMultiEditArgs } from '../src/multi-edit.ts'
import { FakeFs } from './fake-fs.ts'

const testToolSignal = new AbortController().signal

let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
/** One session identity: the observation policy keys its observed state by it. */
const session = { header: {} }

let callCounter = 0
function call(name: string, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: { session } as never,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

const fs = (): FakeFs => ctx.fs as FakeFs

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeFs)
  await ctx.plugin(FsPolicy)
  fiber = await ctx.plugin(ToolFs)
})

afterEach(async () => {
  await fiber.dispose()
})

describe('parseMultiEditArgs', () => {
  it('defaults replace_all and passes an explicit value through', () => {
    const parsed = parseMultiEditArgs({
      file_path: 'a.txt',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd', replace_all: true },
      ],
    })
    expect(parsed.filePath).toBe('a.txt')
    expect(parsed.edits).toEqual([
      { filePath: 'a.txt', oldString: 'a', newString: 'b', replaceAll: false },
      { filePath: 'a.txt', oldString: 'c', newString: 'd', replaceAll: true },
    ])
  })

  it('rejects a blank path and an empty edit list', () => {
    expect(() => parseMultiEditArgs({ file_path: '  ', edits: [{ old_string: 'a', new_string: 'b' }] }))
      .toThrow('file_path must be a non-empty string')
    expect(() => parseMultiEditArgs({ file_path: 'a.txt', edits: [] }))
      .toThrow('edits must contain at least one edit')
  })

  it('names the offending entry by position', () => {
    expect(() => parseMultiEditArgs({
      file_path: 'a.txt',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: '', new_string: 'd' },
      ],
    })).toThrow('edits[1]: old_string must be a non-empty string')
    expect(() => parseMultiEditArgs({ file_path: 'a.txt', edits: [{ old_string: 'same', new_string: 'same' }] }))
      .toThrow('edits[0]: old_string and new_string must differ')
  })
})

describe('applyEdits', () => {
  it('applies the edits in order, each seeing the previous result', () => {
    expect(applyEdits('one two', [
      { filePath: 'p', oldString: 'one', newString: 'two', replaceAll: false },
      { filePath: 'p', oldString: 'two two', newString: 'done', replaceAll: false },
    ], 'p')).toBe('done')
  })

  it('reports a missing or ambiguous match with its entry position', () => {
    expect(() => applyEdits('one', [
      { filePath: 'p', oldString: 'one', newString: '1', replaceAll: false },
      { filePath: 'p', oldString: 'absent', newString: 'x', replaceAll: false },
    ], 'p')).toThrow('edits[1]: old_string was not found in "p"')
    expect(() => applyEdits('x x', [{ filePath: 'p', oldString: 'x', newString: 'y', replaceAll: false }], 'p'))
      .toThrow('edits[0]: old_string matched 2 times in "p"; provide a more specific old_string or set replace_all to true')
  })

  it('replaces every match of a replace_all entry and refuses an empty search', () => {
    expect(applyEdits('x x', [{ filePath: 'p', oldString: 'x', newString: 'y', replaceAll: true }], 'p')).toBe('y y')
    expect(() => applyEdits('x', [{ filePath: 'p', oldString: '', newString: 'y', replaceAll: true }], 'p'))
      .toThrow('edits[0]: old_string was not found in "p"')
  })
})

describe('formatMultiEditOutput', () => {
  it('counts the applied edits', () => {
    expect(formatMultiEditOutput('/abs/a.txt', 1)).toBe('The file /abs/a.txt has been updated successfully with 1 edit.')
    expect(formatMultiEditOutput('/abs/a.txt', 3)).toBe('The file /abs/a.txt has been updated successfully with 3 edits.')
  })
})

describe('multi_edit tool', () => {
  it('publishes one write carrying every edit', async () => {
    fs().seed('a.txt', 'alpha\nbeta\ngamma\n')
    expect((await call('read', { file_path: 'a.txt' })).isError).toBe(false)
    const result = await call('multi_edit', {
      file_path: 'a.txt',
      edits: [
        { old_string: 'alpha', new_string: 'ALPHA' },
        { old_string: 'gamma', new_string: 'GAMMA' },
      ],
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('The file /abs/a.txt has been updated successfully with 2 edits.')
    expect(fs().writes).toEqual([{
      targetKey: 'key:a.txt',
      content: 'ALPHA\nbeta\nGAMMA\n',
      intent: { kind: 'replaceIfVersion', version: 'v1' },
    }])
    expect(result.value).toEqual({ path: '/abs/a.txt', before: 'alpha\nbeta\ngamma\n', after: 'ALPHA\nbeta\nGAMMA\n' })
  })

  it('attaches the applied hunks as result metadata', async () => {
    fs().seed('a.txt', 'alpha\n')
    await call('read', { file_path: 'a.txt' })
    const result = await call('multi_edit', { file_path: 'a.txt', edits: [{ old_string: 'alpha', new_string: 'ALPHA' }] })
    expect(result.meta).toEqual({ diffs: [{ path: 'a.txt', oldText: 'alpha', newText: 'ALPHA' }] })
  })

  it('applies nothing when a later edit does not resolve', async () => {
    fs().seed('a.txt', 'alpha\nbeta\n')
    await call('read', { file_path: 'a.txt' })
    const result = await call('multi_edit', {
      file_path: 'a.txt',
      edits: [
        { old_string: 'alpha', new_string: 'ALPHA' },
        { old_string: 'absent', new_string: 'x' },
      ],
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: edits[1]: old_string was not found in "/abs/a.txt"')
    expect(result.error).toMatchObject({ info: { code: 'FS_EDIT_NOT_FOUND' } })
    // The first edit resolved in memory only: the tool published no write.
    expect(fs().writes).toEqual([])
    expect(fs().contentOf('a.txt')).toBe('alpha\nbeta\n')
  })

  it('requires a prior read of the target', async () => {
    fs().seed('a.txt', 'alpha\n')
    const result = await call('multi_edit', { file_path: 'a.txt', edits: [{ old_string: 'alpha', new_string: 'x' }] })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { code: 'FS_NOT_OBSERVED' } })
    expect(text(result)).toBe('Error: cannot modify "/abs/a.txt": file has not been read — read the file, then retry')
    expect(fs().writes).toEqual([])
  })

  it('rejects a batch resolved against a stale observation', async () => {
    fs().seed('a.txt', 'alpha\n')
    await call('read', { file_path: 'a.txt' })
    fs().seed('a.txt', 'changed externally\n')
    const result = await call('multi_edit', { file_path: 'a.txt', edits: [{ old_string: 'changed', new_string: 'x' }] })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { code: 'FS_STALE_VERSION' } })
    expect(text(result)).toContain('re-read the file, then retry')
    expect(fs().writes).toEqual([])
    expect(fs().contentOf('a.txt')).toBe('changed externally\n')
  })

  it('rejects an empty edit list before touching the file', async () => {
    fs().seed('a.txt', 'alpha\n')
    const result = await call('multi_edit', { file_path: 'a.txt', edits: [] })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: edits must contain at least one edit')
    expect(fs().writes).toEqual([])
  })

  it('keeps a CRLF file CRLF', async () => {
    fs().seed('a.txt', 'alpha\r\nbeta\r\n')
    await call('read', { file_path: 'a.txt' })
    const result = await call('multi_edit', { file_path: 'a.txt', edits: [{ old_string: 'alpha', new_string: 'ALPHA' }] })
    expect(result.isError).toBe(false)
    expect(fs().contentOf('a.txt')).toBe('ALPHA\r\nbeta\r\n')
    // The reported diff basis is LF-normalized, as `edit` reports it.
    expect(result.value).toMatchObject({ before: 'alpha\nbeta\n', after: 'ALPHA\nbeta\n' })
  })

  it('serializes against a concurrent edit of the same file: one wins, the other fails closed', async () => {
    fs().seed('a.txt', 'aa cc\n')
    await call('read', { file_path: 'a.txt' })
    const results = await Promise.all([
      call('multi_edit', { file_path: 'a.txt', edits: [{ old_string: 'aa', new_string: 'bb' }] }),
      call('edit', { file_path: 'a.txt', old_string: 'cc', new_string: 'dd' }),
    ])
    // Same file, one observed version: exactly one mutation lands and the other
    // is refused as stale, so the file is never a mix of two batches.
    expect(results.filter(result => !result.isError)).toHaveLength(1)
    const [loser] = results.filter(result => result.isError)
    expect(loser?.error).toMatchObject({ info: { code: 'FS_STALE_VERSION' } })
    expect(['bb cc\n', 'aa dd\n']).toContain(fs().contentOf('a.txt'))
  })

  it('describes the batch call as a diff card and the applied result from metadata', async () => {
    fs().seed('a.txt', 'alpha\n')
    await call('read', { file_path: 'a.txt' })
    const result = await call('multi_edit', { file_path: 'a.txt', edits: [{ old_string: 'alpha', new_string: 'x' }] })
    const definition = ctx.tools.get('multi_edit')
    expect(definition?.presentCall?.({ file_path: 'a.txt', edits: [{ old_string: 'alpha', new_string: 'x' }] })).toEqual({
      card: 'diff',
      title: 'Edit a.txt',
      diffs: [{ path: 'a.txt', oldText: 'alpha', newText: 'x' }],
      locations: [{ path: 'a.txt' }],
    })
    expect(definition?.presentResult?.({ file_path: 'a.txt', edits: [] }, result)).toMatchObject({ card: 'diff' })
    // Malformed persisted metadata falls back to the generic result rendering.
    expect(definition?.presentResult?.({ file_path: 'a.txt', edits: [] }, { content: [], isError: false, meta: { diffs: 'no' } }))
      .toBeUndefined()
    expect(definition?.presentResult?.({ file_path: 'a.txt', edits: [] }, { content: [], isError: true })).toBeUndefined()
  })

  it('publishes guidance only while the tool is visible', async () => {
    const sections = (await ctx.systemPrompt.assemble()).sections
    expect(sections.map(section => section.name)).toContain('tool:multi_edit')
  })
})
