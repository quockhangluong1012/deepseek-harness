import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SemanticSessionSearchHit,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'

/** Test-only concrete query service for backend-independent behavior. */
export class TestSessionQueryEngine extends SessionQueryEngine {

  override searchSessionsSemantic(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SemanticSessionSearchHit>> {
    // This double models a deployment with no vector channel.
    return Promise.reject(new Error('semantic session search is not supported by this double'))
  }

  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.resolve({ items: [] })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return {
      session: (await this.readSurface(request.sessionId)).session,
      items: [],
    }
  }
}
