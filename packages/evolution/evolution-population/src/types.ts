/**
 * Public type vocabulary of the evolution population store: one candidate
 * record with its generation, parent lineage, measure, and status. Types only
 * — no runtime code.
 * @module @deepseek-ai/dsh-evolution-population/src/types
 */

/** One candidate's standing: staged for approval, then approved or rejected. */
export type PopulationStatus = 'staged' | 'approved' | 'rejected'

/** The measured triple of a staged skill patch. */
export interface PopulationTriple {
  /** Whether the candidate passed its corpus. */
  pass: boolean
  /** Billed tokens the candidate consumed. */
  tokens: number
  /** Median wall time of the candidate's attempts, in milliseconds. */
  wallTimeMs: number
}

/** One durable population candidate. */
export interface PopulationCandidate {
  /** Candidate identity (the staged write id). */
  candidateId: string
  /** Skill the candidate mutates. */
  skill: string
  /** Previous candidate of the same skill, or null for the first generation. */
  parentCandidateId: string | null
  /** Mutation operator that produced the candidate. */
  operator: string
  /** Generation of the skill this candidate belongs to, starting at 1. */
  generation: number
  /** Novelty share the candidate measured, in 0..1. */
  novelty: number
  /** The candidate's measured triple, or null when unmeasured. */
  triple: PopulationTriple | null
  /** Current standing. */
  status: PopulationStatus
  /** ISO-8601 instant the candidate was recorded. */
  at: string
}

/** One candidate offered for recording. */
export interface PopulationRecordInput {
  /** Skill the candidate mutates. */
  skill: string
  /** Candidate identity (the staged write id). */
  candidateId: string
  /** Mutation operator that produced the candidate. */
  operator: string
  /** Novelty share the candidate measured. */
  novelty: number
  /** The candidate's measured triple, or null when unmeasured. */
  triple: PopulationTriple | null
  /** Initial standing. */
  status: PopulationStatus
}
