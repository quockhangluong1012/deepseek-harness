/**
 * Unit coverage for the hardcoded-tunable gate.
 * @module scripts/verify-no-hardcoded-tunables.spec
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectHardcodedTunableViolations } from './verify-no-hardcoded-tunables.ts'

function write(root: string, file: string, source: string): void {
  const path = join(root, file)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, source)
}

function allowlist(root: string, content: string): void {
  write(root, 'scripts/hardcoded-tunables.allowlist.json', content)
}

const EMPTY_ALLOWLIST = '{}'

describe('verify-no-hardcoded-tunables', () => {
  it('passes on a Config-backed numeric', () => {
    const root = mkdtempSync(join(tmpdir(), 'tunables-'))
    allowlist(root, EMPTY_ALLOWLIST)
    write(
      root,
      'packages/todo/tool-todo/src/index.ts',
      'const MAX_TODOS = 100\nconst Config = z.object({ maxTodos: z.number().default(MAX_TODOS) })\n',
    )
    expect(collectHardcodedTunableViolations(root)).toEqual([])
  })

  it('passes when another file of the same package holds the Config default', () => {
    const root = mkdtempSync(join(tmpdir(), 'tunables-'))
    allowlist(root, EMPTY_ALLOWLIST)
    write(root, 'packages/lsp/tool-lsp/src/render.ts', 'export const DEFAULT_MAX_LOCATIONS = 100\n')
    write(
      root,
      'packages/lsp/tool-lsp/src/index.ts',
      'import { DEFAULT_MAX_LOCATIONS } from "./render.ts"\nconst Config = z.object({ maxLocations: z.number().default(DEFAULT_MAX_LOCATIONS) })\n',
    )
    expect(collectHardcodedTunableViolations(root)).toEqual([])
  })

  it('flags a numeric with no Config default and no allowlist entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'tunables-'))
    allowlist(root, EMPTY_ALLOWLIST)
    write(root, 'packages/todo/tool-todo/src/index.ts', 'const MAX_TODOS = 100\n')
    const violations = collectHardcodedTunableViolations(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('packages/todo/tool-todo/src/index.ts:1')
    expect(violations[0]).toContain('MAX_TODOS')
  })

  it('honors the allowlist and rejects stale entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'tunables-'))
    allowlist(
      root,
      JSON.stringify({ 'packages/web/tool-web/src/fetch.ts': { MAX_CONVERSION_DEPTH: 'parser bound' } }),
    )
    write(root, 'packages/web/tool-web/src/fetch.ts', 'const MAX_CONVERSION_DEPTH = 512\n')
    expect(collectHardcodedTunableViolations(root)).toEqual([])

    const stale = mkdtempSync(join(tmpdir(), 'tunables-'))
    allowlist(
      stale,
      JSON.stringify({ 'packages/web/tool-web/src/fetch.ts': { MAX_GONE: 'removed' } }),
    )
    write(stale, 'packages/web/tool-web/src/fetch.ts', 'const MAX_CONVERSION_DEPTH = 512\n')
    const violations = collectHardcodedTunableViolations(stale)
    expect(violations.some(violation => violation.includes('stale entry'))).toBe(true)
    expect(violations.some(violation => violation.includes('MAX_CONVERSION_DEPTH'))).toBe(true)
  })

  it('ignores non-numeric bindings and non-tool packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'tunables-'))
    allowlist(root, EMPTY_ALLOWLIST)
    write(root, 'packages/fs/tool-fs/src/index.ts', 'const DEFAULT_DESCRIPTION = `text`\n')
    write(root, 'packages/core/tools/src/index.ts', 'const MAX_ANYTHING = 5\n')
    expect(collectHardcodedTunableViolations(root)).toEqual([])
  })
})
