/**
 * §18.2 audit trail: the two evolution facts an optimization run records into
 * the session that requested it — a candidate body staged for evaluation, and
 * the score one scoring pass measured for it.
 *
 * The trail is best effort by construction. An offline run is attributed to the
 * session id its caller passed, and that session may have been closed by the
 * time the run reaches a candidate; the experiment ledger row is the durable
 * record either way, and this is its session-log twin. A run without a live
 * session records nothing rather than failing: nothing here throws.
 * @module @deepseek-ai/dsh-evolution-optimizer/audit
 */

import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillScore } from '@deepseek-ai/dsh-evolution-scorer'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: declares the §18.2 `evolution/*` Session events and their payloads.
import type {} from '@deepseek-ai/dsh-agent-kernel'
import type { ActorKind, EvolutionEventMetadata, RunId } from '@deepseek-ai/dsh-agent-kernel'
import { digestOf } from './lineage.ts'

/** The live-agent registry slice one run resolves its audit session through. */
interface AgentRegistry {
  /**
   * @param id - session id the run is attributed to.
   * @returns the live agent owning that session, when it is still registered.
   */
  get(id: string): { session: Session } | undefined
}

/**
 * Resolve the session one run's §18.2 events are appended to.
 * @param ctx - host context; only `ctx.agents` is read, when mounted.
 * @param originSessionId - session the run is attributed to.
 * @returns the live session, or undefined when no agent registry is mounted or its session closed.
 */
export function auditSession(ctx: Context, originSessionId: string): Session | undefined {
  const agents = ctx.get('agents') as AgentRegistry | undefined
  return agents?.get(originSessionId)?.session
}

/** One run's §18.2 appends, or the no-op a run without a live session gets. */
export class EvolutionAudit {
  /** Identity this run stamps on every event it writes. */
  private readonly runId: RunId = brandString<RunId>(randomUUID())

  /**
   * @param session - the live session to append to; undefined records nothing.
   */
  constructor(private readonly session: Session | undefined) {}

  /**
   * Record the candidate bodies one mutation produced, before any of them is
   * scored. The body is a complete replacement `SKILL.md` and stays in the
   * skill store, so the event carries the digest the later scores and the
   * promotion join on.
   * @param skill - skill the bodies would replace.
   * @param scopeId - scope the run searched in.
   * @param scenarios - corpus scenarios the candidates are searched on.
   * @param route - provider and model the mutation request ran under.
   * @param bodies - each candidate body with the operator that produced it and its two novelty readings.
   */
  candidates(
    skill: string,
    scopeId: string,
    scenarios: readonly string[],
    route: string,
    bodies: readonly { body: string; operator: string; novelty: number; archiveNovelty: number }[],
  ): void {
    const session = this.session
    if (session === undefined) return
    for (const candidate of bodies) {
      session.append('evolution/candidate', {
        skill,
        scopeId,
        bodySha: digestOf(candidate.body),
        operator: candidate.operator,
        novelty: candidate.novelty,
        archiveNovelty: candidate.archiveNovelty,
        scenarios: [...scenarios],
        route,
        // A body is the mutation model's output; the optimizer only screened it.
        metadata: this.metadata('model', skill),
      })
    }
  }

  /**
   * Record one scoring pass. A candidate is scored more than once — searched,
   * screened, checked against the protected holdout, and confirmed over
   * repeated paired comparisons — so every pass is recorded and the scenario
   * list is what tells a search score from a holdout score.
   * @param body - the body that was scored; the event keeps only its digest.
   * @param scenarios - scenarios the pass scored it on.
   * @param score - the aggregated triple and the per-scenario results behind it.
   */
  evaluated(body: string, scenarios: readonly string[], score: SkillScore): void {
    const session = this.session
    if (session === undefined) return
    session.append('evolution/evaluated', {
      skill: score.skill,
      bodySha: digestOf(body),
      scenarios: [...scenarios],
      pass: score.pass,
      tokens: score.tokens,
      wallTimeMs: score.wallTimeMs,
      scores: score.scores.map(record => ({
        scenario: record.scenario,
        pass: record.pass,
        tokens: record.tokens,
        wallTimeMs: record.wallTimeMs,
        fixtureDigest: record.fixtureDigest,
        trajectory: record.trajectory,
      })),
      // The triple was measured by the fresh-process scenario runs, not chosen.
      metadata: this.metadata('tool', score.skill),
    })
  }

  /**
   * The audit envelope every §18.2 event from this run carries.
   * @param actor - who caused the fact.
   * @param locator - the skill the fact is about.
   * @returns the envelope.
   */
  private metadata(actor: ActorKind, locator: string): EvolutionEventMetadata {
    return {
      version: 1,
      runId: this.runId,
      actor,
      timestamp: Date.now(),
      source: 'evolution-optimizer',
      locator,
    }
  }
}
