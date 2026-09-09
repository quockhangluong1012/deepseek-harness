/**
 * Unit coverage for the Agent Note reference gate.
 * @module scripts/verify-agent-note-refs.spec
 */
import { describe, expect, it } from 'vitest'
import { collectNoteRefViolations } from './verify-agent-note-refs.ts'
import type { WorkspacePackage } from './verify-agent-note-refs.ts'

const FILE = '.agents/notes/implemented/feature/2026-01-01-example.md'
const PACKAGES = new Map<string, WorkspacePackage>([
  ['@deepseek-ai/dsh-foo', { dir: 'packages/foo/tool-foo', exports: ['invariant'] }],
])
const NAMESPACES = new Set(['check', 'test', 'verify', 'gen'])
const SCRIPTS = new Set(['check:all', 'test:coverage', 'verify-md-links'])

function collect(
  source: string,
  options: {
    allowed?: Record<string, string>
    exists?: (repoPath: string) => boolean
    markUsed?: (ref: string) => void
  } = {},
): ReturnType<typeof collectNoteRefViolations> {
  return collectNoteRefViolations(
    FILE,
    source,
    PACKAGES,
    NAMESPACES,
    SCRIPTS,
    options.allowed ?? {},
    options.exists ?? (() => true),
    options.markUsed,
  )
}

describe('verify-agent-note-refs', () => {
  it('passes when every stated path, package, export, and script exists', () => {
    const violations = collect(
      'See `packages/foo/tool-foo/src/index.ts`, `@deepseek-ai/dsh-foo/invariant`, and `check:all`.',
      { exists: repoPath => repoPath === 'packages/foo/tool-foo/src/index.ts' },
    )
    expect(violations).toEqual([])
  })

  it('flags a path that names no file or directory', () => {
    const violations = collect('See `packages/foo/tool-gone/src/index.ts`.', { exists: () => false })
    expect(violations).toHaveLength(1)
    expect(violations[0]?.reason).toContain('no file or directory')
  })

  it('flags an unknown workspace package', () => {
    expect(collect('See `@deepseek-ai/dsh-gone`.')[0]?.reason).toContain('no workspace package')
  })

  it('flags a package subpath with no export or source', () => {
    const violations = collect('See `@deepseek-ai/dsh-foo/gone`.', { exists: () => false })
    expect(violations).toHaveLength(1)
    expect(violations[0]?.reason).toContain('no export or source')
  })

  it('flags an unknown colon-namespaced script', () => {
    expect(collect('Run `check:gone`.')[0]?.reason).toContain('no root npm script')
  })

  it('honors the allowlist and reports use', () => {
    const used: string[] = []
    const violations = collect('Records `@deepseek-ai/dsh-gone`.', {
      allowed: { '@deepseek-ai/dsh-gone': 'removed package the note records' },
      markUsed: (ref) => {
        used.push(ref)
      },
    })
    expect(violations).toEqual([])
    expect(used).toEqual(['@deepseek-ai/dsh-gone'])
  })

  it('skips fenced code, link targets, globs, placeholders, and prose chains', () => {
    const source = [
      '```',
      '`packages/foo/tool-gone/src/index.ts`',
      '```',
      'See [gone](packages/foo/tool-gone/src/index.ts) and `check:ci:*` and `a/<b>`.',
      'Chain `@deepseek-ai/dsh-foo/a → b` is prose, not a subpath.',
    ].join('\n')
    expect(collect(source, { exists: () => false })).toEqual([])
  })

  it('ignores bare words and non-namespaced backticks', () => {
    expect(collect('The `tools:sdk` section uses `node:vm`.')).toEqual([])
  })
})
