/** Minimal concrete Session query for continuation and catalog integration tests. */

import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type {
  SessionSearchExecContext,
  SemanticSessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'

/** Session query implementation whose search faces are outside these tests. */
export class TestSessionQuery extends SessionQueryEngine {

  override searchSessionsSemantic(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SemanticSessionSearchHit>> {
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
