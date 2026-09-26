/**
 * The guard's rule table: what external content may not say, and what must
 * never reach model context verbatim.
 *
 * Two families share one table because they share one scan. `injection` rules
 * mark content that tries to act on the reader as an instruction authority;
 * `credential` rules mark spans that are replaced before the content is
 * admitted. Both families are heuristics over text: a match is a finding, and
 * the permission document still decides authority.
 *
 * @module @deepseek-ai/dsh-prompt-injection/rules
 */

import type { FindingSeverity } from './types.ts'

/** What one rule matches and what a match means. */
export interface GuardRule {
  /** Stable rule identity, recorded on every finding and in redaction markers. */
  readonly id: string
  /** Which family the rule belongs to. */
  readonly family: 'injection' | 'credential'
  /** How serious a match is. */
  readonly severity: FindingSeverity
  /** One sentence naming what the content tried to do or carry. */
  readonly detail: string
  /** The pattern a match is found with; always global, never stateful at the call site. */
  readonly pattern: RegExp
}

/**
 * Every rule the guard applies, in the order findings are reported. Credential
 * patterns are deliberately narrow — a false positive replaces text a reader
 * needed — and each names one issuer's published shape.
 */
export const GUARD_RULES: readonly GuardRule[] = [
  {
    id: 'instruction-override',
    family: 'injection',
    severity: 'critical',
    detail: 'content instructs the reader to ignore its existing instructions',
    pattern: new RegExp(
      String.raw`\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier|above|preceding)?\s*`
        + String.raw`(?:instructions?|prompts?|rules?|directions?)\b`,
      'gi',
    ),
  },
  {
    id: 'chat-control-token',
    family: 'injection',
    severity: 'critical',
    detail: 'content carries a chat-template control token',
    pattern: /<\|(?:im_start|im_end|system|assistant|user|endoftext)\|>/g,
  },
  {
    id: 'authority-tampering',
    family: 'injection',
    severity: 'critical',
    detail: 'content tries to change approval, permission, or sandbox authority',
    pattern: /\b(?:skip|bypass|disable|ignore)\s+(?:the\s+|all\s+|any\s+)?(?:approvals?|permissions?|polic(?:y|ies)|sandbox)\b/gi,
  },
  {
    id: 'blanket-approval',
    family: 'injection',
    severity: 'warning',
    detail: 'content asks for blanket approval of future actions',
    pattern: /\b(?:approve|allow|accept)\s+(?:all|any|every)\s+(?:commands?|actions?|calls?|tools?|requests?)\b/gi,
  },
  {
    id: 'private-key-block',
    family: 'credential',
    severity: 'critical',
    detail: 'content carries a PEM private key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'openai-key',
    family: 'credential',
    severity: 'critical',
    detail: 'content carries an OpenAI-style API key',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    id: 'github-token',
    family: 'credential',
    severity: 'critical',
    detail: 'content carries a GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: 'slack-token',
    family: 'credential',
    severity: 'critical',
    detail: 'content carries a Slack token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'aws-access-key-id',
    family: 'credential',
    severity: 'critical',
    detail: 'content carries an AWS access key id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'bearer-token',
    family: 'credential',
    severity: 'warning',
    detail: 'content carries a bearer token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  },
  {
    id: 'json-web-token',
    family: 'credential',
    severity: 'warning',
    detail: 'content carries a JSON web token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
]
