/**
 * Extraction prompt framing for workspace memory. The model returns only the
 * replacement document under fixed headings.
 * @module @deepseek-ai/dsh-workspace-memory-llm/prompt
 */

/** Fixed headings the replacement document must use. */
export const MEMORY_HEADINGS = ['## Purpose', '## Preferences', '## Decisions', '## References'] as const

/**
 * Build the system prompt for one extraction call.
 * @returns deterministic instruction text forbidding derived, secret, and sensitive content.
 */
export function extractionSystemPrompt(): string {
  return [
    'You maintain one markdown memory document for a software workspace.',
    'Return ONLY the complete replacement document, using exactly these headings in order:',
    ...MEMORY_HEADINGS,
    '',
    'Rules:',
    '- Record only durable facts from the conversation: project purpose, user preferences, decisions made, and stable references.',
    '- Never record anything derivable from the code itself or from the Workspace Instructions.',
    '- Never record credentials, tokens, keys, secrets, or health, race, religion, political, or gender-identity data.',
    '- Drop entries the new conversation contradicts; keep the document concise.',
    '- When there is nothing worth remembering, return the four headings with empty sections.',
  ].join('\n')
}

/**
 * Frame transcript rows as JSON so conversation text cannot break delimiters.
 * @param rows - role/text rows in chronological order.
 * @param currentMemory - current document, possibly empty.
 * @returns the user prompt text.
 */
export function frameExtractionInput(rows: readonly { role: string; text: string }[], currentMemory: string): string {
  return [
    `<current-memory>${currentMemory}</current-memory>`,
    `Rewrite the memory from this JSON transcript:\n${JSON.stringify(rows)}`,
  ].join('\n')
}

/**
 * UTF-8 truncate backing up over continuation bytes.
 * @param value - the string to truncate.
 * @param maxBytes - maximum UTF-8 bytes to retain.
 * @returns the truncated prefix.
 */
export function truncateUtf8Bytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}
