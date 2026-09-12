/**
 * Public type vocabulary of the evolution-memory store: the durable
 * per-scope document, its context items, produced-file index, extraction
 * provenance, and staged writes. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-memory/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A field exceeds its configured byte cap. */
    'evolution/too-large': { readonly field: string; readonly bytes: number; readonly maxBytes: number }
    /** The write would exceed the item count or push used bytes past capacity. */
    'evolution/capacity-exceeded': { readonly usedBytes: number; readonly capacityBytes: number }
    /** No context item carries that id, or no lesson carries that substring. */
    'evolution/item-not-found': { readonly itemId: string }
    /** A lesson substring matches more than once; the caller must disambiguate. */
    'evolution/ambiguous-match': { readonly oldText: string; readonly candidates: readonly string[] }
    /** No staged write carries that id. */
    'evolution/staged-not-found': { readonly stagedId: string }
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

/** Where a model-written memory document came from. */
export type EvolutionExtractionOrigin = 'foreground' | 'background_review' | 'user-edit' | 'rebuild'

/** Provenance of the last model-written lessons or profile document. */
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
 * Text payload for the `setInstructions`, `setLessons`, `addLesson`, and
 * `setUserProfile` staged ops. Lessons and profile ops may carry extraction
 * provenance, which approval stamps as `lastExtraction`.
 */
export interface MemoryStagedTextPayload {
  text: string
  extraction?: EvolutionExtraction
}

/** Payload for the `replaceLesson` staged op. */
export interface MemoryStagedReplacePayload {
  oldText: string
  content: string
  extraction?: EvolutionExtraction
}

/** Payload for the `removeLesson` staged op. */
export interface MemoryStagedRemovePayload {
  oldText: string
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
}

/** Durable per-scope evolution memory document stored in the `evolution_memory` domain. */
export interface EvolutionMemoryRecord {
  /** User-authored rules for every Session in this scope. */
  instructions: string
  /** Model-maintained lessons document; markdown, user-editable. */
  agentLessons: string
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
  /** Provenance of the last model-written lessons or profile, or null. */
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
