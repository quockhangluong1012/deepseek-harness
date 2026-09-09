/**
 * Parity between `writableRoots()` and the bwrap/Landlock/Seatbelt reductions.
 * Every backend derives its writable set from the shared helper; per-runner
 * differences are explicit reductions, never independent derivations.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('backend writable-set parity', () => {
  it('bwrap binds every non-temp root and mounts an ephemeral /tmp', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-parity-'))
    roots.push(ws)
    const policy = { mode: 'workspace-write' as const, workspaceRoot: ws }
    const args = bwrapProfileArgs(policy)
    expect(args).toContain('--tmpfs')
    expect(args).toContain('/tmp')
    for (const root of writableRoots(policy)) {
      if (root === '/tmp' || root === '/private/tmp') continue
      const index = args.indexOf(root)
      expect(index).toBeGreaterThan(-1)
      expect(args[index - 1]).toBe('--bind')
    }
  })

  it('landlock grants the canonical writable set', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-parity-'))
    roots.push(ws)
    const policy = { mode: 'workspace-write' as const, workspaceRoot: ws }
    const args = landlockProfileArgs(policy)
    const joined = args.join(' ')
    for (const root of writableRoots(policy)) {
      expect(joined).toContain(root)
    }
    expect(joined).toContain('/dev/null')
  })

  it('seatbelt grants the canonical writable set', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-parity-'))
    roots.push(ws)
    const policy = { mode: 'workspace-write' as const, workspaceRoot: ws }
    const args = seatbeltProfileArgs(policy)
    const joined = args.join(' ')
    for (const root of writableRoots(policy)) {
      expect(joined).toContain(root)
    }
  })

  it('read-only grants nothing on every backend', () => {
    const policy = { mode: 'read-only' as const, workspaceRoot: process.cwd() }
    expect(writableRoots(policy)).toEqual([])
    expect(bwrapProfileArgs(policy)).not.toContain('--bind')
    expect(bwrapProfileArgs(policy)).not.toContain('--tmpfs')
    expect(seatbeltProfileArgs(policy).join(' ')).not.toContain('(subpath')
  })

  it('workspace root identity matches the fence canonicalization', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-parity-'))
    roots.push(ws)
    expect(writableRoots({ mode: 'workspace-write', workspaceRoot: ws })).toContain(canonicalPath(ws))
  })
})
