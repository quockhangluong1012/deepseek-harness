import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import { toShareGpt } from '../src/sharegpt.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'sharegpt-test': { kind: 'sharegpt-test' } & ContextFormed
  }
}

type AssistantContent = SessionEventMap['assistant/message']['message']['content']
type ToolResultContent = SessionEventMap['tool/result']['message']['content']
type UserContent = SessionEventMap['user/message']['content']
type MessageId = SessionEventMap['assistant/message']['message']['id']
type ToolCallId = SessionEventMap['tool/call']['callId']

const messageId = (seq: number): MessageId => brandString<MessageId>(`m${seq}`)
const callId = (seq: number): ToolCallId => brandString<ToolCallId>(`c${seq}`)

function turnStart(turn: number, seq: number): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn } }
}

function turnEnd(turn: number, seq: number): SessionEvent {
  return { type: 'turn/end', seq: SessionSeq(seq), time: seq, data: { turn, reason: { kind: 'completed' } } }
}

function systemMessage(seq: number, content: UserContent): SessionEvent {
  return {
    type: 'system/message',
    seq: SessionSeq(seq),
    time: seq,
    data: {
      turn: 1,
      step: 1,
      message: { id: messageId(seq), role: 'system', content, source: { kind: 'system-prompt' } },
    },
    surfaceOp: 'append',
  }
}

function userMessage(seq: number, content: UserContent, kind: 'user' | 'sharegpt-test' = 'user'): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: seq,
    data: {
      id: messageId(seq),
      role: 'user',
      content,
      source: kind === 'user' ? { kind: 'user' } : { kind: 'sharegpt-test' },
    },
    surfaceOp: 'append',
  }
}

function assistantMessage(seq: number, content: AssistantContent): SessionEvent {
  return {
    type: 'assistant/message',
    seq: SessionSeq(seq),
    time: seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: messageId(seq),
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
      stream: [],
    },
    surfaceOp: 'append',
  }
}

function toolResult(seq: number, content: ToolResultContent, isError = false): SessionEvent {
  const id = callId(seq)
  return {
    type: 'tool/result',
    seq: SessionSeq(seq),
    time: seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: messageId(seq),
        role: 'tool',
        content,
        toolCallId: id,
        ...(isError ? { isError: true } : {}),
        source: { kind: 'tool', callId: id },
      },
    },
    surfaceOp: 'append',
  }
}

describe('ShareGPT shaping', () => {
  it('splits one conversation per turn and maps every surface role', () => {
    const events = [
      turnStart(1, 0),
      systemMessage(1, [{ type: 'text', text: 'Be terse.' }]),
      userMessage(2, [{ type: 'text', text: 'hello' }]),
      assistantMessage(3, [{ type: 'text', text: 'hi' }]),
      toolResult(4, [{ type: 'text', text: 'a.txt: contents' }]),
      turnEnd(1, 5),
      turnStart(2, 6),
      userMessage(7, [{ type: 'text', text: 'again' }]),
      assistantMessage(8, [{ type: 'text', text: 'ok' }]),
      turnEnd(2, 9),
    ]

    expect(toShareGpt({ sessionId: 's1', events })).toEqual([
      {
        id: 's1#1',
        conversations: [
          { from: 'system', value: 'Be terse.' },
          { from: 'human', value: 'hello' },
          { from: 'gpt', value: 'hi' },
          { from: 'tool', value: 'a.txt: contents' },
        ],
      },
      {
        id: 's1#2',
        conversations: [
          { from: 'human', value: 'again' },
          { from: 'gpt', value: 'ok' },
        ],
      },
    ])
  })

  it('excludes injected context and empty renderings', () => {
    const image = {
      type: 'image',
      attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 4, width: 2, height: 2 },
    } as unknown as UserContent[number]
    const events = [
      turnStart(1, 0),
      systemMessage(1, []),
      userMessage(1, [{ type: 'text', text: '<system-reminder>injected</system-reminder>' }], 'sharegpt-test'),
      userMessage(2, []),
      userMessage(3, [image, { type: 'text', text: 'real prompt' }]),
      toolResult(4, []),
      assistantMessage(5, [{ type: 'reasoning', text: 'thinking out loud' }]),
    ]

    expect(toShareGpt({ sessionId: 's1', events })).toEqual([
      { id: 's1#1', conversations: [{ from: 'human', value: 'real prompt' }] },
    ])
  })

  it('tags tool calls with the raw arguments JSON and keeps the assistant text', () => {
    const events = [
      turnStart(1, 0),
      assistantMessage(1, [
        { type: 'reasoning', text: 'plan' },
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool-call', id: callId(1), name: 'read', arguments: '{"file_path":"a.txt"}' },
      ]),
      assistantMessage(2, [{ type: 'tool-call', id: callId(2), name: 'grep', arguments: '{not json' }]),
    ]

    expect(toShareGpt({ sessionId: 's1', events })).toEqual([
      {
        id: 's1#1',
        conversations: [
          {
            from: 'gpt',
            value: 'Reading the file.\n'
              + '<tool_call>\n{"name":"read","arguments":{"file_path":"a.txt"}}\n</tool_call>',
          },
          {
            from: 'gpt',
            value: '<tool_call>\n{"name":"grep","arguments":{not json}\n</tool_call>',
          },
        ],
      },
    ])
  })

  it('keeps the failing tool result text', () => {
    const events = [turnStart(1, 0), toolResult(1, [{ type: 'text', text: 'ENOENT' }], true)]

    expect(toShareGpt({ sessionId: 's1', events })).toEqual([
      { id: 's1#1', conversations: [{ from: 'tool', value: 'ENOENT' }] },
    ])
  })

  it('reports an honest empty result when no turn produced a message', () => {
    const empty: readonly SessionEvent[] = []

    expect(toShareGpt({ sessionId: 's1', events: empty })).toEqual([])
    // A surface message before any turn opens belongs to no turn.
    expect(toShareGpt({ sessionId: 's1', events: [userMessage(0, [{ type: 'text', text: 'orphan' }])] })).toEqual([])
    expect(toShareGpt({
      sessionId: 's1',
      events: [turnStart(1, 0), turnEnd(1, 1)],
    })).toEqual([])
  })
})
