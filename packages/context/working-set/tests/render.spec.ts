/** The working-set text: role blocks, the byte bound, and the prefix property. */
import { describe, expect, it } from 'vitest'
import { renderWorkingSet } from '../src/render.ts'
import type { WorkingSet } from '../src/types.ts'

const SET: WorkingSet = {
  primary: ['packages/repo/repo-index/src/walk.ts'],
  dependencies: ['packages/repo/repo-index/src/types.ts'],
  tests: ['packages/repo/repo-index/tests/walk.spec.ts'],
  configs: ['package.json'],
  docs: [],
}

describe('renderWorkingSet', () => {
  it('renders the header and one labelled block per non-empty role, in role order', () => {
    expect(renderWorkingSet(SET, 4096)).toBe([
      'Working set (4 files the current task is expected to touch, ranked against its objective):',
      'primary (1):',
      '- packages/repo/repo-index/src/walk.ts',
      'dependencies (1):',
      '- packages/repo/repo-index/src/types.ts',
      'tests (1):',
      '- packages/repo/repo-index/tests/walk.spec.ts',
      'configs (1):',
      '- package.json',
    ].join('\n'))
  })

  it('keeps whole lines only, so a bounded set is a prefix of the complete one', () => {
    const complete = renderWorkingSet(SET, 4096)
    const [header, firstBlock, firstFile] = complete.split('\n') as [string, string, string]
    const headerBytes = Buffer.byteLength(header, 'utf8')
    const firstBlockBytes = headerBytes + 1 + Buffer.byteLength(firstBlock, 'utf8')
    expect(renderWorkingSet(SET, firstBlockBytes)).toBe(`${header}\n${firstBlock}`)
    expect(renderWorkingSet(SET, firstBlockBytes + 1 + Buffer.byteLength(firstFile, 'utf8'))).toBe(`${header}\n${firstBlock}\n${firstFile}`)
  })

  it('renders nothing for an empty selection', () => {
    const empty: WorkingSet = { primary: [], dependencies: [], tests: [], configs: [], docs: [] }
    expect(renderWorkingSet(empty, 4096)).toBe('')
  })

  it('renders the header alone when only it fits, and nothing when even it does not', () => {
    const header = 'Working set (1 file the current task is expected to touch, ranked against its objective):'
    const one: WorkingSet = { primary: ['auth.ts'], dependencies: [], tests: [], configs: [], docs: [] }
    expect(renderWorkingSet(one, Buffer.byteLength(header, 'utf8'))).toBe(header)
    expect(renderWorkingSet(one, Buffer.byteLength(header, 'utf8') - 1)).toBe('')
  })
})
