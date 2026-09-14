/**
 * Browser-safe request, result, and state-stream vocabulary for the `evolution`
 * Remote namespace and this package's `evolutionCurator` status face. The
 * payloads are mirrored from the Host faces so the browser program names no
 * Host package, exactly as the Workspace-memory page mirrors its store record.
 * @module @deepseek-ai/dsh-client-ui-evolution/types
 */

import type { UsageRange } from '@deepseek-ai/dsh-usage-ledger/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

export type { UsageRange } from '@deepseek-ai/dsh-usage-ledger/types'
export type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** One attached context item, mirrored from the scope record. */
export type EvolutionContextItem =
  | { kind: 'text'; id: string; label: string; text: string; sizeBytes: number; addedAt: string }
  | { kind: 'file'; id: string; label: string; path: string; sizeBytes: number; addedAt: string }

/** One durable lesson artifact, mirrored from the scope record. */
export interface LessonArtifact {
  id: string
  statement: string
  source: string
  conditions: string
  evidence: 'fact' | 'observation' | 'inference'
  confidence: number
  validationCount: number
  refutationCount: number
  scope: 'user' | 'project' | 'global'
  ttlDays?: number | undefined
  createdAt: string
  updatedAt: string
}

/** One produced-file index entry, mirrored from the scope record. */
export interface EvolutionOutput {
  path: string
  tool: string
  sessionId: string
  at: string
}

/** Extraction provenance, mirrored from the scope record. */
export interface EvolutionExtraction {
  at: string
  sessionId: string
  provider: string
  model: string
  origin: 'foreground' | 'background_review' | 'user-edit' | 'rebuild'
  inputBytes: number
  truncated: boolean
}

/** One staged write awaiting a decision, mirrored from the scope record. */
export interface StagedWrite {
  id: string
  kind: 'memory' | 'skill'
  op: string
  payload: unknown
  originSessionId: string
  createdAt: string
  gist: string
}

/** One decided staged entry, mirrored from the scope record. */
export interface StagedResolution {
  id: string
  kind: 'memory' | 'skill'
  op: string
  gist: string
  decision: 'approved' | 'rejected'
  at: string
  originSessionId: string
}

/** Capacity accounting, mirrored from the store's usage projection. */
export interface EvolutionMemoryUsage {
  usedBytes: number
  capacityBytes: number
}

/** One Scope's evolution state projected for browser consumers. */
export interface EvolutionMemoryValue {
  readonly workspaceId: WorkspaceId
  readonly instructions: string
  /** Model-maintained lesson artifacts, in the order the Host projected them. */
  readonly lessons: readonly LessonArtifact[]
  readonly profile: string
  readonly memoryUpdatedAt: string | null
  readonly instructionsUpdatedAt: string | null
  readonly lessonsUpdatedAt: string | null
  readonly profileUpdatedAt: string | null
  readonly contextItems: readonly EvolutionContextItem[]
  readonly outputs: readonly EvolutionOutput[]
  readonly lastExtraction: EvolutionExtraction | null
  readonly staged: readonly StagedWrite[]
  readonly resolutions: readonly StagedResolution[]
  readonly usage: EvolutionMemoryUsage
  readonly updatedAt: string
}

/** Scope selector; the Workspace identity the Scope is keyed by. */
export interface EvolutionScopeRequest {
  readonly scopeId: WorkspaceId
}

/** Render one Scope's journey over a window. */
export interface EvolutionTimelineRequest extends EvolutionScopeRequest {
  readonly range: UsageRange
}

/** Decide one staged write by identity. */
export interface EvolutionResolveStagedRequest extends EvolutionScopeRequest {
  readonly stagedId: string
}

/** What one delta records. */
export type TimelineDeltaKind = 'instructions' | 'lessons' | 'profile' | 'context' | 'outputs' | 'staged'

/** One recorded change in the Scope, placed on its calendar day. */
export interface TimelineDelta {
  day: string
  kind: TimelineDeltaKind
  gist: string
  sessionId: string | null
  at: string
}

/** One calendar day of the range, zero-filled when it holds no activity. */
export interface TimelineDayBucket {
  day: string
  deltas: TimelineDelta[]
  contextAttached: number
  outputsIndexed: number
  stagedOpened: number
  stagedApproved: number
  stagedRejected: number
}

/** Where the Scope stands now, independent of the range. */
export interface TimelineCumulative {
  usedBytes: number
  capacityBytes: number
  digest: string
  lessonsBytes: number
  profileBytes: number
}

/** One staged write awaiting approval. */
export interface TimelinePending {
  id: string
  kind: 'memory' | 'skill'
  op: string
  gist: string
  originSessionId: string
  createdAt: string
}

/** The Scope's journey over one range. */
export interface JourneyTimeline {
  range: UsageRange
  now: number
  days: TimelineDayBucket[]
  cumulative: TimelineCumulative
  pending: TimelinePending[]
}

/** Evolution state stream; every generation starts with exactly one baseline. */
export type EvolutionFollowFrame =
  | { readonly type: 'baseline'; readonly values: readonly EvolutionMemoryValue[] }
  | { readonly type: 'upsert'; readonly value: EvolutionMemoryValue }

/** One recorded curator pass, mirrored from the curator's ledger summary. */
export interface CuratorPassSummary {
  passId: string
  at: string
  snapshot: string
  transitions: number
}

/** Curator status as the `evolutionCurator` status face publishes it. */
export interface EvolutionCuratorStatus {
  /** Whether a curator is mounted on this Host. */
  mounted: boolean
  /** Instant of the newest recorded pass, or null when none exists. */
  lastRunAt: string | null
  /** Recorded passes, newest first. */
  passes: readonly CuratorPassSummary[]
}
