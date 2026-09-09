/**
 * Unit coverage for the package-group table gate folded into
 * `verify-package-paths`.
 * @module scripts/verify-package-paths.spec
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectPackageGroupTableViolations } from './verify-package-paths.ts'

function write(root: string, file: string, source: string): void {
  const path = join(root, file)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, source)
}

const TABLE = [
  '| Group | Role |',
  '|---|---|',
  '| [`core/`](core/README.md) | spine |',
  '| [`mcp/`](mcp/README.md) | bridge |',
  '',
].join('\n')

describe('verify-package-paths group table', () => {
  it('passes when the table matches the disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'pkg-groups-'))
    mkdirSync(join(root, 'packages', 'core'), { recursive: true })
    mkdirSync(join(root, 'packages', 'mcp'), { recursive: true })
    write(root, 'packages/README.md', TABLE)
    expect(collectPackageGroupTableViolations(root)).toEqual([])
  })

  it('names a group on disk with no table row', () => {
    const root = mkdtempSync(join(tmpdir(), 'pkg-groups-'))
    mkdirSync(join(root, 'packages', 'core'), { recursive: true })
    mkdirSync(join(root, 'packages', 'mcp'), { recursive: true })
    write(root, 'packages/README.md', TABLE.replace('| [`mcp/`](mcp/README.md) | bridge |\n', ''))
    expect(collectPackageGroupTableViolations(root)).toEqual([
      'packages/README.md: group `mcp/` exists on disk but has no table row',
    ])
  })

  it('names a table row with no directory on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'pkg-groups-'))
    mkdirSync(join(root, 'packages', 'core'), { recursive: true })
    write(root, 'packages/README.md', `${TABLE}| [\`support/\`](support/README.md) | phantom |\n`)
    expect(collectPackageGroupTableViolations(root)).toEqual([
      'packages/README.md: table row `mcp/` names no directory on disk',
      'packages/README.md: table row `support/` names no directory on disk',
    ])
  })

  it('fails when packages/README.md is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'pkg-groups-'))
    mkdirSync(join(root, 'packages', 'core'), { recursive: true })
    expect(collectPackageGroupTableViolations(root)).toEqual([
      'packages/README.md is missing; the package-group map has no home',
    ])
  })
})
