/**
 * Public type vocabulary of the novelty-search archive store: one archive
 * entry carrying a behavior descriptor and the novelty it measured against
 * everything the skill had seen before (§31). Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-novelty-search/src/types
 */

/** One archive entry offered for recording. */
export interface NoveltyArchiveInput {
  /** Staged write identity the descriptor was measured for. */
  candidateId: string
  /** Skill the candidate mutates. */
  skill: string
  /** Normalized behavior-descriptor features of the candidate. */
  features: readonly string[]
}

/** One durable novelty-archive entry. */
export interface NoveltyArchiveEntry {
  /** Staged write identity the descriptor was measured for. */
  candidateId: string
  /** Skill the candidate mutates. */
  skill: string
  /** Normalized behavior-descriptor features of the candidate. */
  features: readonly string[]
  /** Archive novelty measured at record time, in 0..1. */
  novelty: number
  /** ISO-8601 instant the entry was recorded. */
  at: string
}
