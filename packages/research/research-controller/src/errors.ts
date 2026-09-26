/**
 * The research controller's failure taxonomy. Every failure names the missing
 * referent, because a stage that cannot run is never skipped silently.
 * @module @deepseek-ai/dsh-research-controller/src/errors
 */

/** Stable codes the research controller reports. */
export type ResearchErrorCode =
  /** No run with that identity exists. */
  | 'run-not-found'
  /** The run's answer was already accepted. */
  | 'run-settled'
  /** A run already exists for this session, or the request contradicts the stage order. */
  | 'stage-out-of-order'
  /** The stage's supplied input is missing, empty, or over its cap. */
  | 'stage-input-invalid'
  /** A stage whose work is a provider's has no provider registered. */
  | 'stage-provider-missing'
  /** The run recorded no observation for the stage that requires one. */
  | 'evidence-missing'
  /** A cite or the review names a claim this run never recorded. */
  | 'claim-missing'
  /** The epistemic review refused the answer; the message lists every violation. */
  | 'review-rejected'
  /** The session has no kernel task contract. */
  | 'task-missing'
  /** The session's kernel task is not a research task. */
  | 'task-class-mismatch'
  /** The call carries no Agent to record against. */
  | 'agent-missing'

/** One research failure, with the stable code and the referent it names. */
export class ResearchError extends Error {
  /** Stable failure code. */
  readonly code: ResearchErrorCode

  /**
   * @param code - stable failure code.
   * @param message - what is missing and what has to provide it.
   */
  constructor(code: ResearchErrorCode, message: string) {
    super(message)
    this.name = 'ResearchError'
    this.code = code
  }
}

/**
 * Whether a value is a research failure.
 * @param error - the caught value.
 * @returns true when the value is a {@link ResearchError}.
 */
export function isResearchError(error: unknown): error is ResearchError {
  return error instanceof ResearchError
}
