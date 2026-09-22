/**
 * Pure helpers for the canary deployment store: the rollout ladder and its
 * transitions. No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-canary/src/stages
 */

import type { DeploymentState } from './types.ts'

/** The rollout states, ladder first then the two exit states. */
export const DEPLOYMENT_STATES = [
  'shadow',
  'canary',
  'promoted',
  'rolled-back',
  'rejected',
] as const satisfies readonly DeploymentState[]

/** Legal transitions: the ladder shadow → canary → promoted, plus the two
 * exits from the staged rollouts; terminal states never leave. */
const TRANSITIONS: Readonly<Record<DeploymentState, readonly DeploymentState[]>> = {
  shadow: ['canary', 'rejected'],
  canary: ['promoted', 'rolled-back'],
  promoted: [],
  'rolled-back': [],
  rejected: [],
}

/**
 * The next rollout stage on the ladder, or null when a state has none.
 * @param state - current deployment state.
 * @returns the next ladder stage, or null.
 */
export function nextStage(state: DeploymentState): DeploymentState | null {
  if (state === 'shadow') return 'canary'
  if (state === 'canary') return 'promoted'
  return null
}

/**
 * Whether one state may move to another. The ladder advances one step per
 * roll forward; each staged rollout may also exit to its terminal state.
 * @param from - current deployment state.
 * @param to - requested state.
 * @returns whether the transition is legal.
 */
export function transitionAllowed(from: DeploymentState, to: DeploymentState): boolean {
  return TRANSITIONS[from].includes(to)
}
