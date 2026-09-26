/**
 * Contracts of the prompt-injection guard: the envelope every piece of
 * external content is wrapped in before it may reach model context, and the
 * finding vocabulary the envelope carries.
 *
 * The envelope is a report, not a decision. It says where content came from,
 * whether that origin is instruction authority, what the scan observed, and
 * which digest identifies the exact artifact that was scanned. Authority
 * itself stays with the permission document and the approval answerer.
 *
 * @module @deepseek-ai/dsh-prompt-injection/types
 */

import type { TrustLabel } from '@deepseek-ai/dsh-agent-kernel'
import type { SourceRef } from '@deepseek-ai/dsh-agent-kernel'

/** Which origin produced one piece of content. */
export type EnvelopeSource = 'user' | 'repo' | 'tool' | 'web' | 'mcp' | 'subagent' | 'model'

/** How serious one finding is. */
export type FindingSeverity = 'info' | 'warning' | 'critical'

/** One rule that matched one piece of content. */
export interface SecurityFinding {
  /** Stable rule identity, also used in redaction markers. */
  readonly rule: string
  /** Which family the matching rule belongs to. */
  readonly family: 'injection' | 'credential'
  /** How serious a match is. */
  readonly severity: FindingSeverity
  /** One sentence naming what the content tried to do. */
  readonly detail: string
}

/**
 * One piece of external content with its origin, trust, findings, and the
 * digest of the artifact that was examined.
 *
 * `content` is the copy safe to admit to model context: credential spans are
 * already replaced. `digest` is SHA-256 over the content as it was observed
 * before replacement, so an auditor can identify the original artifact without
 * the secret being recoverable from the record.
 */
export interface ContentEnvelope {
  /** The admittable copy: the observed content with credential spans replaced. */
  readonly content: string
  /** Origin that produced the content. */
  readonly source: EnvelopeSource
  /** Whether that origin is instruction authority for this task. */
  readonly trust: TrustLabel
  /** Whether the content must not be treated as an instruction. */
  readonly tainted: boolean
  /** Source and locator of the content itself. */
  readonly sourceRef: SourceRef
  /** Every rule that matched, in rule-table order. */
  readonly findings: readonly SecurityFinding[]
  /** SHA-256 of the observed content, before any credential was replaced. */
  readonly digest: string
}

/** One scan request: what to examine and how to attribute it. */
export interface ScanRequest {
  /** The observed content. */
  readonly content: string
  /** Origin that produced it. */
  readonly source: EnvelopeSource
  /** Source and locator of the content. */
  readonly sourceRef: SourceRef
  /**
   * Override for the origin's default trust. Omit to use
   * {@link defaultTrustFor}; a caller that has proof of authorship passes
   * `trusted`, and a caller that has none passes `unknown`.
   */
  readonly trust?: TrustLabel
}

/**
 * The trust an origin has by default: only the user's own words are
 * instruction authority; everything else is data until a caller says otherwise.
 * @param source - the origin that produced the content.
 * @returns the trust label for that origin.
 */
export function defaultTrustFor(source: EnvelopeSource): TrustLabel {
  return source === 'user' ? 'trusted' : 'untrusted'
}
