/**
 * Public trajectory-export types: the ShareGPT conversation vocabulary, the
 * shaping input, and what one export call reports.
 *
 * @module @deepseek-ai/dsh-evolution-trajectory/src/types
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The role vocabulary of a ShareGPT conversation. */
export type ShareGptRole = 'system' | 'human' | 'gpt' | 'tool'

/** One role-tagged message inside an exported conversation. */
export interface ShareGptMessage {
  /** ShareGPT role the message is written under. */
  readonly from: ShareGptRole
  /** Message text, verbatim from the session log. */
  readonly value: string
}

/** One exported conversation: every admitted message of one Session turn. */
export interface ShareGptConversation {
  /** Stable conversation identity, `<sessionId>#<turn>`, naming its source turn. */
  readonly id: string
  /** Messages of that turn in log order. */
  readonly conversations: readonly ShareGptMessage[]
}

/** Input to ShareGPT shaping: one Session identity and its committed events. */
export interface ShareGptInput {
  /** Session the events belong to; the conversation ids are derived from it. */
  readonly sessionId: string
  /** Committed events in ascending `seq` order. */
  readonly events: readonly SessionEvent[]
}

/** Per-call export options. */
export interface TrajectoryExportOptions {
  /**
   * Destination the export writes to when the configured `outDir` should not
   * be used: a file path for a Session export, a directory for a scope export.
   */
  readonly out?: string
}

/** What one export call wrote. */
export interface TrajectoryExportResult {
  /** Written file path, or the written directory for a scope export. */
  readonly path: string
  /** Conversations written, summed over every file of a scope export. */
  readonly conversations: number
  /** UTF-8 bytes written, summed over every file of a scope export. */
  readonly bytes: number
}
