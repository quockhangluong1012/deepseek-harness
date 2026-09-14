/**
 * Durable extracted-fact vocabulary for a scope's lessons: one artifact per
 * fact, with the provenance and quality metadata the evolutionary-harness
 * specification requires of long-term memory.
 * @module @deepseek-ai/dsh-evolution-memory/lesson-artifact
 */

import z from 'zod'

/** Whether an artifact came from a fact, a direct observation, or a model inference. */
export type LessonEvidenceKind = 'fact' | 'observation' | 'inference'

/** Scope an artifact's statement applies at, independent of which record stores it. */
export type LessonArtifactScope = 'user' | 'project' | 'global'

/** Policy applied when a candidate statement matches an existing artifact closely enough to need one. */
export type LessonMergeStrategy = 'overwrite' | 'merge' | 'keep_both'

/** One durable extracted fact in a scope's lessons. */
export interface LessonArtifact {
  /** Stable identity derived from the normalized statement at creation. */
  id: string
  /** Short, clear, actionable statement of the fact. */
  statement: string
  /** Conversation or task the fact was drawn from: a session id, or a label for a manually staged entry. */
  source: string
  /** When this fact applies. */
  conditions: string
  /** Whether it is a fact, a direct observation, or a model inference. */
  evidence: LessonEvidenceKind
  /** Confidence in [0, 1]. */
  confidence: number
  /** Times a later extraction confirmed this fact. */
  validationCount: number
  /** Times a later extraction contradicted this fact. */
  refutationCount: number
  /** Scope this applies at. */
  scope: LessonArtifactScope
  /** Days without confirmation before decay may prune this artifact; absent never expires by age. */
  ttlDays?: number
  /** ISO-8601 creation instant. */
  createdAt: string
  /** ISO-8601 instant of the last validation, refutation, or edit. */
  updatedAt: string
}

/**
 * Caller-supplied fields of a new artifact. Identity, counters, and timestamps
 * are assigned by the store, never by a caller or a model.
 */
export type LessonArtifactInput = Omit<
  LessonArtifact,
  'id' | 'validationCount' | 'refutationCount' | 'createdAt' | 'updatedAt'
>

/** Readable artifact fields a caller may change on an existing artifact. */
export type LessonArtifactPatch = Partial<
  Pick<LessonArtifact, 'statement' | 'conditions' | 'confidence' | 'evidence' | 'ttlDays'>
>

/**
 * Zod's optional output admits an explicit `undefined`, which
 * `exactOptionalPropertyTypes` makes a distinct type from `ttlDays?: number`.
 * Schemas annotate with this so their parsed output matches the declaration.
 */
type OptionalTtl<T> = Omit<T, 'ttlDays'> & { ttlDays?: number | undefined }

const evidenceKind = z.enum(['fact', 'observation', 'inference'])
const artifactScope = z.enum(['user', 'project', 'global'])

/** Durable shape of one lesson artifact. */
export const lessonArtifact: z.ZodType<OptionalTtl<LessonArtifact>> = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  source: z.string(),
  conditions: z.string(),
  evidence: evidenceKind,
  confidence: z.number().min(0).max(1),
  validationCount: z.number().int().min(0),
  refutationCount: z.number().int().min(0),
  scope: artifactScope,
  ttlDays: z.number().int().min(1).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** Durable shape of a caller-supplied new artifact. */
export const lessonArtifactInput: z.ZodType<OptionalTtl<LessonArtifactInput>> = z.object({
  statement: z.string().min(1),
  source: z.string(),
  conditions: z.string(),
  evidence: evidenceKind,
  confidence: z.number().min(0).max(1),
  scope: artifactScope,
  ttlDays: z.number().int().min(1).optional(),
})

/**
 * Normalize a statement so two spellings of the same fact key alike:
 * lowercased, internal whitespace collapsed, trimmed.
 * @param statement - the raw statement text.
 * @returns the normalized form used for identity and exact-equality dedupe.
 */
export function normalizeStatement(statement: string): string {
  return statement.toLowerCase().replaceAll(/\s+/g, ' ').trim()
}

/**
 * Derive an artifact's stable identity from its statement.
 * @param statement - the raw statement text.
 * @returns the normalized statement, which is itself the identity.
 */
export function artifactKey(statement: string): string {
  return normalizeStatement(statement)
}

/**
 * Admit a legacy free-text lessons document as one coarse artifact, so a
 * record written before the artifact model opens and reads without blocking.
 * The heartbeat maintenance task later refines it into discrete artifacts.
 * @param text - the stored legacy document.
 * @param now - ISO-8601 instant to stamp.
 * @returns one artifact, or none when the document is blank.
 */
export function wrapLegacyLessons(text: string, now: string): LessonArtifact[] {
  if (text.trim().length === 0) return []
  return [{
    id: artifactKey(text),
    statement: text,
    source: 'migration-pending',
    conditions: '',
    evidence: 'inference',
    confidence: 0.5,
    validationCount: 0,
    refutationCount: 0,
    scope: 'project',
    createdAt: now,
    updatedAt: now,
  }]
}
