/**
 * Public type vocabulary of the evolution-memory store: the durable
 * per-scope document, its context items, produced-file index, extraction
 * the extraction that wrote them, and staged writes. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-memory/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { LessonArtifact, LessonArtifactInput, LessonArtifactPatch, LessonMergeStrategy } from './lesson-artifact.ts'
import type { LessonDecision } from './decisions.ts'

// The artifact vocabulary is re-exported here so a browser-safe consumer —
// the controller's wire face, for one — can name the artifact types without
// importing the package root, whose module body reaches for `node:crypto`.
export type { LessonArtifact, LessonArtifactInput, LessonArtifactPatch, LessonMergeStrategy } from './lesson-artifact.ts'
export type { LessonLineage, LessonSupersession, UtilityEstimate } from './lesson-artifact.ts'
export type { LessonLifecycle } from './lifecycle.ts'
export type { ConflictRule, LessonConflict } from './conflict.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A field exceeds its configured byte cap. */
    'evolution/too-large': { readonly field: string; readonly bytes: number; readonly maxBytes: number }
    /** The write would exceed the item count or push used bytes past capacity. */
    'evolution/capacity-exceeded': { readonly usedBytes: number; readonly capacityBytes: number }
    /** No context item or lesson artifact carries that id. */
    'evolution/item-not-found': { readonly itemId: string }
    /** No staged write carries that id. */
    'evolution/staged-not-found': { readonly stagedId: string }
    /** A staged skill proposal lacks the admission evidence approval needs. */
    'evolution/staged-blocked': { readonly stagedId: string; readonly neededEvidence: readonly string[] }
    /** Another process holds the scope's cross-process write lock past the configured wait. */
    'evolution/scope-locked': { readonly scope: string; readonly path: string; readonly waitedMs: number }
    /** The rebuild could not produce a document. */
    'evolution/extraction-failed': { readonly scopeId: string }
  }
}

/**
 * Scope identity: the stable storage key `profile:workspaceId`, or
 * `profile:global` for the profile-wide record. Opaque across the store
 * boundary; build it with {@link EvolutionScopeId}.
 */
export type EvolutionScopeId = Branded<'EvolutionScopeId'>

/**
 * One attached context item. Text items carry their content; file items carry
 * a path read at injection time. `sizeBytes` is the size observed when the
 * item was added and is never refreshed.
 */
export type EvolutionContextItem =
  | { kind: 'text'; id: string; label: string; text: string; sizeBytes: number; addedAt: string }
  | { kind: 'file'; id: string; label: string; path: string; sizeBytes: number; addedAt: string }

/** Caller-supplied payload for {@link EvolutionMemoryStore.addContextItem}. */
export type EvolutionContextItemInput =
  | { kind: 'text'; label: string; text: string }
  | { kind: 'file'; label: string; path: string; sizeBytes: number }

/** One produced-file index entry, newest first. */
export interface EvolutionOutput {
  path: string
  tool: string
  sessionId: string
  at: string
}

/**
 * One recall the scope served: which memory the shipped recall path retrieved
 * into the scope's context, the item it landed as, and the recorded evidence
 * that landed afterwards. §23's loop is these links, one recalled memory at a
 * time; links no record can supply are absent rather than guessed.
 */
export interface MemoryRecall {
  /** Recalled memory's identity: the id its `Recall: ` label carried. */
  id: string
  /** Context item the recall landed as. */
  itemId: string
  /** ISO-8601 instant the recall landed in the scope's context. */
  at: string
  /**
   * Session of the decision batch that landed on the scope after this recall,
   * or null while none has. The batch is the recorded decision the recalled
   * material was in play for; which session read the item is not recorded.
   */
  decidedInSessionId: string | null
  /** ISO-8601 instant that batch landed, or null while none has. */
  decidedAt: string | null
  /**
   * Graded outcome of the session that decision batch was extracted from, as
   * a grader reading the feedback store recorded it: `ok` when that session's
   * recorded evidence was clean, `failed` when a decisive failure was
   * attributed to it. Null while none was recorded.
   */
  outcome: RecallOutcome
  /** ISO-8601 instant the outcome was recorded, or null while none has. */
  outcomeAt: string | null
}

