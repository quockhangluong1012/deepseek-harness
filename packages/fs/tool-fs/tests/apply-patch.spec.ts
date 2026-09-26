/**
 * V4A patch tests: the strict parser's line-numbered failures, in-memory hunk
 * application, and the tool over a recording provider under the real observation
 * policy — validate-before-write, the guards, and the configured size cap.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { applyPatchHunks, formatApplyPatchOutput, parseApplyPatch, patchCallDiffs, patchSinglePath } from '../src/apply-patch.ts'
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

async function mount(config?: ToolFs.Config): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeFs)
  await ctx.plugin(FsPolicy)
  fiber = config === undefined ? await ctx.plugin(ToolFs) : await ctx.plugin(ToolFs, config)
}

beforeEach(async () => {
  await mount()
})

afterEach(async () => {
  await fiber.dispose()
})

describe('parseApplyPatch', () => {
  it('parses add, update, and delete sections in order, skipping blank lines', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: new.txt',
      '+one',
      '+',
      '+two',
      '',
      '*** Update File: old.txt',
      '@@ keep in store',
      ' context',
      '-removed',
      '+added',
      '*** Delete File: gone.txt',
      '*** End Patch',
    ].join('\n')
    expect(parseApplyPatch(patch)).toEqual([
      { kind: 'add', line: 2, path: 'new.txt', content: 'one\n\ntwo\n' },
      {
        kind: 'update',
        line: 7,
        path: 'old.txt',
        hunks: [{ line: 8, anchor: 'keep in store', oldText: 'context\nremoved', newText: 'context\nadded' }],
      },
      { kind: 'delete', line: 12, path: 'gone.txt' },
    ])
  })

  it('accepts a hunk without a locator and several hunks in one section', () => {
    const patch = ['*** Begin Patch', '*** Update File: a.txt', '-one', '+ONE', '@@', ' context', '-two', '+TWO', '*** End Patch'].join('\n')
    expect(parseApplyPatch(patch)).toEqual([
      {
        kind: 'update',
        line: 2,
        path: 'a.txt',
        hunks: [
          { line: 3, oldText: 'one', newText: 'ONE' },
          { line: 5, oldText: 'context\ntwo', newText: 'context\nTWO' },
        ],
      },
    ])
  })

  it('accepts a CRLF patch', () => {
    expect(parseApplyPatch('*** Begin Patch\r\n*** Add File: a.txt\r\n+x\r\n*** End Patch'))
      .toEqual([{ kind: 'add', line: 2, path: 'a.txt', content: 'x\n' }])
  })

  it('rejects an empty or unopened patch', () => {
    expect(() => parseApplyPatch('\n\n')).toThrow('the patch is empty')
    expect(() => parseApplyPatch('*** Add File: a.txt\n+x\n*** End Patch'))
      .toThrow('line 1: a patch must start with "*** Begin Patch"')
  })

  it('rejects a missing or unconsumed end marker', () => {
    expect(() => parseApplyPatch('*** Begin Patch\n*** Add File: a.txt\n+x'))
      .toThrow('a patch must end with "*** End Patch"')
    expect(() => parseApplyPatch('*** Begin Patch\n*** End Patch\nleftover'))
      .toThrow('line 3: content after "*** End Patch"')
  })

  it('rejects an unknown directive, loose content, and a pathless header', () => {
    expect(() => parseApplyPatch('*** Begin Patch\n*** Move to: b.txt\n*** End Patch'))
      .toThrow('line 2: unknown patch directive "*** Move to: b.txt"')
    expect(() => parseApplyPatch('*** Begin Patch\nhello\n*** End Patch'))
      .toThrow('line 2: "hello" appears outside a file section')
    expect(() => parseApplyPatch('*** Begin Patch\n*** Add File:\n+x\n*** End Patch'))
      .toThrow('line 2: "*** Add File:" needs a path')
  })

  it('rejects a path repeated across sections', () => {
    expect(() => parseApplyPatch('*** Begin Patch\n*** Add File: a.txt\n+x\n*** Add File: a.txt\n+y\n*** End Patch'))
      .toThrow('line 4: "a.txt" appears in more than one section')
  })

  it('rejects an Add File section that is empty or holds a stray line', () => {
    expect(() => parseApplyPatch('*** Begin Patch\n*** Add File: a.txt\n*** End Patch'))
      .toThrow('line 2: "*** Add File: a.txt" has no "+" content lines')
    expect(() => parseApplyPatch('*** Begin Patch\n*** Add File: a.txt\nx\n*** End Patch'))
      .toThrow('line 3: an Add File content line must start with "+"')
  })

  it('rejects an Update File section with no hunk, an unlocatable hunk, and a stray line', () => {
    expect(() => parseApplyPatch('*** Begin Patch\n*** Update File: a.txt\n*** End Patch'))
      .toThrow('line 2: "*** Update File: a.txt" has no hunks')
    expect(() => parseApplyPatch('*** Begin Patch\n*** Update File: a.txt\n@@\n+x\n*** End Patch'))
      .toThrow('line 3: the hunk in "a.txt" has no context or removed line to locate it')
    expect(() => parseApplyPatch('*** Begin Patch\n*** Update File: a.txt\n@@\n?bad\n*** End Patch'))
      .toThrow('line 4: an Update File line must start with " ", "+", "-", or "@@"')
  })

  it('rejects content inside a Delete File section', () => {
    expect(() => parseApplyPatch('*** Begin Patch\n*** Delete File: gone.txt\n+x\n*** End Patch'))
      .toThrow('line 3: "*** Delete File: gone.txt" takes no content lines')
  })
})

describe('applyPatchHunks', () => {
  it('applies a locator-free hunk in the whole text', () => {
    expect(applyPatchHunks('a\nb\nc', [{ line: 1, oldText: 'b', newText: 'B' }], 'p')).toBe('a\nB\nc')
  })

  it('reports a hunk that is missing or ambiguous', () => {
    expect(() => applyPatchHunks('a\nb', [{ line: 4, oldText: 'zz', newText: 'Z' }], 'p'))
      .toThrow('line 4: the hunk\'s context and removed lines were not found in "p"')
    expect(() => applyPatchHunks('x\nx', [{ line: 4, oldText: 'x', newText: 'y' }], 'p'))
      .toThrow('line 4: the hunk\'s context and removed lines match 2 places in "p"; add surrounding context lines')
  })

  it('positions a hunk with its locator, even when the block repeats earlier in the file', () => {
    const text = 'def foo():\n    return 1\n\ndef bar():\n    return 1\n'
    expect(applyPatchHunks(text, [{ line: 6, anchor: 'def bar():', oldText: '    return 1', newText: '    return 2' }], 'p'))
      .toBe('def foo():\n    return 1\n\ndef bar():\n    return 2\n')
  })

  it('reports a locator that is absent, repeated, or too loose for the block', () => {
    expect(() => applyPatchHunks('x\n', [{ line: 6, anchor: 'nope', oldText: 'x', newText: 'y' }], 'p'))
      .toThrow('line 6: "@@ nope" was not found in "p"')
    expect(() => applyPatchHunks('def a\n def b\n', [{ line: 6, anchor: 'def', oldText: 'x', newText: 'y' }], 'p'))
      .toThrow('line 6: "@@ def" matches 2 lines in "p"; use a longer locator')
    expect(() => applyPatchHunks('def a:\n return 1\n return 1\n', [{ line: 6, anchor: 'def a:', oldText: 'return 1', newText: 'return 2' }], 'p'))
      .toThrow('line 6: the hunk\'s context and removed lines match 2 places in "p"; add surrounding context lines')
  })
})

describe('patch presentation helpers', () => {
  it('derives call diffs per section and skips delete-only patches', () => {
    const patch = '*** Begin Patch\n*** Add File: new.txt\n+created\n*** Update File: old.txt\n@@\n-old\n+new\n*** End Patch'
    expect(patchCallDiffs(patch)).toEqual([
      { path: 'new.txt', oldText: null, newText: 'created\n' },
      { path: 'old.txt', oldText: 'old', newText: 'new' },
    ])
    expect(patchCallDiffs('*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch')).toBeUndefined()
    expect(patchCallDiffs('not a patch')).toBeUndefined()
  })

  it('reports the single path a patch changes', () => {
    expect(patchSinglePath('*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** End Patch')).toBe('a.txt')
    expect(patchSinglePath('*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** Update File: b.txt\n@@\n-x\n+y\n*** End Patch')).toBeUndefined()
    expect(patchSinglePath('*** Begin Patch\n*** End Patch')).toBeUndefined()
    expect(() => patchSinglePath('not a patch')).toThrow('line 1: a patch must start with "*** Begin Patch"')
  })

  it('summarizes the applied files', () => {
    expect(formatApplyPatchOutput([{ path: '/abs/a.txt', operation: 'create', before: null, after: 'x' }]))
      .toBe('Applied 1 file change.\nCreated /abs/a.txt')
    expect(formatApplyPatchOutput([
      { path: '/abs/a.txt', operation: 'create', before: null, after: 'x' },
      { path: '/abs/b.txt', operation: 'update', before: 'y', after: 'z' },
    ])).toBe('Applied 2 file changes.\nCreated /abs/a.txt\nUpdated /abs/b.txt')
  })
})

describe('apply_patch tool', () => {
  const twoFilePatch = [
    '*** Begin Patch',
    '*** Add File: new.txt',
    '+created',
    '*** Update File: existing.txt',
    '@@',
    ' keep',
    '-old line',
    '+new line',
    '*** End Patch',
  ].join('\n')

  it('publishes a create and a guarded update for one call', async () => {
    fs().seed('existing.txt', 'keep\nold line\n')
    expect((await call('read', { file_path: 'existing.txt' })).isError).toBe(false)
    const result = await call('apply_patch', { patch: twoFilePatch })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Applied 2 file changes.\nCreated /abs/new.txt\nUpdated /abs/existing.txt')
    expect(fs().writes).toEqual([
      { targetKey: 'key:new.txt', content: 'created\n', intent: { kind: 'createIfAbsent' } },
      { targetKey: 'key:existing.txt', content: 'keep\nnew line\n', intent: { kind: 'replaceIfVersion', version: 'v1' } },
    ])
    expect(result.value).toEqual({
      files: [
        { path: '/abs/new.txt', operation: 'create', before: null, after: 'created\n' },
        { path: '/abs/existing.txt', operation: 'update', before: 'keep\nold line\n', after: 'keep\nnew line\n' },
      ],
    })
    // Only the update has a diff basis; the create contributes no applied hunk,
    // and an applied diff carries the resolved display path.
    expect(result.meta).toEqual({ diffs: [{ path: '/abs/existing.txt', oldText: 'keep\nold line', newText: 'keep\nnew line' }] })
  })

  it('fails a malformed patch with its line before resolving any path', async () => {
    const result = await call('apply_patch', { patch: '*** Begin Patch\n*** Add File: new.txt\nstray\n*** End Patch' })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: line 3: an Add File content line must start with "+"')
    expect(fs().writes).toEqual([])
  })

  it('publishes nothing when a later section cannot resolve', async () => {
    fs().seed('first.txt', 'one\n')
    fs().seed('second.txt', 'two\n')
    await call('read', { file_path: 'first.txt' })
    await call('read', { file_path: 'second.txt' })
    const patch = [
      '*** Begin Patch',
      '*** Update File: first.txt',
      '@@',
      '-one',
      '+ONE',
      '*** Update File: second.txt',
      '@@',
      '-absent',
      '+ABSENT',
      '*** End Patch',
    ].join('\n')
    const result = await call('apply_patch', { patch })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: line 7: the hunk\'s context and removed lines were not found in "/abs/second.txt"')
    expect(fs().writes).toEqual([])
    expect(fs().contentOf('first.txt')).toBe('one\n')
  })

  it('refuses Delete File, naming the missing operation', async () => {
    fs().seed('gone.txt', 'still here\n')
    const result = await call('apply_patch', { patch: '*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch' })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: line 2: "*** Delete File: gone.txt" is not supported: the mounted filesystem has no delete operation')
    expect(fs().writes).toEqual([])
    expect(fs().contentOf('gone.txt')).toBe('still here\n')
  })

  it('refuses Add File over an existing file', async () => {
    fs().seed('a.txt', 'existing\n')
    const result = await call('apply_patch', { patch: '*** Begin Patch\n*** Add File: a.txt\n+replacement\n*** End Patch' })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: line 2: "/abs/a.txt" already exists; use "*** Update File:" or delete it first')
    expect(fs().writes).toEqual([])
  })

  it('requires a prior read before updating a file', async () => {
    fs().seed('a.txt', 'one\n')
    const result = await call('apply_patch', { patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+ONE\n*** End Patch' })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: cannot modify "/abs/a.txt": file has not been read — read the file, then retry')
    expect(fs().writes).toEqual([])
  })

  it('describes the call and result as diff cards', async () => {
    fs().seed('existing.txt', 'keep\nold line\n')
    await call('read', { file_path: 'existing.txt' })
    const result = await call('apply_patch', { patch: twoFilePatch })
    const definition = ctx.tools.get('apply_patch')
    expect(definition?.presentCall?.({ patch: twoFilePatch })).toEqual({
      card: 'diff',
      title: 'Apply patch',
      diffs: [
        { path: 'new.txt', oldText: null, newText: 'created\n' },
        { path: 'existing.txt', oldText: 'keep\nold line', newText: 'keep\nnew line' },
      ],
      locations: [{ path: 'new.txt' }, { path: 'existing.txt' }],
    })
    expect(definition?.presentCall?.({ patch: 'not a patch' })).toEqual({ card: 'generic', title: 'Apply patch', rawInput: { patch: 'not a patch' } })
    expect(definition?.presentResult?.({ patch: twoFilePatch }, result)).toMatchObject({ card: 'diff' })
    // A create-only result carries no applied hunk, so the whole argument-derived diff stands.
    expect(definition?.presentResult?.({ patch: twoFilePatch }, { content: [], isError: false, meta: { diffs: [] } }))
      .toEqual({
        card: 'diff',
        title: 'Apply patch',
        diffs: [
          { path: 'new.txt', oldText: null, newText: 'created\n' },
          { path: 'existing.txt', oldText: 'keep\nold line', newText: 'keep\nnew line' },
        ],
      })
    expect(definition?.presentResult?.({ patch: twoFilePatch }, { content: [], isError: true })).toBeUndefined()
  })

  it('publishes guidance only while the tool is visible', async () => {
    const sections = (await ctx.systemPrompt.assemble()).sections
    expect(sections.map(section => section.name)).toContain('tool:apply_patch')
  })
})

describe('apply_patch size cap', () => {
  it('rejects a patch above the configured cap without touching the filesystem', async () => {
    await mount({ applyPatchMaxBytes: 64 })
    const patch = `*** Begin Patch\n*** Add File: a.txt\n+${'x'.repeat(80)}\n*** End Patch`
    const result = await call('apply_patch', { patch })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(`Error: the patch is ${Buffer.byteLength(patch, 'utf8')} bytes, above the configured cap of 64 bytes; split it into smaller patches`)
    expect(fs().writes).toEqual([])
    expect(fs().contentOf('a.txt')).toBeUndefined()
  })

  it('fails load on a non-positive cap', async () => {
    await expect(mount({ applyPatchMaxBytes: 0 })).rejects.toThrow('tool-fs: applyPatchMaxBytes must be a positive integer')
  })
})
