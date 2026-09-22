/**
 * Filesystem mechanics for managed skills: directory expansion, registry
 * resolution, frontmatter handling, and unique-substring surgery. Pure
 * helpers plus thin node:fs operations; the tool owns policy.
 * @module @deepseek-ai/dsh-evolution-skill-manage/files
 */

import { access, constants } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isExcludedSkillSource } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export { isSkillName }

/** Main instruction filename inside every skill directory. */
export const SKILL_FILE = 'SKILL.md'

/** Fixed bound on the ambiguous-match error payload. */
const MAX_AMBIGUOUS_CANDIDATES = 5

/**
 * Expand one configured skill directory: `~` against the OS home and
 * `${VAR}`/`$VAR` against the environment. A missing variable fails loudly;
 * an omitted value resolves to the profile skills directory.
 * @param raw - configured directory, or undefined for the default.
 * @returns the expanded directory path.
 */
export function expandCreateDir(raw: string | undefined): string {
  if (raw === undefined) return dshHomePath('skills')
  const expanded = expandHomePath(raw).replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match: string, braced?: string, bare?: string): string => {
      const name = `${braced ?? ''}${bare ?? ''}`
      const value = process.env[name]
      if (value === undefined) {
        throw new Error(`evolution skill_manage createDir references missing environment variable '${name}'`)
      }
      return value
    },
  )
  return resolve(expanded)
}

/**
 * Validate a model-supplied skill name.
 * @param name - candidate skill name.
 */
export function checkSkillName(name: string): void {
  if (!isSkillName(name)) {
    throw new Error(`invalid skill name "${name}": use lowercase kebab-case like "code-review"`)
  }
}

/** A resolved writable skill location. */
export interface ResolvedSkill {
  name: string
  dir: string
  file: string
  source: string
}

/**
 * Resolve one catalog skill to its writable directory. Bundled and hub
 * skills resolve to a loud refusal; unknown or file-less skills to a
 * missing error; unwritable targets to a permission error.
 * @param list - skill catalog lookup.
 * @param name - validated skill name.
 * @param checkPath - path checked for writability: the file for content ops, the directory for structural ops.
 * @returns the resolved location.
 */
export async function resolveSkillDir(
  list: () => Promise<readonly SkillSummary[]>,
  name: string,
  checkPath: (dir: string, file: string) => string,
): Promise<ResolvedSkill> {
  const summary = (await list()).find(skill => skill.name === name)
  if (summary === undefined) throw new Error(`skill "${name}" is unknown or no longer available`)
  if (isExcludedSkillSource(summary.source)) {
    throw new Error(`skill "${name}" is ${summary.source}-managed and cannot be edited here`)
  }
  if (summary.path === undefined) throw new Error(`skill "${name}" has no local directory`)
  const dir = dirname(summary.path)
  const file = join(dir, SKILL_FILE)
  try {
    await access(checkPath(dir, file), constants.W_OK)
  } catch {
    throw new Error(`skill "${name}" is not writable: ${checkPath(dir, file)}`)
  }
  return { name, dir, file, source: summary.source }
}

/**
 * Resolve one relative path inside a skill directory. Absolute paths and
 * traversals outside the directory fail loudly; the main instruction file
 * is reserved for the content ops.
 * @param dir - skill directory.
 * @param rel - caller-supplied relative path.
 * @returns the resolved absolute path.
 */
export function resolveSkillPath(dir: string, rel: string): string {
  if (rel.length === 0) throw new Error('skill file path must be non-empty')
  if (isAbsolute(rel)) throw new Error(`skill file path must be relative to the skill directory, got "${rel}"`)
  const resolved = resolve(dir, rel)
  const outside = relative(dir, resolved)
  if (!(outside === '' || (!outside.startsWith('..') && !isAbsolute(outside)))) {
    throw new Error(`skill file path escapes the skill directory: "${rel}"`)
  }
  if (basename(resolved) === SKILL_FILE) {
    throw new Error(`"${SKILL_FILE}" is reserved for the patch and edit operations`)
  }
  return resolved
}

/**
 * Split YAML frontmatter off a skill file. The body keeps every byte after
 * the closing fence.
 * @param text - complete file text.
 * @returns head and body, or undefined when the fences are malformed.
 */
