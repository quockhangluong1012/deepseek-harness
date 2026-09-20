/**
 * The placement digest.
 *
 * The digest is the identity a replay must reproduce. It covers the compiler
 * version, the ceiling, and — for every placed source — its id, kind, trust,
 * retention, price, relevance, and content digest, plus every omission and
 * every retained conflict. It deliberately excludes wall-clock time and every
 * generated identity, so compiling the same sources twice yields the same
 * digest.
 *
 * @module @deepseek-ai/dsh-agent-context/digest
 */

import { createHash } from 'node:crypto'
import type { CompiledSource, ContextConflict, ContextOmission } from './types.ts'

/**
 * Digest one text.
 * @param content - the text to digest.
 * @returns the lower-case hex SHA-256 of the UTF-8 content.
 */
export function contentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Digest one placement.
 * @param compilerVersion - the compiler version that produced it.
 * @param maxTokens - the ceiling it was fitted to, or null when unbounded.
 * @param included - the placed sources, in placement order.
 * @param omitted - every source the compile left out.
 * @param conflicts - every retained conflict.
 * @returns the lower-case hex SHA-256 of the canonical placement form.
 */
export function digestPlacement(
  compilerVersion: string,
  maxTokens: number | null,
  included: readonly CompiledSource[],
  omitted: readonly ContextOmission[],
  conflicts: readonly ContextConflict[],
): string {
  const canonical = JSON.stringify({
    compilerVersion,
    maxTokens,
    included: included.map(entry => [
      entry.source.id,
      entry.source.kind,
      entry.source.trust,
      entry.source.retention,
      entry.tokens,
      entry.relevance,
      contentDigest(entry.source.content),
    ]),
    omitted: omitted.map(entry => [entry.id, entry.reason]),
    conflicts: conflicts.map(entry => [entry.subject, [...entry.sources]]),
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}
