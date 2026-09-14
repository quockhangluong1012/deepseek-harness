/**
 * Lesson decisions: the vocabulary one extraction pass reports back about a
 * scope's current artifacts — `confirms`, `contradicts`, or `new` — and the
 * pure fold that applies a whole batch to one record in the order it was
 * reported.
 *
 * A `new` decision still goes through the store's merge-by-meaning add path,
 * so a candidate the model called new that coincides with an artifact outside
 * the list it was shown folds into that artifact instead of accumulating
 * beside it. This module also owns the artifact-application primitives that
 * fold shares with the store's own write paths, so the decision vocabulary
 * stays importable without the store's module body.
 * @module @deepseek-ai/dsh-evolution-memory/decisions
 */

import { z } from 'zod'
import { artifactKey, lessonArtifact, lessonArtifactInput, normalizeStatement } from './lesson-artifact.ts'
import type { LessonArtifact, LessonArtifactInput, LessonMergeStrategy } from './lesson-artifact.ts'
import { mergeArtifact } from './merge.ts'
import type { EvolutionMemoryRecord } from './types.ts'

/**
 * One decision one extraction pass reports for one durable fact: it confirms
 * an existing artifact, contradicts one — optionally correcting its statement
 * or confidence — or carries a fact none of the listed artifacts covers.
 *
 * A decision addresses an existing artifact by id, never by an index: an
 * ordinal belongs to the artifact list one prompt showed the model, so the
 * caller resolves it back to an id before a decision reaches this module or a
 * staged payload.
 */
export type LessonDecision =
  | { kind: 'confirms'; artifactId: string }
  | { kind: 'contradicts'; artifactId: string; statement?: string | undefined; confidence?: number | undefined }
  | { kind: 'new'; candidate: LessonArtifactInput; strategy?: LessonMergeStrategy | undefined }

/** One contradiction, the member of {@link LessonDecision} that corrects an artifact. */
type ContradictsDecision = Extract<LessonDecision, { kind: 'contradicts' }>

/** Merge strategies a `new` decision may ask for; absent means `keep_both`. */
const mergeStrategy = z.enum(['overwrite', 'merge', 'keep_both'])

/**
 * Artifact text at the decision boundary: non-empty, and not blank once
 * normalized, so a corrected statement cannot land as an artifact nobody can
 * key or read.
 */
const statementText = z.string().min(1).refine(statement => normalizeStatement(statement).length > 0, {
  message: 'artifact statement is blank once normalized',
})

/**
 * Validated shape of one lesson decision: the store-facing counterpart of the
 * model's index-addressed decisions, addressed by artifact id.
 */
export const lessonDecision: z.ZodType<LessonDecision> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('confirms'),
    artifactId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('contradicts'),
    artifactId: z.string().min(1),
    statement: statementText.optional(),
    confidence: z.number().min(0).max(1).optional(),
  }),
  z.object({
    kind: z.literal('new'),
    candidate: lessonArtifactInput,
    strategy: mergeStrategy.optional(),
  }),
])

/**
 * Derive the identity a candidate stores under, refusing a statement that
 * normalizes away to nothing. An empty identity is not merely useless: it
 * would persist a record the artifact schema rejects, and the next open of the
 * domain would refuse the whole store.
 * @param candidate - validated caller-supplied artifact fields.
 * @returns the non-empty identity.
 */
export function artifactIdOf(candidate: LessonArtifactInput): string {
  const id = artifactKey(candidate.statement)
  if (id.length === 0) {
    throw new Error(
      `evolution-memory: artifact statement ${JSON.stringify(candidate.statement)} is blank once normalized and cannot key an artifact`,
    )
  }
  return id
}

/**
 * Build one stored artifact from a validated candidate, assigning the fields
 * no caller supplies.
 * @param candidate - validated caller-supplied artifact fields.
 * @param id - identity the artifact stores under.
 * @param now - ISO-8601 instant to stamp as both instants.
 * @param defaultTtlDays - ttl to give the artifact when the candidate carries none.
 * @returns the artifact with its store-assigned identity, counters, and instants.
 */