export function splitFrontmatter(text: string): { head: string; body: string } | undefined {
  const lines = text.split('\n')
  if (lines[0] !== '---') return undefined
  const closing = lines.indexOf('---', 1)
  if (closing === -1) return undefined
  return { head: lines.slice(1, closing).join('\n'), body: lines.slice(closing + 1).join('\n') }
}

/**
 * Build one complete skill file from frontmatter fields and a body.
 * @param name - skill name for the frontmatter.
 * @param description - routing description for the frontmatter.
 * @param body - markdown instruction body.
 * @returns the file text.
 */
export function buildSkillFile(name: string, description: string, body: string): string {
  return `---\n${stringifyYaml({ name, description })}---\n${body}`
}

/** One skill file whose head already passed the kept-frontmatter invariant. */
export interface ValidatedSkillFile {
  /** Frontmatter text without its fences, byte for byte as written. */
  head: string
  /** The head parsed, after the invariant checked it. */
  fields: Record<string, unknown>
  /** Markdown body after the closing fence. */
  body: string
}

/**
 * Split one complete skill file and validate its head against the invariant
 * every content operation enforces: the fences must match, the head must
 * parse, and it must name this skill with a routing description. One
 * implementation, so a rewritten body and a synthesized file cannot disagree
 * about what a valid head is.
 * @param text - complete file text.
 * @param name - skill the head must name.
 * @returns the validated head text, its parsed fields, and the body.
 */
export function splitSkillFile(text: string, name: string): ValidatedSkillFile {
  const split = splitFrontmatter(text)
  if (split === undefined) throw new Error(`skill "${name}" has malformed frontmatter`)
  return { ...split, fields: validateSkillHead(split.head, name) }
}

/**
 * Rebuild one synthesized skill file from the caller's text: the head goes
 * through the same invariant `edit` enforces, then its lineage is replaced
 * with the sources actually composed, so a derived skill cannot claim parents
 * it was not built from.
 * @param text - complete file text the caller supplied.
 * @param name - skill the head must name.
 * @param sources - source skill names, in declaration order.
 * @returns the file text to write.
 */
export function buildDerivedSkillFile(text: string, name: string, sources: readonly string[]): string {
  const { fields, body } = splitSkillFile(text, name)
  return `---\n${stringifyYaml({ ...fields, derived_from: [...sources] })}---\n${body}`
}

/**
 * Validate kept frontmatter on edit or synthesis: it must parse and still name
 * this skill with a routing description.
 * @param head - frontmatter text without fences.
 * @param name - skill under edit.
 * @returns the parsed frontmatter fields.
 */
export function validateSkillHead(head: string, name: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = parseYaml(head)
  } catch (error) {
    throw new Error(`skill "${name}" kept invalid frontmatter: ${String(error)}`)
  }
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
  if (record['name'] !== name) throw new Error(`skill "${name}" frontmatter must keep name "${name}"`)
  if (typeof record['description'] !== 'string' || record['description'].length === 0) {
    throw new Error(`skill "${name}" frontmatter must keep a description`)
  }
  return record
}

/**
 * Replace one uniquely-occurring substring.
 * @param text - haystack document.
 * @param oldText - non-empty substring expected exactly once.
 * @param content - replacement text.
 * @param what - owner phrase for failure messages.
 * @returns the spliced document.
 */
export function replaceUniqueSubstring(text: string, oldText: string, content: string, what: string): string {
  if (oldText.length === 0) throw new Error(`${what} old text must be non-empty`)
  const offsets: number[] = []
  let from = 0
  while (true) {
    const at = text.indexOf(oldText, from)
    if (at === -1) break
    offsets.push(at)
    from = at + oldText.length
  }
  if (offsets.length === 0) throw new Error(`${what} found no match for the old text`)
  if (offsets.length > 1) {
    const candidates = offsets.slice(0, MAX_AMBIGUOUS_CANDIDATES).map(at =>
      text.slice(Math.max(0, at - 30), at + oldText.length + 30),
    )
    throw new Error(`${what} old text matches ${offsets.length} times; disambiguate with a longer substring: ${candidates.join(' | ')}`)
  }
  const at = offsets[0] as number
  return text.slice(0, at) + content + text.slice(at + oldText.length)
}
