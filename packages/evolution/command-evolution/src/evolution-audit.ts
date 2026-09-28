/**
 * §18.2 audit trail: what `/skills approve` and `/skills rollback` record into
 * the session that ran them.
 *
 * A promotion and its revert share one record shape because a reader asks the
 * same question of both — which body is live for this skill, and what did it
 * replace — and the skill file itself keeps no history: a revert overwrites the
 * file with the preimage's bytes, so the digests of both bodies are the only
 * durable record of what moved.
 *
 * §28 requires a promotion record to carry the evidence, score, cost,
 * confidence, and rollback preimage it was committed on. The measured half comes
 * from the optimizer's experiment row the staged write was produced by; a
 * promotion of a write no optimizer run staged carries none, and says so by
 * omission rather than by asserting a measurement nobody made.
 * @module @deepseek-ai/dsh-command-evolution/evolution-audit
 */

import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import type { ExperimentRecord } from '@deepseek-ai/dsh-evolution-optimizer'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: declares the §18.2 `evolution/*` Session events and their payloads.
import type {} from '@deepseek-ai/dsh-agent-kernel'
import type { EvolutionEventMetadata, EvolutionTriple, RunId } from '@deepseek-ai/dsh-agent-kernel'

/** The optimizer slice one promotion reads its measured outcome through. */
interface ExperimentLedger {
  /**
   * @param scopeId - scope the run staged into.
   * @param query - the skill the staged write mutates.
   * @returns the scope's recorded experiments, newest first.
   */
  experiments(scopeId: EvolutionScopeId, query: { skill: string }): readonly ExperimentRecord[]
}

/** What one promotion moved a skill body between, and whether it is still live. */
interface PromotionFact {
  readonly skill: string
  readonly state: 'promoted' | 'rolled-back'
  /** Digest of the body that is live after the command. */
  readonly bodySha: string
  /** Digest of the body the command replaced. */
  readonly replacedSha: string
  /** Staged write the command resolved, when it promoted one. */
  readonly stagedId?: string
  /** Why the record exists. */
  readonly reason?: string
}

/** Project one experiment row's measured triple pair, or nothing when it measured none. */
function measuredOf(row: ExperimentRecord | undefined): { body: EvolutionTriple; baseline: EvolutionTriple } | undefined {
  if (row === undefined || row.winner === null || row.baseline === null) return undefined
  return { body: row.winner, baseline: row.baseline }
}

/**
 * Append one promotion or revert to the session that ran the command.
 * @param ctx - plugin context; only the optional optimizer ledger is read.
 * @param session - the invoking session, whose log receives the record.
 * @param scope - scope the staged write belongs to.
 * @param fact - the promotion or revert to record.
 */
function append(ctx: Context, session: Session, scope: EvolutionScopeId, fact: PromotionFact): void {
  const optimizer = ctx.get('evolutionOptimizer') as ExperimentLedger | undefined
  const row = fact.stagedId === undefined
    ? undefined
    : optimizer?.experiments(scope, { skill: fact.skill }).find(entry => entry.stagedId === fact.stagedId)
  const measured = measuredOf(row)
  const metadata: EvolutionEventMetadata = {
    version: 1,
    runId: brandString<RunId>(randomUUID()),
    // Only a human runs these commands, so the operator is the actor.
    actor: 'user',
    timestamp: Date.now(),
    source: 'command-evolution',
    locator: fact.skill,
  }
  const data = {
    skill: fact.skill,
    scopeId: String(scope),
    state: fact.state,
    bodySha: fact.bodySha,
    preimageSha: fact.replacedSha,
    ...fact.stagedId === undefined ? {} : { stagedId: fact.stagedId },
    ...row === undefined ? {} : { evidence: row.evidence },
    ...measured === undefined ? {} : { measured },
    ...row?.confidence == null ? {} : { confidence: row.confidence },
    ...fact.reason === undefined ? {} : { reason: fact.reason },
  }
  if (fact.state === 'promoted') session.append('evolution/promoted', { ...data, metadata })
  else session.append('evolution/rolled-back', { ...data, metadata })
}

/**
 * Record a committed promotion: the body the transaction wrote, the preimage it
 * replaced, and the measurement the promotion was argued from.
 * @param ctx - plugin context carrying the optional optimizer ledger.
 * @param session - the invoking session.
 * @param scope - scope the staged write belongs to.
 * @param input - the skill, the staged write, and the digests of the two bodies the write moved between.
 */
export function recordPromotion(
  ctx: Context,
  session: Session,
  scope: EvolutionScopeId,
  input: {
    readonly skill: string
    readonly stagedId: string
    /** Digest of the body the promotion wrote. */
    readonly bodySha: string
    /** Digest of the body the promotion replaced. */
    readonly replacedSha: string
  },
): void {
  append(ctx, session, scope, {
    skill: input.skill,
    state: 'promoted',
    bodySha: input.bodySha,
    replacedSha: input.replacedSha,
    stagedId: input.stagedId,
  })
}

/**
 * Record a committed revert: the preimage that is live again, the promoted body
 * it replaced, and the revision the restore was recorded as.
 * @param ctx - plugin context carrying the optional optimizer ledger.
 * @param session - the invoking session.
 * @param scope - scope the skill's staged writes belong to.
 * @param input - the skill, the restored preimage, the promoted body it replaced, and the version the restore committed as.
 */
export function recordRollback(
  ctx: Context,
  session: Session,
  scope: EvolutionScopeId,
  input: {
    readonly skill: string
    /** Digest of the preimage that is live again. */
    readonly restoredSha: string
    /** Digest of the promoted body the revert removed. */
    readonly replacedSha: string
    /** Version the restore committed as, which the record names in its reason. */
    readonly restoredVersion: number
  },
): void {
  append(ctx, session, scope, {
    skill: input.skill,
    state: 'rolled-back',
    bodySha: input.restoredSha,
    replacedSha: input.replacedSha,
    reason: `restored the preimage, recorded as revision ${input.restoredVersion}`,
  })
}