/** What a graded recall's outcome says: clean evidence, attributed failure, or nothing recorded yet. */
export type RecallOutcome = 'ok' | 'failed' | null

/** One recorded recall, with the scope whose context it landed in. */
export interface RecordedRecall extends MemoryRecall {
  /** Scope whose context the recall landed in. */
  scopeId: EvolutionScopeId
}

/** Where a model-written memory document came from. */
export type EvolutionExtractionOrigin = 'foreground' | 'background_review' | 'user-edit' | 'rebuild'

/** The extraction that last wrote the lessons or profile document. */
export interface EvolutionExtraction {
  at: string
  sessionId: string
  provider: string
  model: string
  origin: EvolutionExtractionOrigin
  inputBytes: number
  truncated: boolean
}

/** What a staged write proposes to change. */
export type StagedWriteKind = 'memory' | 'skill'

/**
 * Text payload for the `setInstructions`, `appendInstructions`,
 * `setUserProfile`, and `appendEpisodic` staged ops. A profile op may carry
 * the extraction record, which approval stamps as `lastExtraction`.
 */
export interface MemoryStagedTextPayload {
  text: string
  extraction?: EvolutionExtraction
}

/**
 * One raw session note in the scope's episodic tier: the daily log §2.1 keeps
 * beside the curated semantic families. Approval appends it verbatim and the
 * append path prunes notes the retention window has outlived, so entries are
 * short-lived consolidation material, never a second lessons document.
 */
export interface EpisodicEntry {
  /** UTC calendar day the note landed, `YYYY-MM-DD`, derived from `addedAt`. */
  day: string
  /** The note as approved, verbatim. */
  text: string
  /** ISO-8601 instant the note was appended. */
  addedAt: string
}

/** Payload for the `addArtifact` staged op. */
export interface MemoryStagedAddArtifactPayload {
  candidate: LessonArtifactInput
  strategy?: LessonMergeStrategy
}

/** Payload for the `updateArtifact` staged op. */
export interface MemoryStagedUpdateArtifactPayload {
  id: string
  patch: LessonArtifactPatch
}

/** Payload for the `removeArtifact` staged op. */
export interface MemoryStagedRemoveArtifactPayload {
  id: string
}

/**
 * Payload for the `replaceArtifacts` staged op: the whole lessons document,
 * expressed as artifact candidates.
 */
export interface MemoryStagedReplaceArtifactsPayload {
  candidates: LessonArtifactInput[]
}

/**
 * Payload for the `applyDecisions` staged op: one extraction pass's whole
 * decision batch, applied as a single write. The optional `extraction` is the
 * record of the call that produced the batch, stamped on approval exactly
 * as `replaceArtifacts` and `addArtifact` stamp theirs.
 */
export interface MemoryStagedApplyDecisionsPayload {
  decisions: LessonDecision[]
  extraction?: EvolutionExtraction
}

/**
 * One decision batch that landed on a scope's record, as
 * `evolution/decisions-applied` publishes it. Consumers that derive knowledge
 * from extraction — the claim graph is the shipped one — read the artifacts
 * as they read *before* the write: a `contradicts` decision keeps the
 * artifact's identity while replacing its statement, so the pre-write
 * statement is the only one that names what a correction corrects.
 */
export interface EvolutionDecisionsApplied {
  /** Scope the batch was written to. */
  scopeId: EvolutionScopeId
  /** Session the batch was extracted from: the evidence source of every decision it carries. */
  sessionId: string
  /** The batch, in the order it was applied. */
  decisions: readonly LessonDecision[]
  /** The scope's artifacts as they read before the write, which the decisions were resolved against. */
  artifacts: readonly LessonArtifact[]
}

