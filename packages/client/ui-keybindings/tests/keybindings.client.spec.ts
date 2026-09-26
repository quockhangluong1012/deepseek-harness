import { describe, expect, it, vi } from 'vitest'
import { parseChord } from '../src/keybindings-settings.ts'
import type { KeyEventLike } from '../src/keybindings-settings.ts'
import { installKeybindings } from '../src/client/keymap.ts'
import { event } from './keybindings.spec.ts'

describe('window keymap', () => {
  /** Minimal target that records listeners, so a synthetic dispatch reaches them. */
  function target() {
    const listeners = new Set<(event: KeyEventLike & { preventDefault(): void }) => void>()
    return {
      listeners,
      addEventListener(_type: 'keydown', listener: (event: KeyEventLike & { preventDefault(): void }) => void) {
        listeners.add(listener)
      },
      removeEventListener(_type: 'keydown', listener: (event: KeyEventLike & { preventDefault(): void }) => void) {
        listeners.delete(listener)
      },
      dispatch(event: KeyEventLike & { preventDefault(): void }) {
        for (const listener of [...listeners]) listener(event)
      },
    }
  }

  it('runs the bound action, consumes the event, and reads bindings live', () => {
    const host = target()
    const run = vi.fn()
    const chord = parseChord('mod+k')
    if (chord === undefined) throw new Error('mod+k must parse')
    let bindings = [{ chord, run }]
    const dispose = installKeybindings(host, 'darwin', () => bindings)

    const matched = event('k', { metaKey: true })
    host.dispatch(matched.event)
    expect(run).toHaveBeenCalledTimes(1)
    expect(matched.recorded).toHaveBeenCalledTimes(1)

    const unrelated = event('k')
    host.dispatch(unrelated.event)
    expect(run).toHaveBeenCalledTimes(1)
    expect(unrelated.recorded).not.toHaveBeenCalled()

    // Re-binding takes effect without reinstalling the listener.
    bindings = []
    host.dispatch(event('k', { metaKey: true }).event)
    expect(run).toHaveBeenCalledTimes(1)

    dispose()
    expect(host.listeners.size).toBe(0)
  })
})
