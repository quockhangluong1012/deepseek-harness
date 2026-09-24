/**
 * Replay-safe, model-free tool-result pruning service.
 *
 * @module @deepseek-ai/dsh-compaction-tool-result-pruner
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
// Type-only: the optional context compiler service declaration.
import type {} from '@deepseek-ai/dsh-agent-context'
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './config.ts'
import type {
  PrunedEntry,
  PruneResult,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'

export { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './config.ts'
export type {
  PrunedEntry,
  PruneResult,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolResultPruner: ToolResultPruner
  }
}

const TOOL_RESULT_RETENTION_SOURCE = 'tool-result-retention'
const SPILL_NOTICE_RETENTION_SOURCE = 'spill-notice-retention'


interface SnapshotCandidate {
  readonly seq: SessionSeq
  readonly event: SessionEvent<'tool/result'>
}

/** Deterministic head/middle/tail pruning for current tool-result surface nodes. */
export class ToolResultPruner extends Service {
  // The token meter prices each shadowed node for its logged shadow-price
  // event, so pruning genuinely requires the pricing capability.
  static inject = ['tokenMeter']

  static Config: z<ToolResultPruneConfig> = z.object({
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
    tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
  })

  /** Resolved and immutable character budgets. */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: ToolResultPruneConfig = {}) {
    super(ctx, 'toolResultPruner')
    this.config = resolveConfig(config)
    // The latest placement selects the result to keep and the recovery notices to protect.
    ctx.inject(['agentContext'], (compilerCtx) => {
      compilerCtx.effect(() => compilerCtx.agentContext.register({
        producer: TOOL_RESULT_RETENTION_SOURCE,
        kind: 'tool',
        trust: 'untrusted',
        placement: 'tail-reminder',
        maxBytes: Number.MAX_SAFE_INTEGER,
      }, (agent, signal) => {
        signal.throwIfAborted()
        const messages = agent.session.deriveMessages()
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          if (message?.role !== 'tool') continue
          const text = message.content
            .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
            .map(block => block.text)
            .join('')
          return Promise.resolve(text.length === 0 ? [] : [{ id: String(message.id), text, relevance: 1 }])
        }
        return Promise.resolve([])
      }))
    })
  }

  /**
   * Measure text content in Unicode code points; non-text blocks cost zero.
   * @param blocks - tool-result content to measure.
   * @returns total Unicode code points across text blocks.
   */
  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks) {
      if (block.type === 'text') chars += codePointLength(block.text)
    }
    return chars
  }

  /**
   * Replace an over-budget text middle while retaining rich-block order.
   * Text slicing is by Unicode code point, not UTF-16 code unit, so a retained
   * boundary cannot split a surrogate pair. Grapheme clusters may still split.
   * @param blocks - original tool-result content.
   * @returns pruned content, or `null` when the text is within budget.
   */
  pruneContent(blocks: readonly ContentBlock[]): ContentBlock[] | null {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= this.config.thresholdChars) return null

    const removedStart = this.config.headChars
    const removedEnd = totalChars - this.config.tailChars
    const pruned: ContentBlock[] = []
    let consumed = 0
    let markerInserted = false

    for (const block of blocks) {
      if (block.type !== 'text') {
        pruned.push(block)
        continue
      }

      const points = Array.from(block.text)
      const blockStart = consumed
      const blockEnd = blockStart + points.length
      const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
      const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
      const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : ''
      if (marker.length > 0) markerInserted = true
      const text = points.slice(0, headEnd).join('')
        + marker
        + points.slice(tailStart).join('')
      if (text.length > 0) pruned.push({ ...block, text })
      consumed = blockEnd
    }

    /* v8 ignore next -- totalChars > threshold and valid budgets guarantee a removed text span. */
    if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span')
    const charsAfter = this.measureContent(pruned)
    /* v8 ignore next -- config validation fixes the emitted head + marker + tail budget. */
    if (charsAfter > this.config.thresholdChars || charsAfter >= totalChars) {
      throw new Error('tool-result prune: replacement must be smaller and within threshold')
    }
    return pruned
  }

  /**
   * Prune over-budget results not selected by the latest live context placement.
   * An included recent-result source or required spill-notice source preserves
   * its whole tool result; without a live placement, all surface results remain
   * eligible. Each replacement preserves complete event data except `content`,
   * cites the shadowed node, and is preceded by its shadow price.
   * @param session - session whose current surface is rewritten.
   * @returns landed replacements and aggregate Unicode-code-point savings.
   * @throws when the session rejects a replacement; earlier replacements stay durable.
   */
  pruneSession(session: Session): PruneResult {
    const agentContext = this.ctx.get('agentContext')
    const candidates: SnapshotCandidate[] = []
    for (const seq of [...session.surface.nodes]) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(seq)
      /* v8 ignore next -- surface seqs are validated contiguous log references. */
      if (event?.type === 'tool/result') candidates.push({ seq, event })
    }

    const pruned: PrunedEntry[] = []
    let charsRemoved = 0
    for (const { seq, event } of candidates) {
      const sourceId = String(event.data.message.id)
      if (agentContext?.isIncluded(session, `${TOOL_RESULT_RETENTION_SOURCE}:${sourceId}`)
        || agentContext?.isIncluded(session, `${SPILL_NOTICE_RETENTION_SOURCE}:${sourceId}`)) continue
      const original = session.deriveEventMessage(event) as ToolResultMessage
      const content = this.pruneContent(original.content)
      if (content === null) continue
      const charsBefore = this.measureContent(original.content)
      const charsAfter = this.measureContent(content)
      const message = freezeMessage<ToolResultMessage>({
        ...original,
        content,
      })
      // Shadow-price protocol: the metering event and its replacement are
      // appended synchronously adjacent, so pure consumers subtract the
      // shadowed node's heuristic price without retaining per-node state.
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original),
      })
      const replacement = session.append('tool/result', {
        ...event.data,
        message,
      }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.source.callId,
        charsBefore,
        charsAfter,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved }
  }
}

export default ToolResultPruner
