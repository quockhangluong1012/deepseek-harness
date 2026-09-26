/**
 * The canonical output value's model-facing rendering and the two card
 * presenters: the exit marker contract, truncation notices, and the
 * pure fallbacks a replay relies on.
 */

import { describe, expect, it } from 'vitest'
import type { ToolResult } from '@deepseek-ai/dsh-tools'
import { renderCommand } from '../src/output.ts'
import { presentCommandCall, presentCommandResult } from '../src/presentation.ts'
import type { CommandOutcome, StreamOutput } from '../src/types.ts'

/** One settled command with the caller's overrides. */
function outcome(overrides: Partial<CommandOutcome> = {}): CommandOutcome {
  return { exitCode: 0, signal: null, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, ...overrides }
}

/** One captured stream. */
const stream = (text: string, truncated = false, spillPath?: string): StreamOutput =>
  ({ text, truncated, ...spillPath === undefined ? {} : { spillPath } })

describe('renderCommand', () => {
  it('renders a clean exit without an exit marker', () => {
    expect(renderCommand(outcome({ stdout: stream('Already up to date.\n') }))).toBe('Already up to date.\n')
  })

  it('renders an empty command as no output', () => {
    expect(renderCommand(outcome())).toBe('(no output)')
  })

  it('marks a nonzero exit on its own line after output without a trailing newline', () => {
    expect(renderCommand(outcome({ exitCode: 1, stdout: stream('nothing to commit') })))
      .toBe('nothing to commit\n[exit code: 1]')
  })

  it('reports a signal instead of an exit code', () => {
    expect(renderCommand(outcome({ exitCode: null, signal: 'SIGTERM', stdout: stream('partial\n') })))
      .toBe('partial\n[killed by signal: SIGTERM]')
  })

  it('separates a stderr section from stdout that already ends in a newline', () => {
    expect(renderCommand(outcome({ stdout: stream('out\n'), stderr: stream('err\n') })))
      .toBe('out\n[stderr]\nerr\n')
  })

  it('uses stderr as the only body when stdout is empty', () => {
    expect(renderCommand(outcome({ stderr: stream('fatal: not a git repository') })))
      .toBe('[stderr]\nfatal: not a git repository')
  })

  it('reports truncation with the spill path, and without one when unavailable', () => {
    expect(renderCommand(outcome({ stdout: stream('tail', true, '/spill/out.txt') })))
      .toBe('tail\n[output truncated; full output: /spill/out.txt]')
    expect(renderCommand(outcome({ stdout: stream('tail', true) })))
      .toBe('tail\n[output truncated; full output: (unavailable)]')
  })
})

describe('presentCommandCall', () => {
  it('heads the terminal card with the command and omits cwd when no repository was named', () => {
    expect(presentCommandCall('git status', undefined)).toEqual({ card: 'terminal', title: 'git status' })
  })

  it('carries an explicit repository directory as the card cwd', () => {
    expect(presentCommandCall('git switch main', 'C:\\repo')).toEqual({ card: 'terminal', title: 'git switch main', cwd: 'C:\\repo' })
  })
})

describe('presentCommandResult', () => {
  const result = (content: ToolResult['content'], isError = false): ToolResult => ({ content, isError })

  it('returns no view without exactly one content block', () => {
    expect(presentCommandResult(result([]))).toBeUndefined()
    expect(presentCommandResult(result([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]))).toBeUndefined()
  })

  it('returns no view for a non-text block', () => {
    expect(presentCommandResult(result([{ type: 'tool-removal', toolName: 'x' }]))).toBeUndefined()
  })

  it('fences an errored result without an exit status', () => {
    expect(presentCommandResult(result([{ type: 'text', text: 'git could not start\n' }], true)))
      .toEqual({ card: 'generic', content: [{ type: 'text', text: '```console\ngit could not start\n```' }] })
  })

  it('moves the exit marker into the terminal card pill', () => {
    expect(presentCommandResult(result([{ type: 'text', text: 'nothing to commit\n[exit code: 1]' }])))
      .toEqual({ card: 'terminal', output: 'nothing to commit', exitCode: 1 })
  })

  it('moves a signal marker into the terminal card pill', () => {
    expect(presentCommandResult(result([{ type: 'text', text: 'partial\n[killed by signal: SIGTERM]' }])))
      .toEqual({ card: 'terminal', output: 'partial', signal: 'SIGTERM' })
  })

  it('defaults a marker-free result to a clean exit', () => {
    expect(presentCommandResult(result([{ type: 'text', text: 'ok' }])))
      .toEqual({ card: 'terminal', output: 'ok', exitCode: 0 })
  })
})
