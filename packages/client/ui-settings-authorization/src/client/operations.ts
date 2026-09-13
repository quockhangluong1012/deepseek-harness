/**
 * The Host reads and writes the sign-in companion performs, as callbacks built
 * in the plugin body. Cards receive these instead of a context: the outcomes
 * stay in the generated Remote result vocabulary, so the failure codes and
 * Remote namespaces stay in the apply world.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  AuthorizationAttemptView,
  AuthorizationFlowView,
  AuthorizationFramesView,
  AuthorizationStatusView,
  RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'

/** The Host operations the sign-in card and its dialog invoke. */
export interface AuthorizationOperations {
  /**
   * Every registered flow, for deciding whether this card offers a sign-in.
   * @returns the flows, or the refusal.
   */
  list(): Promise<RemoteResult<readonly AuthorizationFlowView[]>>
  /**
   * Whether a stored grant exists for a record.
   * @param key - the credential record as `scope/id`.
   * @returns the stored state, or the refusal.
   */
  status(key: string): Promise<RemoteResult<AuthorizationStatusView>>
  /**
   * Forget the stored grant for a record.
   * @param key - the credential record as `scope/id`.
   * @returns an empty success, or the refusal.
   */
  signOut(key: string): Promise<RemoteResult<void>>
  /**
   * Open an attempt for a record and run its flow in the background.
   * @param key - the credential record as `scope/id`.
   * @param method - which of the flow's methods to run.
   * @returns the attempt to follow, or the refusal.
   */
  begin(key: string, method: string | undefined): Promise<RemoteResult<AuthorizationAttemptView>>
  /**
   * The attempt's conversation after a cursor.
   * @param attemptId - the id `begin` returned.
   * @param cursor - the `next` value of the previous poll, or 0 to read from
   *   the start.
   * @returns the frames after the cursor, or the refusal.
   */
  frames(attemptId: string, cursor: number): Promise<RemoteResult<AuthorizationFramesView>>
  /**
   * Answer one pending prompt.
   * @param attemptId - the id `begin` returned.
   * @param promptId - the id of the prompt frame to answer.
   * @param value - the typed text, or the chosen option's id.
   * @returns an empty success, or the refusal.
   */
  answer(attemptId: string, promptId: string, value: string): Promise<RemoteResult<void>>
  /**
   * Withdraw the attempt running for a record, if any.
   * @param key - the credential record as `scope/id`.
   * @returns an empty success, or the refusal.
   */
  cancel(key: string): Promise<RemoteResult<void>>
}

/**
 * Bind the companion's Host operations to the plugin's own Remote namespace.
 * @param ctx - the page plugin's context, which declares `remote.authorization`
 *   in its own `inject`.
 * @returns the callbacks the card and its dialog are injected with.
 */
export function createAuthorizationOperations(ctx: ClientContext): AuthorizationOperations {
  return {
    list: () => ctx.remote.authorization.list(),
    status: key => ctx.remote.authorization.status(key),
    signOut: key => ctx.remote.authorization.signOut(key),
    begin: (key, method) => ctx.remote.authorization.begin(key, method),
    frames: (attemptId, cursor) => ctx.remote.authorization.frames(attemptId, cursor),
    answer: (attemptId, promptId, value) => ctx.remote.authorization.answer(attemptId, promptId, value),
    cancel: key => ctx.remote.authorization.cancel(key),
  }
}
