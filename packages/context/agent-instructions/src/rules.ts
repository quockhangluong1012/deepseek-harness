/**
 * Path-scoped rule files: frontmatter parsing and `paths` glob matching for the
 * `.dsh/rules/*.md` tree.
 *
 * @module @deepseek-ai/dsh-agent-instructions/rules
 */

import { parse as parseYaml } from 'yaml'
import picomatch from 'picomatch'

/** Frontmatter key naming the project-relative globs a rule applies to. */
const RULE_PATHS_FIELD = 'paths'

/**
 * Split leading YAML frontmatter off one rule file.
 * @param text - complete file text.
 * @returns the frontmatter body without fences and the remaining text, or
 * undefined when the file opens without a complete `---` fence pair.
 */
export function splitRuleFrontmatter(text: string): { head: string; body: string } | undefined {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return undefined
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (closing === -1) return undefined
  return { head: lines.slice(1, closing).join('\n'), body: lines.slice(closing + 1).join('\n') }
}

/**
 * Read the `paths` globs declared by one rule file.
 * @param text - complete rule file text.
 * @returns the declared globs, or undefined when the rule declares none and
 * therefore applies unconditionally. A malformed frontmatter block, a non-list
 * `paths` value, or a list without usable strings is treated as declaring none.
 */
export function rulePathGlobs(text: string): readonly string[] | undefined {
  const split = splitRuleFrontmatter(text)
  if (split === undefined) return undefined
  let fields: unknown
  try {
    fields = parseYaml(split.head)
  } catch {
    // Unparsable frontmatter declares no scope: the rule loads unconditionally,
    // exactly as if the block were absent, so a typo cannot hide guidance.
    return undefined
  }
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return undefined
  const declared = (fields as Record<string, unknown>)[RULE_PATHS_FIELD]
  if (declared === undefined) return undefined
  const values = typeof declared === 'string' ? [declared] : declared
  if (!Array.isArray(values)) return undefined
  const globs = values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return globs.length === 0 ? undefined : globs
}

/**
 * Test one project-relative path against a rule's declared globs.
 * @param relativePath - project-relative path using `/` separators.
 * @param globs - globs declared by the rule's frontmatter.
 * @returns whether any glob selects the path.
 */
export function rulePathMatches(relativePath: string, globs: readonly string[]): boolean {
  const normalized = relativePath.replaceAll('\\', '/')
  return globs.some(glob => picomatch.isMatch(normalized, glob, { dot: true }))
}
