/**
 * Digest of the brief's inputs: instructions, lessons, profile, and context
 * items only. Outputs, staged writes, and timestamps never invalidate the
 * injected brief.
 * @module @deepseek-ai/dsh-evolution-memory/src/digest
 */

import { createHash } from 'node:crypto'
import type { EvolutionMemoryRecord } from './types.ts'

/** Fixed digest for an absent record; the injector emits no message for it. */
export const EMPTY_DIGEST = 'empty'

/**
 * Compute the sha1 identity of the brief's inputs.
 * @param record - the stored record, or undefined when absent.
 * @returns `'empty'` when absent, else the hex sha1 of the covered inputs.
 */
export function digestOf(record: EvolutionMemoryRecord | undefined): string {
  if (record === undefined) return EMPTY_DIGEST
  const covered = {
    instructions: record.instructions,
    agentLessons: record.agentLessons,
    userProfile: record.userProfile,
    contextItems: record.contextItems,
  }
  return createHash('sha1').update(JSON.stringify(covered), 'utf8').digest('hex')
}

/**
 * UTF-8 byte length of one string.
 * @param value - the string to measure.
 * @returns its UTF-8 byte length.
 */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Clip text to a UTF-8 budget at a character boundary, so the result is
 * always valid UTF-8 without a trailing replacement character.
 * @param value - the string to clip.
 * @param maxBytes - maximum UTF-8 bytes to retain.
 * @returns the longest leading-characters prefix within budget.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let end = 0
  let bytes = 0
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return value.slice(0, end)
}

/**
 * Capacity charged against `capacityBytes`: instructions + lessons + profile
 * + Σ context item sizes. Outputs and staged writes are excluded.
 * @param record - the stored record, or undefined when absent.
 * @returns charged bytes, or 0 when absent.
 */
export function usedBytesOf(record: EvolutionMemoryRecord | undefined): number {
  if (record === undefined) return 0
  let used = utf8Bytes(record.instructions) + utf8Bytes(record.agentLessons) + utf8Bytes(record.userProfile)
  for (const item of record.contextItems) used += item.sizeBytes
  return used
}
