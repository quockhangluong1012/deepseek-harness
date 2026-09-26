import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeMatcherGroups, readHookConfigLayers } from '@deepseek-ai/dsh-hook-protocol'
import type { MatcherGroup } from '@deepseek-ai/dsh-hook-protocol'

const dirs: string[] = []
function dir(): string { const d = mkdtempSync(join(tmpdir(), 'dsh-hook-layers-')); dirs.push(d); return d }
function file(d: string, name: string, text: string): string {
  const path = join(d, name)
  writeFileSync(path, text)
  return path
}
function cleanup(): void { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) }

describe('readHookConfigLayers — precedence, absence, and diagnostics', () => {
  it('reads the layers it was given, in precedence order', () => {
    const d = dir()
    try {
      const first = file(d, 'first.json', '{"a":1}')
      const second = file(d, 'second.json', '{"b":2}')
      const diagnostics: string[] = []
      const layers = readHookConfigLayers([first, second], (message) => { diagnostics.push(message) })
      expect(layers).toEqual([{ path: first, raw: { a: 1 } }, { path: second, raw: { b: 2 } }])
      expect(diagnostics).toEqual([])
    } finally { cleanup() }
  })

  it('skips an absent layer silently — an unconfigured layer is normal', () => {
    const d = dir()
    try {
      const present = file(d, 'present.json', '{}')
      const missing = join(d, 'nope.json')
      const diagnostics: string[] = []
      const layers = readHookConfigLayers([missing, present], (message) => { diagnostics.push(message) })
      expect(layers.map(layer => layer.path)).toEqual([present])
      expect(diagnostics).toEqual([])
    } finally { cleanup() }
  })

  it('skips a malformed layer with a diagnostic naming it, keeping the others', () => {
    const d = dir()
    try {
      const broken = file(d, 'broken.json', '{ not json')
      const present = file(d, 'present.json', '{"hooks":{}}')
      const diagnostics: string[] = []
      const layers = readHookConfigLayers([broken, present], (message) => { diagnostics.push(message) })
      expect(layers.map(layer => layer.path)).toEqual([present])
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toContain('could not parse hook config')
      expect(diagnostics[0]).toContain('broken.json')
    } finally { cleanup() }
  })

  it('skips an unreadable layer with a diagnostic (a directory is not a config file)', () => {
    const d = dir()
    try {
      const asDirectory = join(d, 'hooks.json')
      mkdirSync(asDirectory)
      const diagnostics: string[] = []
      const layers = readHookConfigLayers([asDirectory], (message) => { diagnostics.push(message) })
      expect(layers).toEqual([])
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toContain('could not read hook config')
    } finally { cleanup() }
  })

  it('reads a layer appearing twice once, at its highest-precedence position', () => {
    const d = dir()
    try {
      const shared = file(d, 'shared.json', '{"hooks":{}}')
      const other = file(d, 'other.json', '{}')
      const layers = readHookConfigLayers([shared, other, shared], () => { /* no diagnostics expected */ })
      // The duplicate moves to the end (highest precedence) and is read once.
      expect(layers.map(layer => layer.path)).toEqual([other, shared])
    } finally { cleanup() }
  })

  it('compares paths after resolution, so equivalent spellings deduplicate', () => {
    const d = dir()
    try {
      const shared = file(d, 'shared.json', '{"hooks":{}}')
      const layers = readHookConfigLayers([shared, join(d, '.', 'shared.json')], () => { /* none */ })
      expect(layers).toHaveLength(1)
      // The surviving entry is the last spelling given.
      expect(layers[0]!.path).toBe(join(d, '.', 'shared.json'))
    } finally { cleanup() }
  })

  it('reports a permission failure rather than treating it as absent', () => {
    const d = dir()
    try {
      const locked = file(d, 'locked.json', '{}')
      // A read-protected file is present but unusable; chmod is a no-op on
      // Windows, so this case only asserts the POSIX behavior where it applies.
      chmodSync(locked, 0o000)
      const diagnostics: string[] = []
      const layers = readHookConfigLayers([locked], (message) => { diagnostics.push(message) })
      if (diagnostics.length > 0) {
        expect(layers).toEqual([])
        expect(diagnostics[0]).toContain('could not read hook config')
      } else {
        expect(layers.map(layer => layer.path)).toEqual([locked])
      }
    } finally { cleanup() }
  })
})

describe('mergeMatcherGroups — deterministic concatenation', () => {
  const group = (matcher: string): MatcherGroup => ({ matcher, hooks: [{ command: matcher }] })

  it('appends later layers after earlier ones per event', () => {
    const merged = mergeMatcherGroups([
      { PreToolUse: [group('user')] },
      { PreToolUse: [group('project')], Stop: [group('stop')] },
      { PreToolUse: [group('dsh')] },
    ])
    expect(merged.PreToolUse?.map(g => g.matcher)).toEqual(['user', 'project', 'dsh'])
    expect(merged.Stop?.map(g => g.matcher)).toEqual(['stop'])
  })

  it('returns an empty map when no layer configured hooks', () => {
    expect(mergeMatcherGroups([{}, {}])).toEqual({})
    expect(mergeMatcherGroups([])).toEqual({})
  })
})
