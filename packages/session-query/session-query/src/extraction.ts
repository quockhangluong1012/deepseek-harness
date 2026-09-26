/** First-party semantic text extraction for session-query consumers. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: includes the first-party todo event consumed below.
import type {} from '@deepseek-ai/dsh-tool-todo'

/**
 * Message sources that produce recalled or remembered material rather than a
 * human prompt: the active-memory brief, the evolution-memory brief, the
 * workspace-memory brief, and a host-recalled session reference. Their text is
 * derived from earlier sessions and already indexed there, so indexing it again
 * would mine the harness's own injections as if the human had said them
 * (amendment S11). Every other kind — a direct prompt and any producer that has
 * not declared itself one of these — stays searchable, matching the
 * merge-extensible fall-through every other unknown source kind gets.
 */
export const MEMORY_PRODUCER_KINDS: readonly string[] = [
  'active-memory',
  'evolution-memory',
  'session-reference',
  'workspace-memory',
]

/**
 * Extract searchable semantic text from one first-party session event.
 *
 * Structural boundaries, embedded raw streams, request envelopes, and unknown
 * declaration-merged events contribute no text.
 * @param event - event to inspect.
 * @returns newline-joined semantic text, or an empty string when non-searchable.
 */
export function extractSessionEventText(event: SessionEvent): string {
  switch (event.type) {
    case 'user/message':
      return MEMORY_PRODUCER_KINDS.includes(event.data.source.kind) ? '' : contentText(event.data.content)
    case 'assistant/message':
      return contentText(event.data.message.content)
    case 'tool/call':
      return joinText([event.data.name, event.data.arguments])
    case 'tool/result':
      return joinText([
        contentText(event.data.message.content),
        event.data.error?.name ?? '',
        event.data.error?.code ?? '',
      ])
    case 'todo/write':
      return joinText(event.data.todos.flatMap(todo => [todo.status, todo.content]))
    case 'turn/end':
      return turnEndText(event.data.reason)
    case 'turn/start':
    case 'step/start':
    case 'step/end':
    case 'assistant/attempt':
    case 'request/header':
      return ''
    // SessionEventMap is merge-extensible. Unknown events remain
    // non-searchable until a concrete first-party consumer defines semantics.
    default:
      return ''
  }
}

function turnEndText(reason: SessionEvent<'turn/end'>['data']['reason']): string {
  switch (reason.kind) {
    case 'error':
      return joinText(['error', reason.error.message])
    case 'aborted':
      return 'aborted'
    case 'max-tokens':
    case 'max-steps':
    case 'interrupted':
      return reason.kind
    case 'completed':
      return ''
    // TurnEndReasonMap is merge-extensible. Unknown outcomes stay out until
    // their owner defines which detail is semantic rather than structural.
    default:
      return ''
  }
}

type SessionContentBlock = SessionEvent<'user/message'>['data']['content'][number]

function contentText(content: readonly SessionContentBlock[]): string {
  return joinText(content.flatMap(blockText))
}

function blockText(block: SessionContentBlock): string[] {
  switch (block.type) {
    case 'text':
      return [block.text]
    case 'reasoning':
      return []
    case 'tool-call':
      return [block.name, block.arguments]
    // ContentBlockMap is merge-extensible. Unknown blocks do not become
    // searchable merely because their payload happens to contain strings.
    default:
      return []
  }
}

function joinText(parts: readonly string[]): string {
  return parts.map(part => part.trim()).filter(Boolean).join('\n')
}
