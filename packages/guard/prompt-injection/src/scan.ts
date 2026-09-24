/**
 * The guard's scan: match the rule table over one piece of content, replace
 * every credential span, and wrap the result in an envelope.
 *
 * Scanning is bounded by the caller's byte ceiling: content past the ceiling
 * is not examined, and the envelope reports that as a finding rather than
 * silently claiming a clean scan. The digest always covers the complete
 * observed content, so a truncated scan still identifies its artifact.
 *
 * @module @deepseek-ai/dsh-prompt-injection/scan
 */

import { createHash } from 'node:crypto'
import { GUARD_RULES } from './rules.ts'
import type { ContentEnvelope, ScanRequest, SecurityFinding } from './types.ts'
import { defaultTrustFor } from './types.ts'

/** Rule recorded when the ceiling cut the scan window short. */
const TRUNCATED_RULE = 'scan-truncated'

/**
 * SHA-256 of one piece of content.
 * @param content - the content to digest.
 * @returns the lower-case hex digest.
 */
export function digestOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Match the injection rules over one scan window.
 * @param window - the text to examine.
 * @returns one finding per matching injection rule, in rule-table order.
 */
export function injectionFindings(window: string): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  for (const rule of GUARD_RULES) {
    if (rule.family !== 'injection') continue
    if ([...window.matchAll(rule.pattern)].length === 0) continue
    findings.push({ rule: rule.id, family: rule.family, severity: rule.severity, detail: rule.detail })
  }
  return findings
}

/**
 * Replace every credential span in one piece of content. Each span becomes a
 * marker naming its rule, so a reader sees that something was removed and an
 * auditor can tell which issuer's shape matched.
 * @param content - the content to redact.
 * @returns the redacted text, how many spans were replaced, and the rules that matched.
 */
export function redactSecrets(content: string): { text: string; redactions: number; rules: string[] } {
  let text = content
  let redactions = 0
  const rules: string[] = []
  for (const rule of GUARD_RULES) {
    if (rule.family !== 'credential') continue
    const matches = [...text.matchAll(rule.pattern)]
    if (matches.length === 0) continue
    rules.push(rule.id)
    redactions += matches.length
    text = text.replace(rule.pattern, `[redacted:${rule.id}]`)
  }
  return { text, redactions, rules }
}

/**
 * Ways one credential rule matched one piece of content.
 * @param window - the scanned text.
 * @returns one finding per matching credential rule, in rule-table order.
 */
function credentialFindings(window: string): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  for (const rule of GUARD_RULES) {
    if (rule.family !== 'credential') continue
    if ([...window.matchAll(rule.pattern)].length === 0) continue
    findings.push({ rule: rule.id, family: rule.family, severity: rule.severity, detail: rule.detail })
  }
  return findings
}

/**
 * Wrap one piece of external content in its envelope.
 *
 * The injection rules examine the first `maxScanBytes` characters only, and a
 * longer body adds a `scan-truncated` finding; credential rules and the digest
 * cover the whole body, so raising the ceiling narrows the blind spot without
 * ever leaving a known secret in `content`.
 * @param request - the content, its origin, and where it was found.
 * @param maxScanBytes - ceiling on how much of the content the injection rules examine.
 * @returns the envelope; `content` carries the credential-free copy.
 */
export function scanContent(request: ScanRequest, maxScanBytes: number): ContentEnvelope {
  const window = request.content.slice(0, maxScanBytes)
  const truncated = window.length < request.content.length
  const findings = [
    ...injectionFindings(window),
    ...credentialFindings(request.content),
    ...truncated
      ? [{
        rule: TRUNCATED_RULE,
        family: 'injection' as const,
        severity: 'info' as const,
        detail: `content exceeds the ${String(maxScanBytes)} character injection-scan ceiling; only its first ${String(window.length)} characters were examined`,
      }]
      : [],
  ]
  const trust = request.trust ?? defaultTrustFor(request.source)
  return {
    content: redactSecrets(request.content).text,
    source: request.source,
    trust,
    tainted: trust !== 'trusted' || findings.length > 0,
    provenance: request.provenance,
    findings,
    digest: digestOf(request.content),
  }
}
