/**
 * Durable extracted-fact vocabulary for a scope's lessons: one artifact per
 * fact, with the provenance and quality metadata the evolutionary-harness
 * specification requires of long-term memory.
 * @module @deepseek-ai/dsh-evolution-memory/lesson-artifact
 */

import { SENSITIVE_PLACEHOLDER, DEFAULT_SENSITIVE_PATTERNS } from '@deepseek-ai/dsh-session-telemetry/src/sensitive.ts'
import { z } from 'zod'

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
  ttlDays?: number | undefined
  /** ISO-8601 creation instant. */
  createdAt: string
  /** ISO-8601 instant of the last validation, refutation, or edit. */
  updatedAt: string
  /**
   * What the fact was drawn from: session ids, artifact paths, or tool-result
   * digests. Absent on records written before admission required a source.
   */
  sourceRefs?: readonly string[] | undefined
  /** Runs whose trajectories produced the fact, when any. */
  trajectoryRefs?: readonly string[] | undefined
  /**
   * What the fact earned when it was surfaced: how often it reached a task's
   * compiled context and how those tasks ended. Absent until it is surfaced.
   */
  utility?: UtilityEstimate | undefined
  /**
   * Statements this artifact replaced, oldest first. A contradiction that
   * corrects a fact keeps the old wording here instead of deleting it, so a
   * refuted value is answered by its replacement rather than lost.
   */
  supersedes?: readonly LessonSupersession[] | undefined
  /** Where the artifact came from and what it was derived from. */
  lineage?: LessonLineage | undefined
  /** Content a promotion could restore, so a promoted fact can be rolled back. */
  rollbackPreimage?: string | undefined
  /**
   * How far the fact's content may be trusted. An `untrusted` artifact is
   * derived from content nobody vouched for (repository text, tool output, a
   * fetched page, MCP content), so it enters the store only through staging,
   * where a human or a policy decides. Absent reads as `unknown`, which the
   * direct write path still admits for records written before this field.
   */
  trust?: LessonTrust | undefined
}

/** How far the content behind one artifact may be trusted. */
export type LessonTrust = 'trusted' | 'untrusted' | 'unknown'

/**
 * What one surfaced fact earned: how often it was placed into a task's
 * compiled context, and how those tasks ended.
 */
export interface UtilityEstimate {
  /** Times the fact was surfaced into a task's compiled context. */
  surfaced: number
  /** Surfaced tasks that verified successfully. */
  passingTasks: number
  /** Surfaced tasks that failed verification. */
  failingTasks: number
  /** `(passingTasks + 1) / (passingTasks + failingTasks + 2)`, the Laplace estimate. */
  value: number
}

/** One statement a later contradiction replaced. */
export interface LessonSupersession {
  /** The statement that no longer stands. */
  statement: string
  /** Confidence the superseded statement carried. */
  confidence: number
  /** ISO-8601 instant the contradiction landed. */
  supersededAt: string
}

/** Where one artifact came from and what it was derived from. */
export interface LessonLineage {
  /** The run, session, or manual entry that produced the artifact. */
  origin: string
  /** Identities of the artifacts this one was derived from, when any. */
  derivedFrom?: readonly string[] | undefined
}

/**
 * The utility value S8 defines for an estimate's counters.
 * @param passingTasks - surfaced tasks that verified successfully.
 * @param failingTasks - surfaced tasks that failed verification.
 * @returns the Laplace estimate, 0.5 for a fact that has never been surfaced.
 */
export function utilityValue(passingTasks: number, failingTasks: number): number {
  return (passingTasks + 1) / (passingTasks + failingTasks + 2)
}

/**
 * Fold one recalled outcome into a fact's utility estimate. The value is always
 * recomputed from the counters, so a reader never sees a value that disagrees
 * with the outcomes behind it.
 * @param utility - the estimate so far, when the fact was surfaced before.
 * @param outcome - how the task that received the fact ended.
 * @returns the estimate covering this recall as well.
 */
export function rememberOutcome(
  utility: UtilityEstimate | undefined,
  outcome: 'ok' | 'failed',
): UtilityEstimate {
  const passingTasks = (utility?.passingTasks ?? 0) + (outcome === 'ok' ? 1 : 0)
  const failingTasks = (utility?.failingTasks ?? 0) + (outcome === 'failed' ? 1 : 0)
  return {
    surfaced: (utility?.surfaced ?? 0) + 1,
    passingTasks,
    failingTasks,
    value: utilityValue(passingTasks, failingTasks),
  }
}

