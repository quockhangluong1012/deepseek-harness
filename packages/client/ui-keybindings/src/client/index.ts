/**
 * Browser half of the keybindings plugin: reads the durable chord preferences,
 * installs the window keymap, and runs the bound composer actions.
 *
 * @module @deepseek-ai/dsh-client-ui-keybindings/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { installKeybindings } from './keymap.ts'
import type { Keybinding } from './keymap.ts'
import { KeybindingsRow } from './settings/KeybindingsRow.tsx'
import { KEYBINDINGS_NS, en, zh } from './locales.ts'
import type { KeybindingsKey } from './locales.ts'
import {
  COMMAND_PALETTE_FIELD,
  DEFAULT_COMMAND_PALETTE,
  DEFAULT_FOCUS_COMPOSER,
  FOCUS_COMPOSER_FIELD,
  KEYBINDINGS_SETTINGS_NAMESPACE,
  parseChord,
} from '../keybindings-settings.ts'
import type { KeybindingAction, KeybindingsSettings } from '../keybindings-settings.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Keybinding Settings row copy. */
    'ui-keybindings': KeybindingsKey
  }
}

export const name = 'ui-keybindings'
/** Client services the keymap reads. */
export const inject = ['configForms', 'locale', 'sessions', 'slots']

/**
 * The subset of the session-scoped input facade the keymap uses. Declared here
 * rather than imported so this package depends on the composer's public
 * contract, not on its implementation types.
 */
interface ComposerInput {
  readonly state: SnapshotStore<{ draft: string }>
  setDraft(text: string): void
  focus(): void
}

/** The session-scoped conversation face providing that input. */
interface ScopedConversation {
  readonly input: { for(scope: Context): ComposerInput }
}

/** One action's live chord text, with the defaults before the host answers. */
interface BindingStores {
  readonly commandPalette: SnapshotStore<string>
  readonly focusComposer: SnapshotStore<string>
}

/**
 * Resolve the composer of the session the interface currently shows.
 * @param ctx - client root context.
 * @returns the input facade, or undefined when no session is displayed.
 */
function activeInput(ctx: Context): ComposerInput | undefined {
  const sessions = ctx.sessions
  const state = sessions.list.getSnapshot()
  const current = Object.values(state.byId).find(summary => (summary.retainedBy.mainView ?? 0) > 0)?.id
  if (current === undefined) return undefined
  const scope = sessions.scope(current)
  if (scope === undefined) return undefined
  const conversation = scope.get('conversation') as ScopedConversation | undefined
  return conversation?.input.for(scope)
}

/**
 * Open the command palette, which is this composer's own command menu: the
 * binding seeds the `/` token an empty draft carries and returns focus, so the
 * menu the user already knows opens without a second palette implementation.
 * A non-empty draft is left exactly as typed.
 */
function openCommandPalette(ctx: Context): void {
  const input = activeInput(ctx)
  if (input === undefined) return
  if (input.state.getSnapshot().draft.trim().length === 0) input.setDraft('/')
  input.focus()
}

/** Return the keyboard to the composer without touching its draft. */
function focusComposer(ctx: Context): void {
  activeInput(ctx)?.focus()
}

/** Mirror the durable section into the browser-local stores, now and on every change. */
function bindPreferences(
  form: ConfigForm<KeybindingsSettings>,
  stores: BindingStores,
): () => void {
  const adopt = (): void => {
    const section = form.getSnapshot().value
    if (section === undefined) return
    if (section.commandPalette !== stores.commandPalette.getSnapshot()) {
      stores.commandPalette.set(section.commandPalette)
    }
    if (section.focusComposer !== stores.focusComposer.getSnapshot()) {
      stores.focusComposer.set(section.focusComposer)
    }
  }
  const unsubscribe = form.subscribe(adopt)
  adopt()
  return unsubscribe
}

/**
 * Mount the browser keymap and its Settings row.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(KEYBINDINGS_NS, { zh, en }), 'ui-keybindings: dictionaries')
  const stores: BindingStores = {
    commandPalette: createSnapshotStore(DEFAULT_COMMAND_PALETTE),
    focusComposer: createSnapshotStore(DEFAULT_FOCUS_COMPOSER),
  }
  const form = ctx.configForms.get<KeybindingsSettings>(KEYBINDINGS_SETTINGS_NAMESPACE)
  const unsubscribe = bindPreferences(form, stores)
  ctx.effect(() => () => { unsubscribe() }, 'ui-keybindings: preference subscription')

  const actions: Readonly<Record<KeybindingAction, () => void>> = {
    commandPalette: () => { openCommandPalette(ctx) },
    focusComposer: () => { focusComposer(ctx) },
  }
  const fields: Readonly<Record<KeybindingAction, string>> = {
    commandPalette: COMMAND_PALETTE_FIELD,
    focusComposer: FOCUS_COMPOSER_FIELD,
  }
  const bindings = (): readonly Keybinding[] => {
    const list: Keybinding[] = []
    for (const action of ['commandPalette', 'focusComposer'] as const) {
      const chord = parseChord(stores[action].getSnapshot())
      // An unparsable stored chord binds nothing: the Settings row refuses it,
      // so this only covers a hand-edited settings document.
      if (chord !== undefined) list.push({ chord, run: actions[action] })
    }
    return list
  }
  ctx.effect(
    () => installKeybindings(window, navigator.userAgent.includes('Mac') ? 'darwin' : 'other', bindings),
    'ui-keybindings: window keymap',
  )

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'keybindings',
    order: 30,
    locale: KEYBINDINGS_NS,
    inject: (): KeybindingsRowInjected => ({
      hooks: {
        commandPalette: stores.commandPalette,
        focusComposer: stores.focusComposer,
      },
      setBinding: (action, chord) => {
        stores[action].set(chord)
        void form.set(fields[action], chord)
      },
    }),
  }, KeybindingsRow))
}

/** Registration-side face of the Settings row. */
export interface KeybindingsRowInjected {
  readonly hooks: {
    /** Live chord opening the command palette. */
    commandPalette: SnapshotStore<string>
    /** Live chord focusing the composer. */
    focusComposer: SnapshotStore<string>
  }
  /** Persist one action's chord and publish it to the live keymap. */
  setBinding(action: KeybindingAction, chord: string): void
}
