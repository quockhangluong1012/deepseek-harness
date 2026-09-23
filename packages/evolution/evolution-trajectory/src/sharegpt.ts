/**
 * Pure ShareGPT shaping over one Session's committed events: each turn becomes
 * one conversation whose messages carry the ShareGPT role vocabulary. Only the
 * model surface is admitted, and a user-role message must be a human prompt, so
 * injected context never enters an export.
 *
 * @module @deepseek-ai/dsh-evolution-trajectory/src/sharegpt
 */

import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { ShareGptConversation, ShareGptInput, ShareGptMessage, ShareGptRole } from './types.ts'

/** One message content block, as the session event map declares it. */
type ContentBlock = SessionEventMap['user/message']['content'][number]

/**
 * Join the text blocks of one message content array. Reasoning, image, and
 * file blocks contribute no text of their own.
 * @param content - content blocks of one message.
 * @returns the concatenated text.
 */
function textOf(content: readonly ContentBlock[]): string {
  let out = ''
  for (const block of content) {
    if (block.type === 'text') out += block.text
  }
  return out
}

/**
 * Render one tool call as the tagged JSON object tool-use datasets carry: the
 * call name quoted, the model's raw arguments JSON verbatim, so unparseable
 * arguments still survive the export.
 * @param name - tool name the model requested.
 * @param args - raw arguments JSON exactly as the model produced it.
 * @returns the tagged tool call.
 */
function toolCallTag(name: string, args: string): string {
  return `<tool_call>\n{"name":${JSON.stringify(name)},"arguments":${args}}\n</tool_call>`
}

/**
 * Render one Assistant message: its text blocks joined, then one tag per tool
 * call in block order.
 * @param content - content blocks of the Assistant message.
 * @returns the rendered value, empty when the message carried nothing.
 */
function assistantText(content: readonly ContentBlock[]): string {
  let text = ''
  const calls: string[] = []
  for (const block of content) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'tool-call') calls.push(toolCallTag(block.name, block.arguments))
  }
  return [text, ...calls].filter(part => part.length > 0).join('\n')
}

/**
 * Build one ShareGPT message, dropping an empty rendering (an empty content
 * array or an empty system prompt contributes nothing to a request).
 * @param from - ShareGPT role of the message.
 * @param value - rendered message text.
 * @returns the message, or undefined when the text is empty.
 */
function message(from: ShareGptRole, value: string): ShareGptMessage | undefined {
  return value.length === 0 ? undefined : { from, value }
}

/**
 * Map one committed event onto its ShareGPT message.
 *
 * A `user/message` passes only when its source is the human user: a synthetic
 * injection (file-change notice, subagent AGENTS.md, skill content, goal
 * continuation) is context the harness added, not something the user said, and
 * it never feeds back into data derived from the Session — the same admission
 * rule the background reviewer applies.
 * @param event - one committed session event.
 * @returns the message, or undefined when the event contributes none.
 */
function admittedMessage(event: SessionEvent): ShareGptMessage | undefined {
  switch (event.type) {
    case 'system/message':
      return message('system', textOf(event.data.message.content))
    case 'user/message':
      if (event.data.source.kind !== 'user') return undefined
      return message('human', textOf(event.data.content))
    case 'assistant/message':
      return message('gpt', assistantText(event.data.message.content))
    case 'tool/result':
      return message('tool', textOf(event.data.message.content))
    // Merge-extensible event map: every other event type carries no conversation
    // message, and an unknown one cannot be interpreted as one.
    default:
      return undefined
  }
}

/**
 * Shape one Session's committed events into ShareGPT conversations, one per
 * turn that produced at least one admitted message. Events before the first
 * `turn/start` belong to no turn and are dropped.
 * @param input - the Session identity and its committed events in `seq` order.
 * @returns conversations in turn order; empty when no turn produced a message.
 */
export function toShareGpt(input: ShareGptInput): ShareGptConversation[] {
  const byTurn = new Map<number, { id: string; conversations: ShareGptMessage[] }>()
  let turn: number | undefined
  for (const event of input.events) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      continue
    }
    if (turn === undefined) continue
    const shaped = admittedMessage(event)
    if (shaped === undefined) continue
    const existing = byTurn.get(turn)
    if (existing === undefined) byTurn.set(turn, { id: `${input.sessionId}#${turn}`, conversations: [shaped] })
    else existing.conversations.push(shaped)
  }
  return [...byTurn.values()]
}
