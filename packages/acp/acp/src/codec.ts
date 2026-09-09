/**
 * Pure translation between the harness lifecycle and the automation-only ACP wire.
 * @module @deepseek-ai/dsh-acp/codec
 */

import type { StopReason } from '@agentclientprotocol/sdk'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/**
 * Map a harness turn ending to ACP's terminal reason vocabulary.
 * @param reason - harness turn outcome.
 * @returns the closest legal ACP stop reason.
 */
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    // A per-turn step ceiling bounds model requests like a request cap.
    case 'max-steps':
      return 'max_turn_requests'
    // `cancelled` is reserved for explicit client cancellation (`session/cancel`)
    // and disposal, both settled out of band; a turn aborted by a hook or
    // another owner is ordinary quiescence and reports `end_turn`.
    case 'aborted':
      return 'end_turn'
    case 'interrupted':
      return 'cancelled'
    case 'blocked':
    case 'error':
      return 'end_turn'
    /* v8 ignore next 2 -- TurnEndReasonMap is merge-extensible, so a backend-added
     * variant cannot be listed; unknown endings report ordinary quiescence. */
    default:
      return 'end_turn'
  }
}
