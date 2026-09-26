/**
 * What one mentor session's log already shows: the learner's newest statement,
 * and the newest directive this loop delivered. Both are read from the derived
 * messages, so a resumed session reads the same observation as a live one.
 * @module @deepseek-ai/dsh-mentor-loop/src/observe
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { MentorDirectiveSource } from './types.ts'

/** What one session's derived messages show the loop. */
export interface MentorObservation {
  /** The learner's newest message, as stated; absent before the learner says anything. */
  readonly analysis?: string
  /** Whether a learner message follows the newest directive this loop injected. */
  readonly learnerSpokeAfterDirective: boolean
  /** The newest directive this loop injected, when the log holds one. */
  readonly delivered?: {
    /** Digest of the directive the message carried. */
    readonly digest: string
    /** The occurrence the directive advanced. */
    readonly misconceptionId: string
    /** The pipeline stage the directive served. */
    readonly stage: MentorDirectiveSource['stage']
  }
}

/** The text blocks of one message, in order. */
function textOf(message: Message): string {
  let text = ''
  for (const block of message.content) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/**
 * Read one session's derived messages for the loop's two inputs.
 * @param messages - the session's derived messages, in conversation order.
 * @returns the learner's newest statement, the newest injected directive, and whether the learner spoke after it.
 */
export function observe(messages: readonly Message[]): MentorObservation {
  let analysis: string | undefined
  let analysisIndex = -1
  let delivered: MentorDirectiveSource | undefined
  let deliveredIndex = -1
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'user') continue
    const source = message.source
    if (source.kind === 'mentor-loop') {
      delivered = source
      deliveredIndex = index
      continue
    }
    if (source.kind === 'user') {
      analysis = textOf(message)
      analysisIndex = index
    }
  }
  return {
    ...(analysis === undefined ? {} : { analysis }),
    learnerSpokeAfterDirective: deliveredIndex >= 0 && analysisIndex > deliveredIndex,
    ...(delivered === undefined ? {} : {
      delivered: {
        digest: delivered.digest,
        misconceptionId: delivered.misconceptionId,
        stage: delivered.stage,
      },
    }),
  }
}
