/**
 * Opt-in sensitive-value scrubbing for `session-telemetry/record` rules.
 * Deployments mount these helpers on the redaction waterfall; the seam itself
 * ships no rules so pass-through stays explicit.
 * @module @deepseek-ai/dsh-session-telemetry/sensitive
 */

import type { SessionTelemetryRecord } from './index.ts'

/** Replacement marker for scrubbed secret text. */
export const SENSITIVE_PLACEHOLDER = '[REDACTED]'

/** One sensitive text shape with its global replacement pattern. */
export interface SensitivePattern {
  /** Stable rule name for diagnostics and tests. */
  readonly name: string
  /** Global pattern replaced with {@link SENSITIVE_PLACEHOLDER}. */
  readonly pattern: RegExp
}

/**
 * Default sensitive shapes: long API-like tokens, bearer credentials, AWS
 * access keys, and PEM private-key blocks. Patterns are deliberately narrow
 * (minimum lengths, structure anchors) to avoid scrubbing ordinary prose.
 */
export const DEFAULT_SENSITIVE_PATTERNS: readonly SensitivePattern[] = [
  { name: 'api-token', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/g },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'pem-private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
]

/**
 * Scrub sensitive text from an unknown JSON value, preserving structure.
 * @param value - record body or nested value to scrub.
 * @param patterns - sensitive shapes to replace; defaults to {@link DEFAULT_SENSITIVE_PATTERNS}.
 * @returns the scrubbed value with the same structure.
 */
export function scrubSensitiveValue(value: unknown, patterns: readonly SensitivePattern[] = DEFAULT_SENSITIVE_PATTERNS): unknown {
  if (typeof value === 'string') {
    let scrubbed = value
    for (const { pattern } of patterns) {
      pattern.lastIndex = 0
      scrubbed = scrubbed.replace(pattern, SENSITIVE_PLACEHOLDER)
    }
    return scrubbed
  }
  if (Array.isArray(value)) return value.map(entry => scrubSensitiveValue(entry, patterns))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, scrubSensitiveValue(entry, patterns)]),
    )
  }
  return value
}

/**
 * Scrub a telemetry record's body, keeping channel, time, severity, and
 * attributes intact.
 * @param record - outbound record whose body may carry sensitive text.
 * @param patterns - sensitive shapes to replace; defaults to {@link DEFAULT_SENSITIVE_PATTERNS}.
 * @returns a record with the scrubbed body.
 */
export function scrubSensitiveRecord(
  record: SessionTelemetryRecord,
  patterns: readonly SensitivePattern[] = DEFAULT_SENSITIVE_PATTERNS,
): SessionTelemetryRecord {
  return { ...record, body: scrubSensitiveValue(record.body, patterns) }
}
