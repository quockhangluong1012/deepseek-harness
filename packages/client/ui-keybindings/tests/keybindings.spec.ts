import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import {
  chordMatches,
  parseChord,
} from '../src/keybindings-settings.ts'
import type { KeyEventLike } from '../src/keybindings-settings.ts'

/** One synthetic keydown with every modifier defaulted off, plus its recorder. */
export function event(key: string, modifiers: Partial<KeyEventLike> = {}): {
  event: KeyEventLike & { preventDefault(): void }
  recorded: Mock
} {
  const preventDefault = vi.fn()
  return {
    event: {
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...modifiers,
      preventDefault,
    },
    recorded: preventDefault,
  }
}

describe('keybinding chord grammar', () => {
  it('parses modifiers, named keys, and rejects unsupported spellings', () => {
    expect(parseChord('mod+k')).toEqual({ key: 'k', mod: true, ctrl: false, shift: false, alt: false })
    expect(parseChord('mod+shift+Enter')).toEqual({ key: 'enter', mod: true, ctrl: false, shift: true, alt: false })
    expect(parseChord('ctrl+alt+arrowup')).toEqual({ key: 'arrowup', mod: false, ctrl: true, shift: false, alt: true })
    expect(parseChord('K')).toEqual({ key: 'k', mod: false, ctrl: false, shift: false, alt: false })
    expect(parseChord('mod+')).toBeUndefined()
    expect(parseChord('hyper+k')).toBeUndefined()
    expect(parseChord('mod+mod+k')).toBeUndefined()
    expect(parseChord('mod+F13')).toBeUndefined()
  })

  it('matches exactly the declared modifiers on each platform', () => {
    const chord = parseChord('mod+k')
    if (chord === undefined) throw new Error('mod+k must parse')

    expect(chordMatches(event('k', { metaKey: true }).event, chord, 'darwin')).toBe(true)
    expect(chordMatches(event('k', { ctrlKey: true }).event, chord, 'other')).toBe(true)
    // The wrong primary modifier, an extra modifier, or another key must not match.
    expect(chordMatches(event('k', { ctrlKey: true }).event, chord, 'darwin')).toBe(false)
    expect(chordMatches(event('k', { metaKey: true }).event, chord, 'other')).toBe(false)
    expect(chordMatches(event('k', { metaKey: true, shiftKey: true }).event, chord, 'darwin')).toBe(false)
    expect(chordMatches(event('j', { metaKey: true }).event, chord, 'darwin')).toBe(false)

    const shifted = parseChord('mod+shift+p')
    if (shifted === undefined) throw new Error('mod+shift+p must parse')
    expect(chordMatches(event('P', { metaKey: true, shiftKey: true }).event, shifted, 'darwin')).toBe(true)
    expect(chordMatches(event('p', { metaKey: true }).event, shifted, 'darwin')).toBe(false)
  })
})
