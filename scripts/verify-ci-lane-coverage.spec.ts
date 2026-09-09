/**
 * Unit coverage for the CI lane-coverage gate.
 * @module scripts/verify-ci-lane-coverage.spec
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectCiLaneCoverageViolations, REQUIRED_LANE_SCRIPTS } from './verify-ci-lane-coverage.ts'

function writeGitlab(dir: string, source: string): string {
  writeFileSync(join(dir, '.gitlab-ci.yml'), source)
  return dir
}

const COVERED = [
  'workflow:',
  '  rules:',
  '    - if: \'$CI_PIPELINE_SOURCE == "merge_request_event"\'',
  'cache:',
  '  key:',
  '    files:',
  '      - pnpm-lock.yaml',
  ...REQUIRED_LANE_SCRIPTS.map(script => `pnpm run ${script}`),
].join('\n')

describe('verify-ci-lane-coverage', () => {
  it('passes on a covered pipeline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-lane-'))
    writeGitlab(dir, COVERED)
    expect(collectCiLaneCoverageViolations(dir)).toEqual([])
  })

  it('rejects a pipeline that never admits merge requests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-lane-'))
    writeGitlab(dir, `${COVERED.replace('merge_request_event', 'never-such-event')}\n- when: never\n`)
    const violations = collectCiLaneCoverageViolations(dir)
    expect(violations.some(violation => violation.includes('merge_request_event'))).toBe(true)
  })

  it('names every missing lane script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-lane-'))
    writeGitlab(dir, 'workflow:\n  rules:\n    - if: \'$CI_PIPELINE_SOURCE == "merge_request_event"\'\ncache:\n  key:\n    files:\n      - pnpm-lock.yaml\n')
    const violations = collectCiLaneCoverageViolations(dir)
    for (const script of REQUIRED_LANE_SCRIPTS) {
      expect(violations.some(violation => violation.includes(script))).toBe(true)
    }
  })

  it('fails when .gitlab-ci.yml is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-lane-'))
    expect(collectCiLaneCoverageViolations(dir).length).toBeGreaterThan(0)
  })
})
