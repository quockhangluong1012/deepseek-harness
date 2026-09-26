/**
 * Window-level keymap: one capture-phase listener resolves a chord to one
 * bound action, so a binding works from anywhere in the document.
 *
 * @module @deepseek-ai/dsh-client-ui-keybindings/client/keymap
 */

import type { KeyChord, KeyEventLike } from '../keybindings-settings.ts'
import { chordMatches } from '../keybindings-settings.ts'

/** One action bound to the chord that triggers it. */
export interface Keybinding {
  readonly chord: KeyChord
  readonly run: () => void
}

/** The listener target surface, narrowed so tests drive it without a DOM. */
export interface KeyEventTarget {
  addEventListener(type: 'keydown', listener: (event: KeyEventLike & { preventDefault(): void }) => void, capture: boolean): void
  removeEventListener(type: 'keydown', listener: (event: KeyEventLike & { preventDefault(): void }) => void, capture: boolean): void
}

/** Primary-modifier platform for `mod` chords. */
export type KeybindingPlatform = 'darwin' | 'other'

/**
 * Install the keymap on one target.
 * @param target - window-like event target.
 * @param platform - primary-modifier platform.
 * @param bindings - current bindings, read on every keydown so a settings change applies immediately.
 * @returns the disposer that removes the listener.
 */
export function installKeybindings(
  target: KeyEventTarget,
  platform: KeybindingPlatform,
  bindings: () => readonly Keybinding[],
): () => void {
  const onKeyDown = (event: KeyEventLike & { preventDefault(): void }): void => {
    for (const binding of bindings()) {
      if (!chordMatches(event, binding.chord, platform)) continue
      event.preventDefault()
      binding.run()
      return
    }
  }
  target.addEventListener('keydown', onKeyDown, true)
  return () => { target.removeEventListener('keydown', onKeyDown, true) }
}
