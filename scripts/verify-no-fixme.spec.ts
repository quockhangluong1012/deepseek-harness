/**
 * Unit coverage for the release FIXME gate.
 * @module scripts/verify-no-fixme.spec
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectNoFixmeViolations } from './verify-no-fixme.ts'

function write(root: string, file: string, source: string): void {
  const path = join(root, file)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, source)
}

describe('verify-no-fixme', () => {
  it('passes on a tree without markers', () => {
    const root = mkdtempSync(join(tmpdir(), 'no-fixme-'))
    write(root, 'packages/guard/timeout-policy/src/index.ts', 'export const x = 1\n')
    expect(collectNoFixmeViolations(root)).toEqual([])
  })

  it('names the file and line of a FIXME marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'no-fixme-'))
    write(root, 'packages/guard/timeout-policy/src/index.ts', 'export const x = 1\n// FIXME: rename\n')
    const violations = collectNoFixmeViolations(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('packages/guard/timeout-policy/src/index.ts:2')
  })

  it('ignores spec fixtures that mention FIXME as test data', () => {
    const root = mkdtempSync(join(tmpdir(), 'no-fixme-'))
    write(root, 'scripts/translation-prompt.spec.ts', 'const label = "FIXME"\n')
    expect(collectNoFixmeViolations(root)).toEqual([])
  })
})
