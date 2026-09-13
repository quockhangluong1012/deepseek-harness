/** Minimal concrete Session query for tests that exercise only corpus and point reads. */

import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type {
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'

/** Session query implementation whose search faces are intentionally unavailable. */
export class TestSessionQuery extends SessionQueryEngine {

  override searchSessionsSemantic(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    // This double models a deployment with no vector channel.
    return Promise.reject(new Error('semantic session search is not supported by this double'))
  }

  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}
