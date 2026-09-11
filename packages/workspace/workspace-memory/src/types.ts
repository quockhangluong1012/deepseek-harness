/**
 * Public type vocabulary of the workspace-memory store: the durable
 * per-workspace document, its context items, produced-file index, and
 * extraction provenance. Types only — no runtime code.
 * @module @deepseek-ai/dsh-workspace-memory/src/types
 */

import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A field exceeds its configured byte cap. */
    'workspace-memory/too-large': { readonly field: string; readonly bytes: number; readonly maxBytes: number }
    /** The write would exceed the item count or push used bytes past capacity. */
    'workspace-memory/capacity-exceeded': { readonly usedBytes: number; readonly capacityBytes: number }
    /** No context item carries that id. */
    'workspace-memory/item-not-found': { readonly itemId: string }
    /** The path is missing, not a regular file, or outside the Workspace. */
    'workspace-memory/context-unreadable': { readonly path: string }
    /** The rebuild could not produce a document. */
    'workspace-memory/extraction-failed': { readonly workspaceId: string }
  }
}

/**
 * One attached context item. Text items carry their content; file items carry
 * a path read at injection time. `sizeBytes` is the size observed when the
 * item was added and is never refreshed.
 */
export type WorkspaceContextItem =
  | { kind: 'text'; id: string; label: string; text: string; sizeBytes: number; addedAt: string }
  | { kind: 'file'; id: string; label: string; path: string; sizeBytes: number; addedAt: string }

/** Caller-supplied payload for {@link WorkspaceMemoryStore.addContextItem}. */
export type WorkspaceContextItemInput =
  | { kind: 'text'; label: string; text: string }
  | { kind: 'file'; label: string; path: string; sizeBytes: number }

/** One produced-file index entry, newest first. */
export interface WorkspaceOutput {
  path: string
  tool: string
  sessionId: string
  at: string
}

/** Provenance of the last model-written memory document. */
export interface WorkspaceMemoryExtraction {
  at: string
  sessionId: string
  provider: string
  model: string
  inputBytes: number
  truncated: boolean
}

/** Durable per-workspace document stored in the `workspace_memory` domain. */
export interface WorkspaceMemoryRecord {
  /** Page blurb under the Workspace title. Never reaches a model request. */
  description: string
  /** User-authored rules for every Session in this Workspace. */
  instructions: string
  /** Model-maintained knowledge document; markdown, user-editable. */
  memory: string
  /** ISO-8601 instant of the last memory write, or null when never written. */
  memoryUpdatedAt: string | null
  /** Attached context, newest last. */
  contextItems: readonly WorkspaceContextItem[]
  /** Produced-file index, newest first. */
  outputs: readonly WorkspaceOutput[]
  /** Provenance of the last model-written memory, or null. */
  lastExtraction: WorkspaceMemoryExtraction | null
  /** ISO-8601 instant of the last durable mutation. */
  updatedAt: string
}

/** Capacity accounting for one Workspace. */
export interface WorkspaceMemoryUsage {
  usedBytes: number
  capacityBytes: number
}
