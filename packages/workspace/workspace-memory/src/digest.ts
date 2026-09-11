/**
 * Digest of the brief's inputs: instructions, memory, and context items only.
 * Description, outputs, and timestamps never invalidate the injected brief.
 * @module @deepseek-ai/dsh-workspace-memory/src/digest
 */

import { createHash } from 'node:crypto'
import type { WorkspaceMemoryRecord } from './types.ts'

/** Fixed digest for an absent record; the injector emits no message for it. */
export const EMPTY_DIGEST = 'empty'

/**
 * Compute the sha1 identity of the brief's inputs.
 * @param record - the stored record, or undefined when absent.
 * @returns `'empty'` when absent, else the hex sha1 of the covered inputs.
 */
export function digestOf(record: WorkspaceMemoryRecord | undefined): string {
  if (record === undefined) return EMPTY_DIGEST
  const covered = {
    instructions: record.instructions,
    memory: record.memory,
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
 * Capacity charged against `capacityBytes`: instructions + memory +
 * Σ context item sizes. Description and outputs are excluded.
 * @param record - the stored record, or undefined when absent.
 * @returns charged bytes, or 0 when absent.
 */
export function usedBytesOf(record: WorkspaceMemoryRecord | undefined): number {
  if (record === undefined) return 0
  let used = utf8Bytes(record.instructions) + utf8Bytes(record.memory)
  for (const item of record.contextItems) used += item.sizeBytes
  return used
}
