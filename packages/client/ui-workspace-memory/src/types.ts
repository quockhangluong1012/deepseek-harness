/**
 * Browser-safe request, result, and state-stream vocabulary for the
 * `workspaceMemory` Remote namespace.
 * @module @deepseek-ai/dsh-client-ui-workspace-memory/types
 */

import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

export type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/**
 * Attached context item, mirrored from the store's durable record. Defined
 * locally so the Remote type graph stays within this package's face.
 */
export type WorkspaceContextItem =
  | { kind: 'text'; id: string; label: string; text: string; sizeBytes: number; addedAt: string }
  | { kind: 'file'; id: string; label: string; path: string; sizeBytes: number; addedAt: string }

/** Produced-file index entry, mirrored from the store. */
export interface WorkspaceOutput {
  path: string
  tool: string
  sessionId: string
  at: string
}

/** Extraction provenance, mirrored from the store. */
export interface WorkspaceMemoryExtraction {
  at: string
  sessionId: string
  provider: string
  model: string
  inputBytes: number
  truncated: boolean
}

/** Capacity accounting, mirrored from the store. */
export interface WorkspaceMemoryUsage {
  usedBytes: number
  capacityBytes: number
}

/** One Workspace's memory projected for browser consumers. */
export interface WorkspaceMemoryValue {
  readonly workspaceId: WorkspaceId
  readonly description: string
  readonly instructions: string
  readonly memory: string
  readonly memoryUpdatedAt: string | null
  readonly contextItems: readonly WorkspaceContextItem[]
  readonly outputs: readonly WorkspaceOutput[]
  readonly lastExtraction: WorkspaceMemoryExtraction | null
  readonly usage: WorkspaceMemoryUsage
  readonly updatedAt: string
}

/** Workspace identity request. */
export interface WorkspaceMemoryReadRequest {
  readonly workspaceId: WorkspaceId
}

/** Replace the page blurb. */
export interface WorkspaceMemorySetDescriptionRequest {
  readonly workspaceId: WorkspaceId
  readonly description: string
}

/** Replace the instruction text. */
export interface WorkspaceMemorySetInstructionsRequest {
  readonly workspaceId: WorkspaceId
  readonly instructions: string
}

/** Replace the memory document by hand. */
export interface WorkspaceMemorySetMemoryRequest {
  readonly workspaceId: WorkspaceId
  readonly memory: string
}

/** Attach pasted text or a workspace file. */
export interface WorkspaceMemoryAddContextItemRequest {
  readonly workspaceId: WorkspaceId
  readonly kind: 'text' | 'file'
  readonly label: string
  readonly text?: string
  readonly path?: string
}

/** Detach one context item. */
export interface WorkspaceMemoryRemoveContextItemRequest {
  readonly workspaceId: WorkspaceId
  readonly itemId: string
}

/** Candidate-path query for the add-file picker. */
export interface WorkspaceMemoryListContextFilesRequest {
  readonly workspaceId: WorkspaceId
  readonly query: string
}

/** Candidate workspace-relative paths. */
export interface WorkspaceMemoryContextFilesValue {
  readonly paths: readonly string[]
}

/** Rebuild the document from chat history. */
export interface WorkspaceMemoryRebuildRequest {
  readonly workspaceId: WorkspaceId
}

/** Memory state stream; every generation starts with exactly one baseline. */
export type WorkspaceMemoryFollowFrame =
  | { readonly type: 'baseline'; readonly values: readonly WorkspaceMemoryValue[] }
  | { readonly type: 'upsert'; readonly value: WorkspaceMemoryValue }
