/**
 * Reject deployment-varying numerics hiding as module-scope constants in
 * model-facing tool packages. A `MAX_*`/`DEFAULT_*` numeric under a tool
 * package's `src` tree must be a `Config` default (referenced by the file's
 * zod schema) or a recorded protocol/external invariant in
 * `scripts/hardcoded-tunables.allowlist.json` — never a silent literal the
 * deployment cannot change from `cordis.yml`.
 * @module scripts/verify-no-hardcoded-tunables
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** Module-scope `MAX_*`/`DEFAULT_*` binding with a numeric initializer. */
const TUNABLE = /^(?:export\s+)?const\s+(MAX_[A-Z0-9_]+|DEFAULT_[A-Z0-9_]+)\s*=\s*(?<init>\(?\s*-?\d)/

/** Allowlist file shape: file path to constant name to reason. */
type Allowlist = Record<string, Record<string, string>>

/** One finding with its source location. */
export interface TunableViolation {
  /** Repo-relative source file with `/` separators. */
  file: string
  /** 1-based line number. */
  line: number
  /** Constant name. */
  name: string
}

/** Read and validate the allowlist manifest. */
function readAllowlist(root: string): { allowlist: Allowlist; errors: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(resolve(root, 'scripts/hardcoded-tunables.allowlist.json'), 'utf8')) as unknown
  } catch {
    return { allowlist: {}, errors: ['scripts/hardcoded-tunables.allowlist.json is missing or unparsable'] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { allowlist: {}, errors: ['scripts/hardcoded-tunables.allowlist.json must be an object of file to constant to reason'] }
  }
  return { allowlist: parsed as Allowlist, errors: [] }
}

/**
 * Collect hardcoded-tunable violations without exiting.
 * @param root - Repository root to scan.
 * @returns human-readable violations; empty means every numeric is Config-backed or recorded.
 */
export function collectHardcodedTunableViolations(root: string = ROOT): string[] {
  const violations: string[] = []
  const { allowlist, errors } = readAllowlist(root)
  violations.push(...errors)
  const seen = new Set<string>()
  const files = globSync(['packages/*/tool-*/src/**/*.ts'], { cwd: root }).map(String).sort()
  const sources = new Map<string, string>()
  for (const file of files) {
    try {
      sources.set(file, readFileSync(resolve(root, file), 'utf8'))
    } catch {
      continue
    }
  }
  // A constant is Config-backed when any file of the same tool package names
  // it as a zod `.default()` — defaults may live beside the schema while the
  // constant lives beside its use.
  const configBacked = new Set<string>()
  for (const [file, source] of sources) {
    const pkg = file.split(sep).slice(0, 3).join('/')
    for (const match of source.matchAll(/\.default\(([A-Z0-9_]+)\)/g)) {
      configBacked.add(`${pkg}::${match[1] as string}`)
    }
  }
  for (const [file, source] of sources) {
    const display = file.split(sep).join('/')
    const pkg = file.split(sep).slice(0, 3).join('/')
    const lines = source.split('\n')
    lines.forEach((text, index) => {
      const match = TUNABLE.exec(text)
      if (match === null) return
      const name = match[1] as string
      seen.add(`${display}::${name}`)
      if (configBacked.has(`${pkg}::${name}`)) return
      if (allowlist[display]?.[name] !== undefined) return
      violations.push(
        `${display}:${String(index + 1)}: ${name} is a hardcoded numeric — expose it as a Config field (used as a zod .default) or record it in scripts/hardcoded-tunables.allowlist.json`,
      )
    })
  }
  for (const [file, names] of Object.entries(allowlist)) {
    for (const name of Object.keys(names)) {
      if (!seen.has(`${file}::${name}`)) {
        violations.push(`scripts/hardcoded-tunables.allowlist.json: stale entry ${file}::${name} names no such constant`)
      }
    }
  }
  return violations
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const violations = collectHardcodedTunableViolations(ROOT)
  if (violations.length > 0) {
    process.stderr.write('verify-no-hardcoded-tunables: violations found:\n')
    for (const violation of violations) process.stderr.write(`  ${violation}\n`)
    process.exit(1)
  }
  process.stdout.write('verify-no-hardcoded-tunables: every tool numeric is Config-backed or recorded.\n')
}
