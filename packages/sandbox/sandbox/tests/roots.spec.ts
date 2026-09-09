/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, resolveWorkdir, writableRoots } from '@deepseek-ai/dsh-sandbox'

/** Every temp root created by this file, removed after each test. */
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('canonicalPath', () => {
  it('resolves symlinks (an existing path realpaths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
    roots.push(dir)
    expect(canonicalPath(dir)).toBe(realpathSync.native(dir))
  })

  it('returns the spelling as-is when the path cannot be resolved (conservative — matches nothing until it exists)', () => {
    expect(canonicalPath('/does/not/exist/anywhere-xyz')).toBe('/does/not/exist/anywhere-xyz')
  })
})

describe('writableRoots', () => {
  it('read-only grants nothing', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: process.cwd() })).toEqual([])
  })

  it('workspace-write grants the workspace root plus the platform temp areas, canonical and deduplicated', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    const writable = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(writable).toContain(realpathSync.native(ws))
    expect(writable).toContain(canonicalPath('/tmp'))
    expect(writable).toContain(realpathSync.native(tmpdir()))
    // Deduplicated after canonicalization (/tmp and os.tmpdir() may coincide).
    expect(new Set(writable).size).toBe(writable.length)
  })

  it.each(['\\\\server\\share', '\\\\?\\C:\\workspace', '//server/share'])('rejects UNC workspace root %s', (workspaceRoot) => {
    expect(() => writableRoots({ mode: 'workspace-write', workspaceRoot })).toThrow('UNC workspace roots are not supported')
  })
})

describe('resolveWorkdir', () => {
  it('returns undefined when neither an explicit workdir nor a session identity exists', () => {
    expect(resolveWorkdir(undefined, undefined)).toBeUndefined()
  })

  it('uses the filesystem identity of the session cwd otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wd-'))
    roots.push(dir)
    expect(resolveWorkdir(undefined, dir)).toBe(realpathSync.native(dir))
  })

  it('prefers a resolved sandbox-policy root over the session cwd', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-wd-'))
    roots.push(ws)
    // The policy root wins verbatim: it already carries the enforcement
    // layer's identity, so no second canonicalization applies.
    expect(resolveWorkdir(undefined, '/elsewhere', ws)).toBe(ws)
  })

  it('resolves a relative model path against the session workspace', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-wd-'))
    roots.push(ws)
    expect(resolveWorkdir('sub/dir', undefined, ws)).toBe(join(ws, 'sub/dir'))
  })

  it('passes an absolute model path through unchanged', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-wd-'))
    roots.push(ws)
    expect(resolveWorkdir(ws, undefined, '/elsewhere')).toBe(ws)
  })
})
