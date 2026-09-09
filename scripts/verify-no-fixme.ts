/**
 * Reject release-blocking `FIXME` markers in runtime source. `AGENTS.md`
 * defines `FIXME` as the urgent tier, so any surviving marker means a known
 * release blocker is still open.
 * @module scripts/verify-no-fixme
 */

import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Collect `FIXME` violations without exiting.
 * @param root - Repository root to scan.
 * @returns human-readable violations; empty means no release blocker.
 */
export function collectNoFixmeViolations(root: string = ROOT): string[] {
  const files = globSync(['packages/*/*/src/**/*.{ts,tsx}', 'scripts/**/*.ts'], {
    cwd: root,
    exclude: ['**/lib/**', '**/*.spec.ts'],
  })
  const violations: string[] = []
  for (const file of files.map(String).sort()) {
    const display = file.split(sep).join('/')
    let source: string
    try {
      source = readFileSync(resolve(root, file), 'utf8')
    } catch {
      continue
    }
    source.split('\n').forEach((line, index) => {
      if (/\bFIXME\s*[:([]/.test(line)) {
        violations.push(`${display}:${String(index + 1)}: FIXME marker must be resolved before release`)
      }
    })
  }
  return violations
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const violations = collectNoFixmeViolations(ROOT)
  if (violations.length > 0) {
    process.stderr.write('verify-no-fixme: release-blocking markers found:\n')
    for (const violation of violations) process.stderr.write(`  ${violation}\n`)
    process.exit(1)
  }
  process.stdout.write('verify-no-fixme: no FIXME markers in runtime source.\n')
}