/**
 * Caller-supplied fields of a new artifact. Identity, counters, and timestamps
 * are assigned by the store, never by a caller or a model.
 */
export type LessonArtifactInput = Omit<
  LessonArtifact,
  'id' | 'validationCount' | 'refutationCount' | 'createdAt' | 'updatedAt'
>

/**
 * Readable artifact fields a caller may change on an existing artifact. A
 * changed statement is a different fact, so it is expressed as a remove plus
 * an add rather than a patch: an artifact's identity is derived from its
 * statement, and a patch never moves either.
 */
export type LessonArtifactPatch = Partial<
  Pick<LessonArtifact, 'conditions' | 'confidence' | 'evidence' | 'ttlDays'>
>

const evidenceKind = z.enum(['fact', 'observation', 'inference'])
const artifactScope = z.enum(['user', 'project', 'global'])

/** Durable shape of one lesson artifact. */
export const lessonArtifact: z.ZodType<LessonArtifact> = z.object({
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
  sourceRefs: z.array(z.string().min(1)).optional(),
  trajectoryRefs: z.array(z.string().min(1)).optional(),
  utility: z.object({
    surfaced: z.number().int().min(0),
    passingTasks: z.number().int().min(0),
    failingTasks: z.number().int().min(0),
    value: z.number().min(0).max(1),
  }).optional(),
  supersedes: z.array(z.object({
    statement: z.string().min(1),
    confidence: z.number().min(0).max(1),
    supersededAt: z.string(),
  })).optional(),
  lineage: z.object({
    origin: z.string().min(1),
    derivedFrom: z.array(z.string().min(1)).optional(),
  }).optional(),
  rollbackPreimage: z.string().optional(),
  trust: z.enum(['trusted', 'untrusted', 'unknown']).optional(),
})

/** Durable shape of a caller-supplied new artifact. */
export const lessonArtifactInput: z.ZodType<LessonArtifactInput> = z.object({
  statement: z.string().min(1),
  source: z.string(),
  conditions: z.string(),
  evidence: evidenceKind,
  confidence: z.number().min(0).max(1),
  scope: artifactScope,
  ttlDays: z.number().int().min(1).optional(),
  trust: z.enum(['trusted', 'untrusted', 'unknown']).optional(),
  sourceRefs: z.array(z.string().min(1)).optional(),
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
 * Scrub credentials from text that is about to become durable memory — an
 * artifact's statement, its conditions, or the label it was drawn from. A
 * secret that reached an extraction is not a lesson, and a stored one would be
 * replayed into every later brief, so it is replaced before the write.
 * @param text - the text a caller or a model supplied.
 * @returns the same text with every recognized credential shape replaced.
 */
export function scrubArtifactText(text: string): string {
  let scrubbed = text
  for (const { pattern } of DEFAULT_SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0
    scrubbed = scrubbed.replace(pattern, SENSITIVE_PLACEHOLDER)
  }
  return scrubbed
}

/**
 * Refuse a direct write of an artifact whose own content is untrusted. Taint
 * propagates to what is derived from it, and such a fact enters a long-term
 * store only through staging, where a human or a policy answers for it.
 * @param candidate - the artifact a caller is about to store.
 * @throws When the candidate declares its content untrusted.
 */
export function assertDirectlyAdmissible(candidate: LessonArtifactInput): void {
  if (candidate.trust === 'untrusted') {
    throw new Error(
      'evolution-memory: an artifact derived from untrusted content is not admissible directly; '
      + `stage the write for approval instead (statement ${JSON.stringify(candidate.statement)})`,
    )
  }
  const issues = admissionIssues(candidate)
  if (issues.length > 0) {
    throw new Error(
      `evolution-memory: artifact is not admissible as durable learning — ${issues.join('; ')} `
      + `(statement ${JSON.stringify(candidate.statement)})`,
    )
  }
}

/**
 * Why one candidate is not admissible as durable learning. A generic transcript
 * summary that names no source is not admissible (spec §9.2); a candidate that
 * names its source is, because the store supplies the expiry policy and the
 * utility that later recall updates.
 * @param candidate - the artifact a caller is about to store.
 * @returns the reasons, empty when the candidate may be admitted.
 */
export function admissionIssues(candidate: LessonArtifactInput): string[] {
  return candidate.sourceRefs === undefined || candidate.sourceRefs.length === 0
    ? ['it names no source reference']
    : []
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
