/** Reject one ambiguous origin label from maintained tracked files. */

import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { historicalSchemaRegion } from './historical-schema-region.ts'

const root = resolve(import.meta.dirname, '..')
const blockedTerm = 'prove' + 'nance'
const excludedPrefixes = ['vendor/', '.agents/notes/archived/'] as const

/** One blocked term occurrence in a tracked path or text line. */
export interface ConcreteTermViolation {
  /** Repository-relative tracked path. */
  file: string
  /** One-based source line, or null when the path contains the term. */
  line: number | null
}

function isExcluded(file: string): boolean {
  return excludedPrefixes.some(prefix => file.startsWith(prefix))
    // Release snapshots retain the identifiers present in their pinned source.
    || /^docs\/persistence-changes\/releases\/dsh-v\d+\.\d+\.\d+-(?:alpha|rc)\.\d+\.schema\.json$/u.test(file)
    || /^docs\/persistence-changes\/historical-formats\/v(?:0|[1-9]\d*)\.schema\.json$/u.test(file)
    // A finalized change record is a byte-preserved capture of what a released
    // format actually declared, and the per-root digests in its accepted
    // acknowledgement attest that capture. Editing a field inside one would make
    // the record misdescribe what shipped while its digests still claim it did
    // not, so the retired token stays where the evidence is.
    || /^docs\/persistence-changes\/finalized\/[\w.-]+\.json$/u.test(file)
    || /^docs\/persistence-changes\/\d{4}-\d{2}-\d{2}-[\w-]+\.schema\.json$/u.test(file)
}

/**
 * Whether a tracked file is a binary payload rather than maintained text. A NUL
 * byte in the first kilobyte is the standard signal: the gate polices declarations
 * and prose, and a byte sequence inside a database, image or archive is not a
 * declaration of anything.
 * @param source - the tracked file's raw bytes.
 * @returns true when the file is binary and carries no policed text.
 */
export function isBinaryPayload(source: Buffer): boolean {
  return source.subarray(0, 1024).includes(0)
}

function containsBlockedTerm(value: string): boolean {
  return value.normalize('NFKC').toLowerCase().includes(blockedTerm)
}

/**
 * Find the blocked term in one maintained tracked file.
 * @param file - repository-relative tracked path.
 * @param source - text contents or symlink target.
 * @returns violations outside vendored sources, frozen Agent Notes, historical schemas and their checked generated regions.
 */
export function findConcreteTermViolations(file: string, source: string): ConcreteTermViolation[] {
  if (isExcluded(file)) return []
  const violations: ConcreteTermViolation[] = []
  if (containsBlockedTerm(file)) violations.push({ file, line: null })
  const lines = source.split(/\r?\n/u)
  const schemaRegion = historicalSchemaRegion(file, source)
  for (const [index, line] of lines.entries()) {
    if (schemaRegion !== undefined && index >= schemaRegion[0] && index < schemaRegion[1]) continue
    if (containsBlockedTerm(line)) violations.push({ file, line: index + 1 })
  }
  return violations
}

function trackedFiles(repoRoot: string): string[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(file => file !== '')
  if (!files.includes('AGENTS.md')
    || !files.some(file => file.startsWith('packages/'))
    || !files.some(file => file.startsWith('docs/'))
    || !files.some(file => file.startsWith('vendor/'))
    || !files.some(file => file.startsWith('.agents/notes/archived/'))) {
    throw new Error('verify-concrete-terms: tracked-file discovery omitted a required repository area')
  }
  return files
}

/**
 * Read one tracked file without following a symlink to its target.
 * @param repoRoot - Repository root containing the tracked path.
 * @param file - Repository-relative tracked path.
 * @returns File text, the symlink target, or undefined when the path is absent or not a file.
 */
export function readTrackedSource(repoRoot: string, file: string): string | undefined {
  const path = resolve(repoRoot, file)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return undefined
  if (stat.isSymbolicLink()) return readlinkSync(path)
  return stat.isFile() ? readFileSync(path, 'utf8') : undefined
}

function scanRepository(repoRoot: string): ConcreteTermViolation[] {
  const violations: ConcreteTermViolation[] = []
  for (const file of trackedFiles(repoRoot)) {
    const path = resolve(repoRoot, file)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    // A binary payload declares nothing: a byte sequence inside a database,
    // image or archive is not maintained text, so the term in one is not a
    // label this gate polices. Its PATH is still checked, so a binary file
    // named after the retired term still fails.
    if (stat !== undefined && stat.isFile() && isBinaryPayload(readFileSync(path))) continue
    const source = readTrackedSource(repoRoot, file)
    if (source === undefined) continue
    violations.push(...findConcreteTermViolations(file, source))
  }
  return violations
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const violations = scanRepository(root)
  if (violations.length === 0) {
    console.log(`verify-concrete-terms: maintained tracked files contain no ${blockedTerm}.`)
  } else {
    console.error(`verify-concrete-terms: ${blockedTerm} is forbidden; name the exact source, field, identity, or evidence:`)
    for (const violation of violations) {
      console.error(violation.line === null
        ? `  ${violation.file} (path)`
        : `  ${violation.file}:${String(violation.line)}`)
    }
    process.exitCode = 1
  }
}
