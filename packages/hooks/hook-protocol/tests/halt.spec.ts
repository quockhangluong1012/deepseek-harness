import { describe, expect, it, vi } from 'vitest'
import { applyRunHalt, mergeHookOutputs } from '@deepseek-ai/dsh-hook-protocol'
import type { HookOutput } from '@deepseek-ai/dsh-hook-protocol'

const outcome = (outputs: HookOutput[]) => mergeHookOutputs(outputs)

describe('applyRunHalt — the run-level halt for {"continue": false}', () => {
  it('does nothing when no hook asked to stop', () => {
    const cancel = vi.fn()
    const warn = vi.fn()
    expect(applyRunHalt(outcome([{ exitCode: 0, stderr: '', stdout: '' }]), 'PreToolUse', { cancel }, warn)).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('cancels the run with the hook cause and the hook stopReason', () => {
    const cancel = vi.fn()
    const merged = outcome([{ exitCode: 0, stderr: '', stdout: '', continue: false, stopReason: 'budget exceeded' }])
    expect(applyRunHalt(merged, 'PreToolUse', { cancel }, vi.fn())).toBe(true)
    expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'budget exceeded' })
  })

  it('names the hook point when the halt carried no reason', () => {
    const cancel = vi.fn()
    const merged = outcome([{ exitCode: 0, stderr: '', stdout: '', continue: false }])
    applyRunHalt(merged, 'Stop', { cancel }, vi.fn())
    expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'Stop hook halted the run' })
  })

  it('warns instead of halting at a point with no live run', () => {
    const warn = vi.fn()
    const merged = outcome([{ exitCode: 0, stderr: '', stdout: '', continue: false, stopReason: 'no' }])
    expect(applyRunHalt(merged, 'SessionEnd', undefined, warn)).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('SessionEnd')
  })
})
