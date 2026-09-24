/**
 * Hook contributions are typed: each output is exactly one of the five kinds,
 * and no kind grants a capability — so a hook can veto or ask, never authorize.
 */
import { describe, expect, it } from 'vitest'
import { classifyHookOutput, type HookContributionKind } from '../src/contribution.ts'
import { mergeHookOutputs } from '../src/merge.ts'
import type { HookOutput } from '../src/types.ts'

/** A decoded hook output with only the fields a case cares about set. */
function out(fields: Partial<HookOutput>): HookOutput {
  return { exitCode: 0, stdout: '', stderr: '', ...fields }
}

describe('classifyHookOutput', () => {
  it('classifies every decision channel as exactly one of the five kinds', () => {
    const cases: readonly (readonly [Partial<HookOutput>, HookContributionKind])[] = [
      [{}, 'observe'],
      [{ decision: 'allow' }, 'observe'],
      [{ decision: 'approve' }, 'observe'],
      [{ continue: true }, 'observe'],
      [{ systemMessage: 'heads up' }, 'annotate'],
      [{ additionalContext: 'context' }, 'inject-untrusted-context'],
      [{ decision: 'ask' }, 'request-policy-change'],
      [{ decision: 'deny' }, 'veto'],
      [{ decision: 'block' }, 'veto'],
      [{ continue: false }, 'veto'],
    ]
    for (const [fields, kind] of cases) expect(classifyHookOutput(out(fields)), JSON.stringify(fields)).toBe(kind)
  })

  it('ranks a veto above the context and message the same output also carried', () => {
    expect(classifyHookOutput(out({
      decision: 'deny', additionalContext: 'ctx', systemMessage: 'warn', continue: false,
    }))).toBe('veto')
  })

  it('ignores empty strings when deciding between context, message, and observation', () => {
    expect(classifyHookOutput(out({ additionalContext: '', systemMessage: '' }))).toBe('observe')
    expect(classifyHookOutput(out({ additionalContext: '', systemMessage: 'warn' }))).toBe('annotate')
  })
})

describe('mergeHookOutputs contributions', () => {
  it('records one contribution per matched hook, in hook order', () => {
    const merged = mergeHookOutputs([
      out({ additionalContext: 'ctx-A' }),
      out({}),
      out({ systemMessage: 'warn-B' }),
      out({ decision: 'ask' }),
      out({ decision: 'deny' }),
    ])

    expect(merged.contributions).toEqual([
      { index: 0, kind: 'inject-untrusted-context' },
      { index: 1, kind: 'observe' },
      { index: 2, kind: 'annotate' },
      { index: 3, kind: 'request-policy-change' },
      { index: 4, kind: 'veto' },
    ])
    // The merge's permission answer stays the strictest decision.
    expect(merged.decision).toBe('deny')
  })

  it('reports no contributions for a point no hook matched', () => {
    expect(mergeHookOutputs([]).contributions).toEqual([])
  })
})