/** One staged write awaiting approval. Staged entries never count toward capacity. */
export interface StagedWrite {
  id: string
  kind: StagedWriteKind
  op: string
  /** JSON payload the op consumes; the store validates it before persisting. */
  payload: JsonValue
  originSessionId: string
  createdAt: string
  gist: string
  /**
   * Merge identity for candidate dedupe: re-staging the same key while an
   * entry is pending bumps `recurrence` instead of appending a duplicate, so
   * a repeatedly proposed candidate is remembered, not silently retried.
   * Null opts out of dedupe.
   */
  mergeKey: string | null
  /** Times this merge key was staged while pending, starting at 1. */
  recurrence: number
  /**
   * Why approval is currently blocked, or null when it is not. A blocked
   * entry stays pending; approving again retries the gate.
   */
  blockedReason: string | null
  /** Evidence that would unblock approval, most decisive first. */
  neededEvidence: readonly string[]
}

/** Admission evidence a skill proposal must carry before approval. */
export interface CaptureContract {
  /** What the skill does, in one line. */
  capability: string
  /** Procedural evidence the skill was derived from, e.g. produced paths. */
  procedureRefs: readonly string[]
  /** Validation evidence independent of the procedure refs. */
  validationRefs: readonly string[]
  /** What the independent validation showed. */
  validationSummary: string
  /** Known limits and exceptions of the skill. */
  limitations: string
}

/** One decided staged entry, kept so the journey can count approvals and rejections. */
export interface StagedResolution {
  /** Identity the staged entry carried while it was pending. */
  id: string
  kind: StagedWriteKind
  op: string
  gist: string
  decision: 'approved' | 'rejected'
  /** ISO-8601 instant of the decision. */
  at: string
  originSessionId: string
  /** Merge identity the entry carried, or null when it opted out of dedupe. */
  mergeKey: string | null
  /** Times the merge key was staged while pending. */
  recurrence: number
}

/** Caller-supplied payload for {@link EvolutionMemoryStore.stageWrite}. */
export interface StagedWriteInput {
  scopeId: EvolutionScopeId
  kind: StagedWriteKind
  op: string
  /** JSON payload the op consumes; a non-JSON value is refused loudly. */
  payload: JsonValue
  originSessionId: string
  gist: string
  /**
   * Merge identity for candidate dedupe. When an entry carrying the same key
   * is still pending in the scope, staging bumps its `recurrence` instead of
   * appending a duplicate. Omit for no dedupe.
   */
  mergeKey?: string
}

/** Durable per-scope evolution memory document stored in the `evolution_memory` domain. */
export interface EvolutionMemoryRecord {
  /** User-authored rules for every Session in this scope. */
  instructions: string
  /** Model-maintained lessons: one structured artifact per extracted fact. */
  agentLessons: readonly LessonArtifact[]
  /** Model-maintained user profile document; markdown, user-editable. */
  userProfile: string
  /** ISO-8601 instant of the last instructions write, or null when never written. */
  instructionsUpdatedAt: string | null
  /** ISO-8601 instant of the last lessons write, or null when never written. */
  lessonsUpdatedAt: string | null
  /** ISO-8601 instant of the last profile write, or null when never written. */
  profileUpdatedAt: string | null
  /**
   * ISO-8601 instant of the last lessons or profile write, or null when
   * neither has been written. Derived as the later of
   * {@link lessonsUpdatedAt} and {@link profileUpdatedAt}; kept for one
   * release beside the per-family stamps.
   */
  memoryUpdatedAt: string | null
  /** Attached context, newest last. */
  contextItems: readonly EvolutionContextItem[]
  /** Produced-file index, newest first. */
  outputs: readonly EvolutionOutput[]
  /**
   * Recalls the scope served, newest first, capped by `maxRecalls`. This is
   * §23's loop as far as the profile records it, and §24's utility evidence.
   */
  recalls: readonly MemoryRecall[]
  /** Episodic tier: raw session notes in append order, pruned by retention. */
  episodic: readonly EpisodicEntry[]
  /** The extraction that last wrote the lessons or profile, or null. */
  lastExtraction: EvolutionExtraction | null
  /** Writes awaiting approval, oldest first. */
  staged: readonly StagedWrite[]
  /** Decided staged entries, newest first, capped by `maxResolutions`. */
  resolutions: readonly StagedResolution[]
  /** ISO-8601 instant of the last durable mutation. */
  updatedAt: string
}

/** Capacity accounting for one scope. */
export interface EvolutionMemoryUsage {
  usedBytes: number
  capacityBytes: number
}
