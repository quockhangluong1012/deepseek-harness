/**
 * Keybinding vocabulary shared by the host settings schema and the browser
 * keymap: the settings section, its defaults, and the chord grammar.
 *
 * @module @deepseek-ai/dsh-client-ui-keybindings/settings
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the keybindings plugin. */
export const KEYBINDINGS_SETTINGS_NAMESPACE = 'ui-keybindings'

/** Field carrying the chord that opens the command palette. */
export const COMMAND_PALETTE_FIELD = 'commandPalette'

/** Field carrying the chord that focuses the composer. */
export const FOCUS_COMPOSER_FIELD = 'focusComposer'

/** Default palette chord: the platform primary modifier plus `k`. */
export const DEFAULT_COMMAND_PALETTE = 'mod+k'

/** Default composer-focus chord. */
export const DEFAULT_FOCUS_COMPOSER = 'mod+i'

/** Actions this package can bind; each key is also its settings field. */
export const KEYBINDING_ACTIONS = ['commandPalette', 'focusComposer'] as const

/** One bindable action name. */
export type KeybindingAction = typeof KEYBINDING_ACTIONS[number]

/** Durable keybinding section shared by the Host schema and the browser scope. */
export interface KeybindingsSettings {
  /** Chord opening the command palette. */
  commandPalette: string
  /** Chord focusing the composer. */
  focusComposer: string
}

/** Durable keybinding schema; also the wire envelope the browser scope validates against. */
export const KeybindingsSettingsFields = {
  [COMMAND_PALETTE_FIELD]: z.string().default(DEFAULT_COMMAND_PALETTE),
  [FOCUS_COMPOSER_FIELD]: z.string().default(DEFAULT_FOCUS_COMPOSER),
}

/** Schema for shared configuration values. */
export const KeybindingsSettingsSchema = z.object(KeybindingsSettingsFields)

/** One parsed chord: the key plus exactly the modifiers it requires. */
export interface KeyChord {
  /** Lowercased key token (`k`, `enter`, `arrowup`, …). */
  readonly key: string
  /** Platform primary modifier: Command on macOS, Control elsewhere. */
  readonly mod: boolean
  /** Literal Control on every platform. */
  readonly ctrl: boolean
  readonly shift: boolean
  readonly alt: boolean
}

/** Named keys accepted after the modifiers, mapped to their `KeyboardEvent.key` spelling. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  enter: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  space: ' ',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
}

/** The minimal keyboard event shape a chord is matched against. */
export interface KeyEventLike {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
}

/**
 * Parse one chord spelling (`mod+shift+k`) into its key and required modifiers.
 * @param chord - the chord as stored in settings.
 * @returns the parsed chord, or undefined when the spelling is unsupported.
 */
export function parseChord(chord: string): KeyChord | undefined {
  const parts = chord.toLowerCase().split('+').map(part => part.trim()).filter(part => part.length > 0)
  const token = parts.pop()
  if (token === undefined) return undefined
  let mod = false
  let ctrl = false
  let shift = false
  let alt = false
  for (const part of parts) {
    if (part === 'mod') {
      if (mod) return undefined
      mod = true
      continue
    }
    if (part === 'ctrl') {
      if (ctrl) return undefined
      ctrl = true
      continue
    }
    if (part === 'shift') {
      if (shift) return undefined
      shift = true
      continue
    }
    if (part === 'alt') {
      if (alt) return undefined
      alt = true
      continue
    }
    return undefined
  }
  const key = NAMED_KEYS[token]?.toLowerCase() ?? token
  if (!/^[a-z0-9]$/u.test(key) && NAMED_KEYS[token] === undefined) return undefined
  return { key, mod, ctrl, shift, alt }
}

/**
 * Match one keyboard event against a parsed chord.
 * @param event - the browser event's key and modifier flags.
 * @param chord - a chord from {@link parseChord}.
 * @param platform - primary-modifier platform; `darwin` binds `mod` to Command.
 * @returns whether the event is exactly this chord.
 */
export function chordMatches(
  event: KeyEventLike,
  chord: KeyChord,
  platform: 'darwin' | 'other',
): boolean {
  const expectedMeta = chord.mod ? platform === 'darwin' : false
  const expectedCtrl = chord.mod ? platform !== 'darwin' : chord.ctrl
  return event.key.toLowerCase() === chord.key
    && event.metaKey === expectedMeta
    && event.ctrlKey === expectedCtrl
    && event.shiftKey === chord.shift
    && event.altKey === chord.alt
}
