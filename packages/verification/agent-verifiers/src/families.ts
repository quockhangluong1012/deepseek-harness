/**
 * The `AcceptanceCriterion` families this package answers, as one list a
 * deployment and a reader can both find: a criterion whose family is absent
 * here is claimed by no verifier this plugin ships.
 *
 * @module @deepseek-ai/dsh-agent-verifiers/families
 */

import type { AgentVerifierFamily } from './types.ts'

/**
 * Every family an independent agent decides, in the order the §8.1 list names
 * them. Each is answered by {@link AgentCriterionVerifier} from one subagent
 * report.
 */
export const SUPPORTED_FAMILIES: readonly AgentVerifierFamily[] = ['security', 'browser', 'review']

/**
 * Whether a criterion family is answered by an agent-backed verifier.
 * @param family - the family name a criterion declares.
 * @returns true when this package ships a verifier for it.
 */
export function isAgentVerifierFamily(family: string): family is AgentVerifierFamily {
  return SUPPORTED_FAMILIES.some(supported => supported === family)
}
