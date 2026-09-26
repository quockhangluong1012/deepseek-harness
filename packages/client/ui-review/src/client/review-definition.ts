/**
 * What the `review` Chat node IS: one settled independent review — the durable
 * `review/report` record a `/review` or `/security-review` run wrote — folded
 * into the findings panel's render payload. The record arrives from the
 * Session log, which this client did not write, so it is parsed once here with
 * the payload's schema: a malformed record produces no node rather than a
 * broken panel.
 * @module @deepseek-ai/dsh-client-ui-review/review-definition
 */

import { z } from 'zod'
import type {
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ReviewFinding, ReviewKind } from '@deepseek-ai/dsh-command-review'

/** Final keyed Chat payload for one settled independent review. */
export interface ReviewPanelData {
  /** Which review produced the report. */
  readonly kind: ReviewKind
  /** The reviewed diff target: empty for uncommitted changes, else the reference or commit. */
  readonly target: string
  /** The reviewer's summary of what the diff does and its verdict. */
  readonly summary: string
  /** Every finding the reviewer reported; empty is a clean review. */
  readonly findings: readonly ReviewFinding[]
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One settled independent review and its findings. */
    review: ReviewPanelData
  }
}

/** One durable `review/report` payload, as the log may hold it. */
const reviewRecord = z.object({
  kind: z.enum(['code', 'security']),
  target: z.string(),
  summary: z.string(),
  findings: z.array(z.object({
    file: z.string(),
    line: z.string().optional(),
    severity: z.enum(['high', 'medium', 'low']),
    message: z.string(),
  })),
})

/**
 * Read the completed review one `review/report` payload recorded.
 * @param data - decoded durable event data read from a Session log.
 * @returns the render payload, or undefined when the record is not a complete report.
 */
function readReview(data: unknown): ReviewPanelData | undefined {
  const parsed = reviewRecord.safeParse(data)
  if (!parsed.success) return undefined
  const { kind, target, summary, findings } = parsed.data
  return {
    kind,
    target,
    summary,
    findings: findings.map(finding => ({
      file: finding.file,
      severity: finding.severity,
      message: finding.message,
      ...finding.line === undefined ? {} : { line: finding.line },
    })),
  }
}

/** One settled independent review folded into one keyed Chat node. */
export const reviewDefinition: ConversationNodeDefinition<ReviewPanelData> = {
  kind: 'review',
  target: 'chat',
  match: event => event.type === 'review/report'
    ? { id: String(event.data.commandId), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'review/report') {
      throw new Error('review start requires review/report')
    }
    const review = readReview(match.event.data)
    if (review === undefined) throw new Error('review/report carries no complete review report')
    return review
  },
  // One invocation writes one report, so the matcher admits no update Match.
  update: context => context.state,
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    return {
      key: context.key,
      kind: 'review',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}
