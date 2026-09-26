/**
 * Concurrency key unit tests: one key per file across spellings, one key per
 * case on Windows, and distinct keys for distinct files.
 */

import { describe, expect, it } from 'vitest'
import { fileScopeKey } from '../src/scope-key.ts'

describe('fileScopeKey', () => {
  it.each(['linux', 'win32'] as const)('gives one key to two spellings of one file on %s', (platform) => {
    expect(fileScopeKey('./a/b.ts', platform)).toBe(fileScopeKey('a/b.ts', platform))
    expect(fileScopeKey('a/./b.ts', platform)).toBe(fileScopeKey('a/b.ts', platform))
    expect(fileScopeKey('a/x/../b.ts', platform)).toBe(fileScopeKey('a/b.ts', platform))
  })

  it('folds case on Windows only, so A/B.TS and a/b.ts share one key', () => {
    expect(fileScopeKey('A/B.TS', 'win32')).toBe(fileScopeKey('a/b.ts', 'win32'))
    expect(fileScopeKey('A/B.TS', 'linux')).not.toBe(fileScopeKey('a/b.ts', 'linux'))
  })

  it('keeps distinct files on distinct keys', () => {
    expect(fileScopeKey('a/b.ts', 'win32')).not.toBe(fileScopeKey('a/c.ts', 'win32'))
  })
})
