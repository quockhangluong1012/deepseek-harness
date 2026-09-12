/**
 * Remote request, result, and state-stream vocabulary for the `evolution`
 * namespace. The record types are re-exported from the store so the wire face
 * cannot drift from the durable shape; the decision ledger is declared here
 * because only the controller's stream and timestamped reads expose it.
 * @module @deepseek-ai/dsh-evolution-controller/types
 */

import type { UsageRange } from '@deepseek-ai/dsh-usage-ledger'
import type {
  EvolutionContextItem,
  EvolutionExtraction,
  EvolutionMemoryUsage,
  EvolutionOutput,
  StagedResolution,
  StagedWrite,
} from '@deepseek-ai/dsh-evolution-memory'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

export type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
export type {
  EvolutionContextItem,
  EvolutionExtraction,
  EvolutionMemoryUsage,
  EvolutionOutput,
  StagedResolution,
  StagedWrite,
} from '@deepseek-ai/dsh-evolution-memory'
export type {
  JourneyTimeline,
  TimelineCumulative,
  TimelineDayBucket,
  TimelineDelta,
  TimelineDeltaKind,
  TimelinePending,
} from '@deepseek-ai/dsh-command-evolution'

/** One scope's evolution state projected for Remote consumers. */
export interface EvolutionMemoryValue {
  /** Workspace the scope is keyed by. */
  readonly workspaceId: WorkspaceId
  /** User-authored rules for the scope. */
  readonly instructions: string
  /** Model-maintained lessons document. */
  readonly lessons: string
  /** Model-maintained user-profile document. */
  readonly profile: string
  /** Last write to the lessons/profile family, or null when never written. */
  readonly memoryUpdatedAt: string | null
  /** Last instruction write, or null when never written. */
  readonly instructionsUpdatedAt: string | null
  /** Last lessons write, or null when never written. */
  readonly lessonsUpdatedAt: string | null
  /** Last profile write, or null when never written. */
  readonly profileUpdatedAt: string | null
  /** Attached context, newest last. */
  readonly contextItems: readonly EvolutionContextItem[]
  /** Produced-file index, newest first. */
  readonly outputs: readonly EvolutionOutput[]
  /** Provenance of the last model-written document, or null. */
  readonly lastExtraction: EvolutionExtraction | null
  /** Writes still awaiting a decision, oldest first. */
  readonly staged: readonly StagedWrite[]
  /** Decided entries, newest first. */
  readonly resolutions: readonly StagedResolution[]
  /** Capacity accounting for the scope. */
  readonly usage: EvolutionMemoryUsage
  /** Instant of the last durable mutation. */
  readonly updatedAt: string
}

/**
 * Scope selector. The value is the Workspace identity the scope is keyed by;
 * the controller namespaces it with the deployment's configured profile.
 */
export interface EvolutionScopeRequest {
  readonly scopeId: WorkspaceId
}

/** Replace the instruction text. */
export interface EvolutionSetInstructionsRequest extends EvolutionScopeRequest {
  readonly instructions: string
}

/** Replace the lessons document by hand. */
export interface EvolutionSetLessonsRequest extends EvolutionScopeRequest {
  readonly lessons: string
}

/** Replace the user-profile document by hand. */
export interface EvolutionSetProfileRequest extends EvolutionScopeRequest {
  readonly profile: string
}

/** Attach pasted text or a Workspace file to the scope. */
export interface EvolutionAddContextItemRequest extends EvolutionScopeRequest {
  readonly kind: 'text' | 'file'
  readonly label: string
  /** Required when `kind` is `text`. */
  readonly text?: string
  /** Required when `kind` is `file`; resolved against the Workspace root. */
  readonly path?: string
}

/** Detach one context item. */
export interface EvolutionRemoveContextItemRequest extends EvolutionScopeRequest {
  readonly itemId: string
}

/** Rebuild the lessons document from the scope's sessions. */
export type EvolutionRebuildMemoryRequest = EvolutionScopeRequest

/** List the scope's pending staged writes. */
export type EvolutionListStagedRequest = EvolutionScopeRequest

/** Pending staged writes awaiting a decision. */
export interface EvolutionStagedValue {
  readonly staged: readonly StagedWrite[]
}

/** Decide one staged write by identity. */
export interface EvolutionResolveStagedRequest extends EvolutionScopeRequest {
  readonly stagedId: string
}

/** Render one scope's journey over a window. */
export interface EvolutionTimelineRequest extends EvolutionScopeRequest {
  readonly range: UsageRange
}

/** Evolution state stream; every generation starts with exactly one baseline. */
export type EvolutionFollowFrame =
  | { readonly type: 'baseline'; readonly values: readonly EvolutionMemoryValue[] }
  | { readonly type: 'upsert'; readonly value: EvolutionMemoryValue }


declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A context item path the controller could not read. */
    'evolution/context-unreadable': { path: string }
  }
}
