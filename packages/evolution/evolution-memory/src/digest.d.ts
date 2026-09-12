/**
 * Digest of the brief's inputs: instructions, lessons, profile, and context
 * items only. Outputs, staged writes, and timestamps never invalidate the
 * injected brief.
 * @module @deepseek-ai/dsh-evolution-memory/src/digest
 */
import type { EvolutionMemoryRecord } from './types.ts';
/** Fixed digest for an absent record; the injector emits no message for it. */
export declare const EMPTY_DIGEST = "empty";
/**
 * Compute the sha1 identity of the brief's inputs.
 * @param record - the stored record, or undefined when absent.
 * @returns `'empty'` when absent, else the hex sha1 of the covered inputs.
 */
export declare function digestOf(record: EvolutionMemoryRecord | undefined): string;
/**
 * UTF-8 byte length of one string.
 * @param value - the string to measure.
 * @returns its UTF-8 byte length.
 */
export declare function utf8Bytes(value: string): number;
/**
 * Clip text to a UTF-8 budget at a character boundary, so the result is
 * always valid UTF-8 without a trailing replacement character.
 * @param value - the string to clip.
 * @param maxBytes - maximum UTF-8 bytes to retain.
 * @returns the longest leading-characters prefix within budget.
 */
export declare function truncateUtf8(value: string, maxBytes: number): string;
/**
 * Capacity charged against `capacityBytes`: instructions + lessons + profile
 * + Σ context item sizes. Outputs and staged writes are excluded.
 * @param record - the stored record, or undefined when absent.
 * @returns charged bytes, or 0 when absent.
 */
export declare function usedBytesOf(record: EvolutionMemoryRecord | undefined): number;
//# sourceMappingURL=digest.d.ts.map