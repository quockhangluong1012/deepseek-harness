/**
 * Assert every `run-gates.ts` CI lane has a `.gitlab-ci.yml` job and that the
 * workflow admits merge-request pipelines.
 * @module scripts/verify-ci-lane-coverage
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** CI lanes that must be directly invoked by a GitLab job. */
export const REQUIRED_LANE_SCRIPTS = [
  'check:ci:static',
  'check:ci:lint:contracts-ready',
  'check:ci:coverage',
  'check:ci:snapshot',
  'check:ci:artifacts',
  'check:ci:consumers',
  'check:node-compat',
  'check:ci:windows-blocking',
] as const

/**
 * Collect lane-coverage violations without exiting.
 * @param root - Repository root containing `.gitlab-ci.yml`.
 * @returns human-readable violations; empty means covered.
 */
export function collectCiLaneCoverageViolations(root: string = ROOT): string[] {
  const violations: string[] = []
  let source: string
  try {
    source = readFileSync(resolve(root, '.gitlab-ci.yml'), 'utf8')
  } catch {
    return ['.gitlab-ci.yml is missing; no CI lane can be invoked']
  }
  if (!source.includes('merge_request_event')) {
    violations.push('.gitlab-ci.yml workflow.rules must admit $CI_PIPELINE_SOURCE == "merge_request_event"')
  }
  if (source.includes('- when: never') && !source.includes('$CI_PIPELINE_SOURCE')) {
    violations.push('.gitlab-ci.yml contains an unconditional `- when: never` terminal rule; MR pipelines can never be created')
  }
  if (!source.includes('pnpm-lock.yaml')) {
    violations.push('.gitlab-ci.yml must define a pnpm-store cache keyed on pnpm-lock.yaml')
  }
  for (const script of REQUIRED_LANE_SCRIPTS) {
    if (!source.includes(script)) {
      violations.push(`.gitlab-ci.yml has no job invoking \`pnpm run ${script}\``)
    }
  }
  return violations
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const violations = collectCiLaneCoverageViolations(ROOT)
  if (violations.length > 0) {
    process.stderr.write('verify-ci-lane-coverage: violations found:\n')
    for (const violation of violations) process.stderr.write(`  ${violation}\n`)
    process.exit(1)
  }
  process.stdout.write(
    `verify-ci-lane-coverage: ${String(REQUIRED_LANE_SCRIPTS.length)} CI lane(s) covered by .gitlab-ci.yml.\n`,
  )
}
