/**
 * Keep non-archived Agent Notes mechanically current: every repository path,
 * package export, and npm script a note states in backticks must exist. Prose
 * claims are invisible to link checkers, so a renamed package, moved script,
 * or deleted workflow would otherwise sit in current authority unnoticed.
 *
 * Deliberately narrow, so history stays writable:
 * - Only `implemented/` notes are checked. `rejected/` notes describe
 *   declined or counterfactual worlds where non-existence is expected, and
 *   `proposed/` notes may legitimately name not-yet-existing things.
 * - Only colon-namespaced npm scripts (`check:*`, `test:*`, … — namespaces
 *   derived from `package.json`) are checked. Bare words collide with domain
 *   vocabulary (`tools:sdk` is a prompt section, `node:vm` a builtin).
 * - Glob/placeholder tokens (`*`, `<…>`) are skipped, as are fenced code
 *   blocks (code examples are not prose claims) and Markdown link targets
 *   (owned by `verify-md-links`).
 * - Intentional historical references (a recorded removal, a rejected
 *   alternative, a build-output path) live in
 *   `scripts/agent-note-refs.allowlist.json` with their reason; stale
 *   allowlist entries fail.
 * @module scripts/verify-agent-note-refs
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** Backticked spans (single-line; fenced code handled by the caller). */
const BACKTICKED = /`([^`\n]+)`/g

/** Markdown links (and images): targets belong to verify-md-links, not here. */
const MARKDOWN_LINK = /!?\[[^\]]*\]\([^)]*\)/g

/** Repo-rooted path prefixes checked for existence. */
const PATH_PREFIXES = [
  'packages/',
  'scripts/',
  'docs/',
  'apps/',
  'snapshots/',
  'benchmarks/',
  'website/',
  'native/',
  'python/',
  '.github/',
  'vendor/',
]

/** Plain path characters: glob, placeholder, and expansion forms are skipped. */
const PLAIN_PATH = /^[A-Za-z0-9_.][A-Za-z0-9_./~+-]*$/

/** Manifest globs whose packages count as workspace packages. */
const PACKAGE_MANIFEST_GLOBS = [
  'packages/*/*/package.json',
  'vendor/*/package.json',
  'apps/*/package.json',
  'native/system/package.json',
  'native/system/packages/*/package.json',
  'website/package.json',
  'benchmarks/package.json',
]

/** One suspect reference with its source location. */
export interface NoteRefViolation {
  /** Note path relative to the repository root. */
  file: string
  /** 1-based line number. */
  line: number
  /** The backticked token. */
  ref: string
  /** Why it fails. */
  reason: string
}

/** One workspace package: its directory and published export subpaths. */
export interface WorkspacePackage {
  /** Repo-relative directory with `/` separators. */
  dir: string
  /** Export subpaths beyond `.` (e.g. `./brand`), without the leading `./`. */
  exports: string[]
}

/** Read every workspace package manifest once. */
function workspacePackages(root: string): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>()
  for (const manifest of PACKAGE_MANIFEST_GLOBS.flatMap(pattern => globSync(pattern, { cwd: root }))) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(root, manifest), 'utf8')) as {
        name?: unknown
        exports?: unknown
      }
      if (typeof parsed.name !== 'string') continue
      const dir = manifest.split(sep).join('/').replace(/\/package\.json$/, '')
      const exports = typeof parsed.exports === 'object' && parsed.exports !== null
        ? Object.keys(parsed.exports)
          .filter(key => key !== '.' && key !== './package.json' && key !== './src/*')
          .map(key => key.replace(/^\.\//, ''))
        : []
      packages.set(parsed.name, { dir, exports })
    } catch {
      continue
    }
  }
  return packages
}

/** Colon-namespaces of current root npm scripts, plus the gate/script prefixes. */
function scriptNamespaces(root: string): { namespaces: Set<string>; scripts: Set<string> } {
  const namespaces = new Set(['verify', 'gen'])
  const scripts = new Set<string>()
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts?: unknown }
    const table: unknown = pkg.scripts
    if (typeof table === 'object' && table !== null) {
      for (const name of Object.keys(table)) {
        scripts.add(name)
        const head = name.split(':')[0]
        if (head !== undefined && name.includes(':')) namespaces.add(head)
      }
    }
  } catch {
    // A missing package.json fails loudly below at the npmScripts read.
  }
  return { namespaces, scripts }
}

/** Allowlist file shape: note path to ref to reason. */
export type NoteRefAllowlist = Record<string, Record<string, string>>

/** Read and validate the allowlist manifest. */
function readAllowlist(root: string): { allowlist: NoteRefAllowlist; errors: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(
      readFileSync(resolve(root, 'scripts/agent-note-refs.allowlist.json'), 'utf8'),
    ) as unknown
  } catch {
    return { allowlist: {}, errors: ['scripts/agent-note-refs.allowlist.json is missing or unparsable'] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { allowlist: {}, errors: ['scripts/agent-note-refs.allowlist.json must be an object of note to ref to reason'] }
  }
  return { allowlist: parsed as NoteRefAllowlist, errors: [] }
}

/** Strip fenced code blocks; returns non-code lines with their numbers. */
function proseLines(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = []
  let fenced = false
  source.split('\n').forEach((text, index) => {
    if (/^```/.test(text)) {
      fenced = !fenced
      return
    }
    if (!fenced) out.push({ line: index + 1, text: text.replace(MARKDOWN_LINK, '') })
  })
  return out
}

