/**
 * Enforce `wc -w`-style ceilings from `scripts/doc-budgets.manifest.json`.
 * Missing files and invalid ceilings fail; `--list` reports current usage.
 * Only listed standing docs are budgeted. Ceilings ratchet down with at least
 * 5% headroom; raising one requires the justification defined in
 * `docs/AGENTS.md`. Entries also carry an optional `maxRules` cap on
 * top-level list items, so compression cannot smuggle in more rules under the
 * same word cap.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

const MANIFEST_PATH = resolve(root, 'scripts/doc-budgets.manifest.json')

/** `wc -w` equivalent: count whitespace-delimited tokens. */
function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** Top-level list items: one physical `- ` line with no indentation. */
function countRules(text: string): number {
  return text.split('\n').filter(line => line.startsWith('- ')).length
}

/** Normalize one manifest entry, reporting malformed ceilings as failures. */
function normalizeEntry(path: string, entry: unknown): { ceiling: number; maxRules?: number } | { failure: string } {
  if (typeof entry === 'number') {
    if (!Number.isInteger(entry) || entry <= 0) {
      return { failure: `${path}: ceiling must be a positive integer, got ${String(entry)}` }
    }
    return { ceiling: entry }
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { failure: `${path}: budget must be a word ceiling or { ceiling, maxRules? }, got ${String(entry)}` }
  }
  const { ceiling, maxRules } = entry as { ceiling?: unknown; maxRules?: unknown }
  if (!Number.isInteger(ceiling) || (ceiling as number) <= 0) {
    return { failure: `${path}: ceiling must be a positive integer, got ${JSON.stringify(ceiling)}` }
  }
  if (maxRules !== undefined && (!Number.isInteger(maxRules) || (maxRules as number) <= 0)) {
    return { failure: `${path}: maxRules must be a positive integer, got ${JSON.stringify(maxRules)}` }
  }
  return maxRules === undefined
    ? { ceiling: ceiling as number }
    : { ceiling: ceiling as number, maxRules: maxRules as number }
}

/**
 * The reserve `docs/AGENTS.md` asks every budgeted doc to keep free.
 * A doc inside it is reported, not failed: the remedy is relocation or
 * condensation, which for a paired document also moves its translation, so the
 * gate names the debt instead of blocking unrelated work.
 */
const HEADROOM_RESERVE = 0.05

/** Render a headroom fraction as a whole-percent string. */
function formatHeadroom(headroom: number): string {
  return `${(headroom * 100).toFixed(0)}%`
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, unknown>

const listOnly = process.argv.includes('--list')
const failures: string[] = []
const rows: string[] = []
/** Docs inside the reserve: reported every run, never a failure on their own. */
const tight: string[] = []

for (const [path, entry] of Object.entries(manifest)) {
  const normalized = normalizeEntry(path, entry)
  if ('failure' in normalized) {
    rows.push(`BAD   ${'—'.padStart(6)} / ${'—'.padEnd(6)} ${path}`)
    failures.push(normalized.failure)
    continue
  }
  const { ceiling, maxRules } = normalized
  const abs = resolve(root, path)
  if (!existsSync(abs)) {
    rows.push(`MISS  ${'—'.padStart(6)} / ${String(ceiling).padEnd(6)} ${path}`)
    failures.push(`${path}: budgeted file does not exist (renamed or deleted? update scripts/doc-budgets.manifest.json in the same change)`)
    continue
  }
  const source = readFileSync(abs, 'utf8')
  const words = countWords(source)
  const headroom = (ceiling - words) / ceiling
  if (headroom < HEADROOM_RESERVE) tight.push(`${path} (${words}/${ceiling}, ${formatHeadroom(headroom)})`)
  const rules = maxRules === undefined ? undefined : countRules(source)
  if (rules !== undefined && maxRules !== undefined && rules > maxRules) {
    failures.push(`${path}: ${rules} top-level rules exceeds the ${maxRules}-rule cap — move rules to their home tier instead of compressing them here`)
  }
  rows.push(
    `${words <= ceiling ? 'ok  ' : 'OVER'}  ${String(words).padStart(6)} / ${String(ceiling).padEnd(6)}`
    + ` ${formatHeadroom(headroom).padStart(6)}  ${path}`
    + (rules === undefined ? '' : `  [${rules}/${maxRules} rules]`),
  )
  if (words > ceiling) {
    failures.push(`${path}: ${words} words exceeds the ${ceiling}-word ceiling — relocate or condense per docs/AGENTS.md (raising the ceiling requires justification in the PR)`)
  }
}

if (listOnly) {
  console.log(rows.join('\n'))
  process.exit(0)
}

if (failures.length > 0) {
  console.error('verify-doc-budgets failed:\n')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('\nSee docs/AGENTS.md for the documentation standard and the relocation-first rule.')
  process.exit(1)
}

console.log(`verify-doc-budgets: ${Object.keys(manifest).length} budgeted docs within ceiling.`)
if (tight.length > 0) {
  console.log(
    `verify-doc-budgets: ${tight.length} doc(s) hold less than the ${formatHeadroom(HEADROOM_RESERVE)}`
    + ' headroom docs/AGENTS.md reserves — relocate or condense before adding rules here:',
  )
  for (const entry of tight) console.log(`  ${entry}`)
}