export function freshArtifact(candidate: LessonArtifactInput, id: string, now: string, defaultTtlDays: number): LessonArtifact {
  return {
    ...structuredClone(candidate),
    id,
    ttlDays: candidate.ttlDays ?? defaultTtlDays,
    validationCount: 0,
    refutationCount: 0,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Add one candidate to a record's artifacts. A candidate whose identity is
 * already present stores nothing under `keep_both`, because a second artifact
 * with the same identity cannot be told apart from the first; under any other
 * strategy the artifact `pickMergeTarget` selected absorbs the candidate. A
 * candidate with no selected target becomes its own artifact.
 *
 * `target` was selected outside the write chain, from the record as it read
 * before the similarity lookup awaited, so the artifact it names is resolved
 * again here against the record actually being written: a concurrent write can
 * have changed the matched artifact or removed it entirely. A removed match
 * falls back to the candidate's own identity and then, absent both, to a fresh
 * artifact, so a candidate is never dropped by a write that reports success.
 * @param record - current record value.
 * @param candidate - validated caller-supplied artifact fields.
 * @param strategy - how the candidate folds into a selected artifact.
 * @param target - the artifact selected for this candidate outside the write
 * chain; undefined when nothing matched closely enough.
 * @param now - ISO-8601 instant to stamp.
 * @param defaultTtlDays - ttl a new artifact is given when the candidate carries none.
 * @returns the candidate record without the family stamp, or `record` itself
 * when the add stores nothing.
 */
export function addArtifactTo(
  record: EvolutionMemoryRecord,
  candidate: LessonArtifactInput,
  strategy: LessonMergeStrategy,
  target: LessonArtifact | undefined,
  now: string,
  defaultTtlDays: number,
): EvolutionMemoryRecord {
  const id = artifactIdOf(candidate)
  const matched = record.agentLessons.find(artifact => artifact.id === target?.id)
    ?? record.agentLessons.find(artifact => artifact.id === id)
    // A `contradicts` decision can correct an artifact's statement while the
    // artifact keeps the id it is addressed by, so the id and the normalized
    // statement part company. Matching the statement as well keeps a later
    // candidate spelling that statement from being stored as a twin — and does
    // so without depending on the embeddings seam, which a similarity-only
    // match would.
    ?? record.agentLessons.find(artifact => artifactKey(artifact.statement) === id)
  if (matched === undefined) {
    return { ...record, agentLessons: [...record.agentLessons, freshArtifact(candidate, id, now, defaultTtlDays)] }
  }
  if (strategy === 'keep_both') return record
  const merged = mergeArtifact(matched, candidate, strategy, now)
  return { ...record, agentLessons: record.agentLessons.map(artifact => artifact.id === matched.id ? merged : artifact) }
}

/**
 * Bump one existing artifact's validation counter and refresh its instant.
 * Identity, statement, content, and the other counters never change: a
 * confirmation is evidence for the fact already stored, not a new fact.
 *
 * A decision naming an artifact the record no longer holds is skipped rather
 * than refused: a prune can land between the resolution that produced the
 * decision and the write that applies it, and the rest of the batch still
 * applies.
 * @param record - current record value.
 * @param artifactId - the addressed artifact.
 * @param now - ISO-8601 instant to stamp.
 * @returns the candidate record without the family stamp, or `record` itself
 * when the artifact is gone.
 */
function confirmArtifactIn(record: EvolutionMemoryRecord, artifactId: string, now: string): EvolutionMemoryRecord {
  const existing = record.agentLessons.find(artifact => artifact.id === artifactId)
  if (existing === undefined) return record
  const next = lessonArtifact.parse({ ...existing, validationCount: existing.validationCount + 1, updatedAt: now })
  return { ...record, agentLessons: record.agentLessons.map(artifact => artifact.id === artifactId ? next : artifact) }
}

/**
 * Bump one existing artifact's refutation counter, replacing its statement
 * and/or confidence when the decision carries them. A correction keeps the
 * artifact's `id`, `createdAt`, `validationCount`, and every field the
 * decision did not supply, so the corrected fact keeps its lineage, its
 * confirmation history, and the identity every caller addresses it by. The
 * cost of keeping the id is that a corrected artifact's id no longer equals
 * the normalized statement it now carries; `addArtifactTo` therefore resolves
 * a candidate by its statement as well as by its id, so the corrected
 * artifact still absorbs a later candidate spelling that statement — with or
 * without an embeddings seam.
 *
 * A decision naming an artifact the record no longer holds is skipped, on the
 * same terms {@link confirmArtifactIn} states.
 * @param record - current record value.
 * @param decision - the contradiction to apply.
 * @param now - ISO-8601 instant to stamp.
 * @returns the candidate record without the family stamp, or `record` itself
 * when the artifact is gone.
 */
function contradictArtifactIn(record: EvolutionMemoryRecord, decision: ContradictsDecision, now: string): EvolutionMemoryRecord {
  const existing = record.agentLessons.find(artifact => artifact.id === decision.artifactId)
  if (existing === undefined) return record
  const next = lessonArtifact.parse({
    ...existing,
    ...decision.statement === undefined ? {} : { statement: decision.statement },
    ...decision.confidence === undefined ? {} : { confidence: decision.confidence },
    refutationCount: existing.refutationCount + 1,
    updatedAt: now,
  })
  return { ...record, agentLessons: record.agentLessons.map(artifact => artifact.id === decision.artifactId ? next : artifact) }
}

/**
 * Apply one extraction pass's whole decision batch to a record, in input
 * order, threading the record forward so every decision addresses what the
 * decisions before it produced, not a snapshot taken when the batch was built.
 *
 * Caps are not checked here: the caller checks the result and decides what a
 * batch past the lessons cap means, so this fold stays free of configuration.
 * @param record - current record value.
 * @param decisions - the batch, in the order the extraction reported it.
 * @param addTargets - pre-resolved merge target per `new` decision, keyed by
 * the decision's index in `decisions`; a missing key or an undefined value
 * means nothing matched closely enough. `confirms` and `contradicts`
 * decisions never consult it.
 * @param now - ISO-8601 instant to stamp on every artifact the batch touches.
 * @param defaultTtlDays - ttl a new artifact is given when its candidate carries none.
 * @returns the candidate record without the family stamp.
 */
export function applyLessonDecisions(
  record: EvolutionMemoryRecord,
  decisions: readonly LessonDecision[],
  addTargets: ReadonlyMap<number, LessonArtifact | undefined>,
  now: string,
  defaultTtlDays: number,
): EvolutionMemoryRecord {
  return decisions.reduce((current, decision, index) => {
    switch (decision.kind) {
      case 'confirms':
        return confirmArtifactIn(current, decision.artifactId, now)
      case 'contradicts':
        return contradictArtifactIn(current, decision, now)
      case 'new':
        return addArtifactTo(
          current,
          decision.candidate,
          decision.strategy ?? 'keep_both',
          addTargets.get(index),
          now,
          defaultTtlDays,
        )
    }
  }, record)
}
