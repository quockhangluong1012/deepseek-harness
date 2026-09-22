/**
 * Public type vocabulary of the controlled self-model: a durable per-skill
 * capability record — strengths, weaknesses, uncertain areas, failure modes,
 * preferred tools, evaluator blindspots — plus the per-capability pass-rate
 * entries that feed the weakest-first frontier saying what to learn next
 * (§42, §33). Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-self-model/src/types
 */

/** One skill's durable self-assessment. */
export interface SelfModel {
  /** Skill the assessment describes. */
  skill: string
  /** Capabilities the skill already demonstrates. */
  strengths: string[]
  /** Capabilities the skill measurably lacks. */
  weaknesses: string[]
  /** Capabilities with too little evidence to judge either way. */
  uncertainAreas: string[]
  /** How the skill tends to fail when it fails. */
  failureModes: string[]
  /** Tools the skill reaches for first. */
  preferredTools: string[]
  /** Evaluation gaps the skill's evaluators do not cover. */
  evaluatorBlindspots: string[]
  /** How much the skill trusts this assessment, from 0 to 1. */
  confidence: number
  /** Revision tick of the assessment, starting at 1. */
  revision: number
  /** ISO-8601 instant the assessment was recorded. */
  at: string
}

/** One self-assessment offered for recording. */
export interface SelfModelInput {
  /** Skill the assessment describes. */
  skill: string
  /** Capabilities the skill already demonstrates. */
  strengths: string[]
  /** Capabilities the skill measurably lacks. */
  weaknesses: string[]
  /** Capabilities with too little evidence to judge either way. */
  uncertainAreas: string[]
  /** How the skill tends to fail when it fails. */
  failureModes: string[]
  /** Tools the skill reaches for first. */
  preferredTools: string[]
  /** Evaluation gaps the skill's evaluators do not cover. */
  evaluatorBlindspots: string[]
  /** How much the skill trusts this assessment, from 0 to 1. */
  confidence: number
}

/** One capability observation offered for recording. */
export interface CapabilityObservation {
  /** Capability the observation measures. */
  capability: string
  /** Skill whose attempt produced the observation. */
  skill: string
  /** Whether the attempt passed. */
  pass: boolean
  /** What went wrong, present only on informative failures. */
  failure?: string
}

/** One capability's durable pass-rate entry. */
export interface CapabilityEntry {
  /** Capability the entry measures. */
  capability: string
  /** Running pass rate of the recorded observations, from 0 to 1. */
  score: number
  /** How much evidence backs the score, from 0 to 1. */
  confidence: number
  /** Newest-first failure notes, capped at the configured count. */
  failures: string[]
  /** Skills that have attempted the capability, in first-seen order. */
  coveringSkills: string[]
  /** Number of recorded observations. */
  observations: number
  /** ISO-8601 instant of the latest observation. */
  at: string
}

/** One weakest-first frontier row saying what to learn next. */
export interface FrontierGap {
  /** Capability the gap names. */
  capability: string
  /** The capability's running pass rate, from 0 to 1. */
  score: number
  /** How much evidence backs the score, from 0 to 1. */
  confidence: number
  /** Skills that have attempted the capability, in first-seen order. */
  coveringSkills: string[]
  /** Number of recorded observations. */
  observations: number
}
