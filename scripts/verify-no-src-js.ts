/**
 * Reject committed build output under package sources. `src/` holds the
 * source plane; compilers emit to `lib/`. A tracked JavaScript file under
 * `src/` is residue that drifts from its TypeScript original and pollutes
 * clone detection.
 * @module scripts/verify-no-src-js
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Collect tracked JavaScript paths under package `src/` dirs without exiting.
 * @param root - Repository root to scan.
 * @returns tracked residue paths; empty means the source plane is clean.
 */
export function collectSrcJsViolations(root: string = ROOT): string[] {
  // One pattern only: verified empirically that `*` crosses `/` in this
  // repo's git pathspec handling (so this also catches deeper nesting),
  // while the `**` form matches nothing and must not be used here.
  const output = execFileSync('git', ['ls-files', 'packages/*/*/src/*.js'], {
    cwd: root,
    encoding: 'utf8',
  })
  return output.split('\n').map(line => line.trim()).filter(line => line.length > 0).sort()
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const violations = collectSrcJsViolations(ROOT)
  if (violations.length > 0) {
    process.stderr.write('verify-no-src-js: tracked build output under src/:\n')
    for (const violation of violations) process.stderr.write(`  ${violation}\n`)
    process.exit(1)
  }
  process.stdout.write('verify-no-src-js: no tracked src/**/*.js residue.\n')
}
