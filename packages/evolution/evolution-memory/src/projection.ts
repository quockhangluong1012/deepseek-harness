/**
 * The model-facing projection of one scope's evolution memory: the current
 * facts and documents a brief renders, derived from the durable ledger record
 * on every read. The projection is a read model, not a second store — the
 * ledger stays the source of truth — and it never carries state the record
 * dropped: a superseded statement survives only as the history of the current
 * fact that replaced it.
 *
 * Every field a record may omit is materialized here, so a consumer compares
 * current values instead of absences: a fact with no stored status reads as a
 * `candidate`, one with no recorded trust reads as `unknown`, and the instants,
 * utility, supersessions, and conflict a fact never earned read as `null` or
 * empty.
 * @module @deepseek-ai/dsh-evolution-memory/projection
 */

import { digestOf, usedBytesOf } from './digest.ts'
import { lifecycleOf } from './lifecycle.ts'
import type { LessonConflict } from './conflict.ts'
import type { LessonLifecycle } from './lifecycle.ts'
import type {
  LessonArtifact,
  LessonArtifactScope,
  LessonEvidenceKind,
  LessonSupersession,
  LessonTrust,
  UtilityEstimate,
} from './lesson-artifact.ts'
import type { EvolutionContextItem, EvolutionMemoryRecord, EvolutionScopeId } from './types.ts'

/** One current fact as the projection presents it: never absent, never unknown. */
export interface MemoryFact {
  /** The fact's stable identity. */
  id: string
  /** The statement that currently stands, never a superseded one. */
  statement: string
  /** When the fact applies. */
  conditions: string
  /** Confidence in [0, 1]. */
  confidence: number
  /** Whether the fact is a fact, a direct observation, or an inference. */
  evidence: LessonEvidenceKind
  /** Scope the fact applies at. */
  scope: LessonArtifactScope
  /** The session or label the fact was drawn from. */
  source: string
  /** How far the content may be trusted; `unknown` when the record stored none. */
  trust: LessonTrust
  /** Status in the memory lifecycle; `candidate` when the record stored none. */
  lifecycle: LessonLifecycle
  /** ISO-8601 instant of the last validation, or null when the fact was never validated. */
  lastValidatedAt: string | null
  /** What the fact earned when it was surfaced, or null when it never was. */
  utility: UtilityEstimate | null
  /** Statements this fact replaced, oldest first. */
  supersedes: readonly LessonSupersession[]
  /** The last conflict the fact was party to, or null when it never was. */
  conflict: LessonConflict | null
}

/**
 * One scope's current memory as the model-facing brief reads it. Outputs,
 * staged writes, episodic notes, and the recall ledger are absent by design:
 * they are consolidation material and bookkeeping, never the curated state a
 * brief renders.
 */
export interface MemoryProjection {
  /** Scope the projection was derived from. */
  scopeId: EvolutionScopeId
  /** Digest of the covered ledger inputs, the identity a rendered brief is superseded by. */
  digest: string
  /** Bytes the record charges against the scope capacity. */
  usedBytes: number
  /** Capacity the bytes are measured against. */
  capacityBytes: number
  /** Current facts, in stored order. */
  facts: readonly MemoryFact[]
  /** Current user-authored instructions. */
  instructions: string
  /** Current user profile document. */
  profile: string
  /** Attached context, newest last. */
  contextItems: readonly EvolutionContextItem[]
}

/**
 * Project one durable artifact into its current-state fact. Every field a
 * record may omit is materialized, so a consumer compares current values
 * instead of absences.
 * @param artifact - the durable artifact to project.
 * @returns the current-state fact.
 */
export function toMemoryFact(artifact: LessonArtifact): MemoryFact {
  return {
    id: artifact.id,
    statement: artifact.statement,
    conditions: artifact.conditions,
    confidence: artifact.confidence,
    evidence: artifact.evidence,
    scope: artifact.scope,
    source: artifact.source,
    trust: artifact.trust ?? 'unknown',
    lifecycle: lifecycleOf(artifact),
    lastValidatedAt: artifact.lastValidatedAt ?? null,
    utility: artifact.utility ?? null,
    supersedes: artifact.supersedes ?? [],
    conflict: artifact.conflict ?? null,
  }
}

/**
 * Project one durable record into its current-state projection.
 * @param record - the durable record to project.
 * @param scopeId - the scope the record belongs to.
 * @param capacityBytes - the scope's configured capacity ceiling.
 * @returns the current-state projection.
 */
export function projectEvolutionMemory(
  record: EvolutionMemoryRecord,
  scopeId: EvolutionScopeId,
  capacityBytes: number,
): MemoryProjection {
  return {
    scopeId,
    digest: digestOf(record),
    usedBytes: usedBytesOf(record),
    capacityBytes,
    facts: record.agentLessons.map(toMemoryFact),
    instructions: record.instructions,
    profile: record.userProfile,
    contextItems: record.contextItems.map(item => ({ ...item })),
  }
}