/**
 * Collect reference violations for one note file's content.
 * @param file - repo-relative note path (for diagnostics and allowlisting only).
 * @param source - note Markdown content.
 * @param packages - workspace package map.
 * @param namespaces - accepted npm-script namespaces.
 * @param scripts - root npm script names.
 * @param allowed - allowlisted refs for this note.
 * @param exists - existence probe over repo-relative paths.
 * @param markUsed - called with each allowlisted ref the file actually states.
 * @returns violations in document order.
 */
export function collectNoteRefViolations(
  file: string,
  source: string,
  packages: Map<string, WorkspacePackage>,
  namespaces: Set<string>,
  scripts: Set<string>,
  allowed: Record<string, string> = {},
  exists: (repoPath: string) => boolean = repoPath => existsSync(resolve(ROOT, repoPath)),
  markUsed?: (ref: string) => void,
): NoteRefViolation[] {
  const violations: NoteRefViolation[] = []
  for (const { line, text } of proseLines(source)) {
    for (const match of text.matchAll(BACKTICKED)) {
      const ref = (match[1] ?? '').trim()
      if (ref === '') continue
      if (allowed[ref] !== undefined) {
        markUsed?.(ref)
        continue
      }
      if (PATH_PREFIXES.some(prefix => ref.startsWith(prefix))) {
        const trimmed = ref.replace(/[./]+$/, '')
        if (!PLAIN_PATH.test(trimmed)) continue
        if (!exists(trimmed)) {
          violations.push({ file, line, ref, reason: 'names no file or directory on disk' })
        }
        continue
      }
      if (ref.startsWith('@deepseek-ai/')) {
        if (/[*<>]/.test(ref) || /[\s→]/.test(ref)) continue
        const slash = ref.indexOf('/', '@deepseek-ai/'.length)
        const name = slash < 0 ? ref : ref.slice(0, slash)
        const pkg = packages.get(name)
        if (pkg === undefined) {
          violations.push({ file, line, ref, reason: 'names no workspace package' })
        } else if (slash >= 0) {
          const sub = ref.slice(slash + 1)
          const exported = pkg.exports.some(key => key === sub || sub.startsWith(`${key}/`))
          const onDisk = exists(`${pkg.dir}/src/${sub}.ts`)
            || exists(`${pkg.dir}/src/${sub}.tsx`)
            || exists(`${pkg.dir}/src/${sub}/index.ts`)
            || exists(`${pkg.dir}/src/${sub}`)
          if (!exported && !onDisk) {
            violations.push({ file, line, ref, reason: 'names no export or source under its package' })
          }
        }
        continue
      }
      const head = ref.split(':')[0]
      if (head !== undefined && ref.includes(':') && !/[*<>]/.test(ref) && namespaces.has(head)) {
        if (!scripts.has(ref)) {
          violations.push({ file, line, ref, reason: 'names no root npm script' })
        }
      }
    }
  }
  return violations
}

/**
 * Collect violations across `implemented/` without exiting.
 * @param root - Repository root containing `.agents/notes`.
 * @returns human-readable violations; empty means every stated reference exists.
 */
export function collectAgentNoteRefViolations(root: string = ROOT): string[] {
  const packages = workspacePackages(root)
  const { namespaces, scripts } = scriptNamespaces(root)
  const { allowlist, errors } = readAllowlist(root)
  const violations: string[] = [...errors]
  const exists = (repoPath: string): boolean => existsSync(resolve(root, repoPath))
  const seen = new Set<string>()
  const notes = globSync(['.agents/notes/implemented/**/*.md'], { cwd: root }).map(String).sort()
  for (const note of notes.map(n => n.split(sep).join('/'))) {
    if (note.endsWith('.zh.md')) continue
    let source: string
    try {
      source = readFileSync(resolve(root, note), 'utf8')
    } catch {
      continue
    }
    const allowed = allowlist[note] ?? {}
    for (const v of collectNoteRefViolations(note, source, packages, namespaces, scripts, allowed, exists, (ref) => {
      seen.add(`${note}::${ref}`)
    })) {
      violations.push(`${v.file}:${v.line}: \`${v.ref}\` ${v.reason}`)
    }
  }
  for (const [note, refs] of Object.entries(allowlist)) {
    for (const ref of Object.keys(refs)) {
      if (!seen.has(`${note}::${ref}`)) {
        violations.push(`scripts/agent-note-refs.allowlist.json: stale entry ${note}::${ref}`)
      }
    }
  }
  return violations
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const violations = collectAgentNoteRefViolations(ROOT)
  if (violations.length > 0) {
    process.stderr.write('verify-agent-note-refs: stale references in current-authority notes:\n')
    for (const violation of violations) process.stderr.write(`  ${violation}\n`)
    process.exit(1)
  }
  process.stdout.write('verify-agent-note-refs: every stated path, package, and script exists.\n')
}
