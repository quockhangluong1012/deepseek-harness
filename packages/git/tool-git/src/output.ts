/**
 * The canonical output contract the git tools share and its model-facing
 * rendering. One schema for all four tools keeps their programmatic API
 * identical, so a caller can treat every git result the same way.
 *
 * @module @deepseek-ai/dsh-tool-git/output
 */

import type { CommandOutcome, StreamOutput } from './types.ts'

/** One collected stream as the model reads it: retained tail plus spill recovery. */
const STREAM_PROPERTIES = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    text: { type: 'string', required: true, description: 'Stream text; the tail of the stream when truncated.' },
    truncated: { type: 'boolean', required: true, description: 'True when bytes were dropped from text.' },
    spillPath: { type: 'string', description: 'Path to a file holding the complete stream, when truncated and available.' },
  },
} as const

/**
 * Output properties shared by every git tool. `defineTool` requires a literal
 * schema, so each registration spreads this object into its own declaration.
 */
export const COMMAND_OUTPUT_PROPERTIES = {
  exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }], description: 'Process exit code; null when the process ended on a signal.' },
  signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Signal that ended the process; null on a normal exit.' },
  stdout: STREAM_PROPERTIES,
  stderr: STREAM_PROPERTIES,
} as const

/** One stream's model-facing text plus its truncation notice. */
function streamText(stream: StreamOutput): string {
  if (!stream.truncated) return stream.text
  return `${stream.text}\n[output truncated; full output: ${stream.spillPath ?? '(unavailable)'}]`
}

/**
 * Shape one settled command into the text the model sees: stdout, then a marked
 * stderr section, then the exit-status marker. Nonzero exits are reported, not
 * errored — the model decides how to react; only infrastructure failures
 * surface as tool errors.
 * @param outcome - the settled command facts.
 * @returns the output body (or `(no output)`), then any signal or exit marker.
 */
export function renderCommand(outcome: CommandOutcome): string {
  const out = streamText(outcome.stdout)
  const err = streamText(outcome.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'

  // A clean exit carries no marker: the absence of one is the success signal.
  const marker = outcome.signal !== null
    ? `[killed by signal: ${outcome.signal}]`
    : outcome.exitCode !== 0 ? `[exit code: ${String(outcome.exitCode)}]` : undefined
  if (marker === undefined) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + marker
}
