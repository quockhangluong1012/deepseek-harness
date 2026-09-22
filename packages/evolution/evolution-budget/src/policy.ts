/**
 * The §37 allocation policy as one pure decision over recorded candidate
 * evidence: a proven candidate earns the high-potential budget, a measured
 * candidate with nothing novel gets the cheap early-stop screen, a novel
 * unproven one earns the exploration allowance, and everything else takes the
 * standard batch. The evidence bars are deployment choices, so they arrive as
 * arguments and the rule stays unit-testable without a context. No I/O, no
 * domain.
 * @module @deepseek-ai/dsh-evolution-budget/src/policy
 */

import type { PolicyDecision, PolicyThresholds, PooledCandidateInput } from './types.ts'

/**
 * Decide one candidate's allocation class from its recorded evidence. A
 * proven candidate leads whatever else its record says. Otherwise a candidate
 * measured enough to have a verdict and carrying nothing novel is the one
 * early stop is for; a novel candidate keeps its exploration allowance even
 * with a failing record, because a few failures of something unlike anything
 * tried generalize to nothing, which is exactly what exploration budget
 * covers.
 * @param candidate - the candidate's recorded evaluations and novelty.
 * @param thresholds - the deployment's evidence bars.
 * @returns the class, the branch that chose it, and the numbers behind it.
 */
export function policyFor(candidate: PooledCandidateInput, thresholds: PolicyThresholds): PolicyDecision {
  if (candidate.passes >= thresholds.provenPasses) {
    return {
      candidateId: candidate.candidateId,
      candidateClass: 'high-potential',
      branch: 'more-budget',
      reason: `branch more-budget: ${candidate.passes} passes of ${candidate.runs} recorded runs reach the ${thresholds.provenPasses}-pass bar`,
    }
  }
  if (candidate.runs >= thresholds.lowPotentialRuns && candidate.novelty < thresholds.noveltyThreshold) {
    return {
      candidateId: candidate.candidateId,
      candidateClass: 'low-potential',
      branch: 'early-stop',
      reason: `branch early-stop: ${candidate.runs} recorded runs and ${candidate.passes} passes with novelty ${candidate.novelty} below ${thresholds.noveltyThreshold}`,
    }
  }
  if (candidate.novelty >= thresholds.noveltyThreshold) {
    return {
      candidateId: candidate.candidateId,
      candidateClass: 'novel',
      branch: 'exploration-budget',
      reason: `branch exploration-budget: novelty ${candidate.novelty} reaches ${thresholds.noveltyThreshold} without a proven pass`,
    }
  }
  return {
    candidateId: candidate.candidateId,
    candidateClass: 'standard',
    branch: 'standard',
    reason: `branch standard: ${candidate.runs} recorded runs, ${candidate.passes} passes, and novelty ${candidate.novelty} reach no policy bar`,
  }
}
