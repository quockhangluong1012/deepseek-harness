/** Host registration for browser keybinding preferences. */

import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile, Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { KeybindingsSettingsFields } from './keybindings-settings.ts'

export {
  COMMAND_PALETTE_FIELD,
  DEFAULT_COMMAND_PALETTE,
  DEFAULT_FOCUS_COMPOSER,
  FOCUS_COMPOSER_FIELD,
  KEYBINDINGS_SETTINGS_NAMESPACE,
  KEYBINDING_ACTIONS,
  chordMatches,
  parseChord,
} from './keybindings-settings.ts'
export type { KeybindingAction, KeyChord, KeybindingsSettings } from './keybindings-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Chord opening the command palette. */
  commandPalette: Volatile<string>
  /** Chord focusing the composer. */
  focusComposer: Volatile<string>
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  commandPalette: KeybindingsSettingsFields.commandPalette.volatile(),
  focusComposer: KeybindingsSettingsFields.focusComposer.volatile(),
})

/**
 * Register the keybinding settings section for the browser half.
 * @param ctx - plugin context; the settings registration disposes with it.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
