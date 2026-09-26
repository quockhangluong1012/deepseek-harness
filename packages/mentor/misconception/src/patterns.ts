/**
 * The deployment's misconception catalogue and the thesis matching the engine
 * performs against it. The catalogue is configuration: a profile ships its own
 * patterns through the plugin's `cordis.yml` row, and a catalogue that cannot
 * detect anything fails at load rather than silently detecting nothing.
 * @module @deepseek-ai/dsh-misconception/src/patterns
 */

import z from '@deepseek-ai/schemastery'
import type { MisconceptionPattern } from './types.ts'

/** Schema of one declared pattern, composed into the plugin's `Config`. */
export const patternSchema = z.object({
  id: z.string(),
  misconception: z.string(),
  designError: z.string(),
  objective: z.string(),
  triggers: z.array(z.string()),
  explanation: z.string(),
  counterexample: z.string(),
  exercise: z.string(),
})

/** What a deployment declares before validation. */
export interface CatalogueInput {
  /** The misconception patterns this deployment can detect. */
  patterns: MisconceptionPattern[]
  /** Cap in UTF-16 characters on every learner-quoted or engine-rendered text the engine stores or emits. */
  maxTextChars?: number
}

/** Configuration the engine runs with. */
export interface ResolvedConfig {
  /** The catalogue, in declaration order; the first matching pattern decides. */
  readonly patterns: readonly MisconceptionPattern[]
  /** Cap in UTF-16 characters on every stored or emitted text. */
  readonly maxTextChars: number
}

/**
 * Resolve defaults and reject a catalogue the engine cannot use.
 * @param config - the validated plugin configuration.
 * @returns the resolved catalogue and text cap.
 * @throws when the catalogue is empty, repeats a pattern id, or carries a blank trigger or field,
 * because a catalogue in that state silently detects nothing or the wrong thing.
 */
export function resolveConfig(config: CatalogueInput): ResolvedConfig {
  const { patterns, maxTextChars = 2_000 } = config
  if (patterns.length === 0) {
    throw new Error('misconception engine: the pattern catalogue is empty, so no thesis can be judged')
  }
  const seen = new Set<string>()
  for (const pattern of patterns) {
    if (pattern.id.trim().length === 0) throw new Error('misconception engine: a pattern declares a blank id')
    if (seen.has(pattern.id)) throw new Error(`misconception engine: pattern id '${pattern.id}' is declared twice`)
    seen.add(pattern.id)
    if (pattern.triggers.length === 0) throw new Error(`misconception engine: pattern '${pattern.id}' declares no trigger`)
    for (const trigger of pattern.triggers) {
      if (trigger.trim().length === 0) {
        throw new Error(`misconception engine: pattern '${pattern.id}' declares a blank trigger, which matches every thesis`)
      }
    }
    if (pattern.misconception.trim().length === 0 || pattern.designError.trim().length === 0) {
      throw new Error(`misconception engine: pattern '${pattern.id}' names no misconception or no design error`)
    }
    if (pattern.objective.trim().length === 0) {
      throw new Error(`misconception engine: pattern '${pattern.id}' names no objective, so its exercise would target nothing`)
    }
  }
  return { patterns: patterns.map(pattern => ({ ...pattern })), maxTextChars }
}

/**
 * The first catalogued pattern whose triggers appear in a stated thesis.
 * @param patterns - the deployment's catalogue, in declaration order.
 * @param thesis - the learner's stated thesis.
 * @returns the matching pattern, or undefined when the catalogue does not recognize the thesis.
 */
export function matchPattern(
  patterns: readonly MisconceptionPattern[],
  thesis: string,
): MisconceptionPattern | undefined {
  const normalized = thesis.toLowerCase()
  return patterns.find(pattern =>
    pattern.triggers.some(trigger => normalized.includes(trigger.trim().toLowerCase())))
}

/**
 * Trim text to the configured ceiling.
 * @param text - the text to bound.
 * @param maxChars - the ceiling in UTF-16 characters.
 * @returns the text, truncated at the ceiling.
 */
export function boundText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}
