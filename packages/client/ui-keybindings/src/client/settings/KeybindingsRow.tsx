/**
 * General Settings row for the window keymap: each bound action shows its
 * chord and captures a replacement when clicked.
 */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './KeybindingsRow.module.css'
import { parseChord } from '../../keybindings-settings.ts'
import type { KeybindingAction } from '../../keybindings-settings.ts'
import type { KeybindingsRowInjected } from '../index.ts'

/** Full Settings-row props. */
export type KeybindingsRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'ui-keybindings'>
  & InjectFace<KeybindingsRowInjected>

/** Rows in display order, with the copy key naming each action. */
const ACTIONS: readonly { action: KeybindingAction; label: string }[] = [
  { action: 'commandPalette', label: 'settings.keybindings.commandPalette' },
  { action: 'focusComposer', label: 'settings.keybindings.focusComposer' },
]

/** Capture one chord off a keydown, or undefined when the chord is unsupported. */
function chordFromEvent(event: React.KeyboardEvent<HTMLButtonElement>): string | undefined {
  const key = event.key.toLowerCase()
  if (key === 'control' || key === 'meta' || key === 'shift' || key === 'alt') return undefined
  const parts: string[] = []
  if (event.metaKey) parts.push('mod')
  if (event.ctrlKey && !event.metaKey) parts.push('ctrl')
  if (event.shiftKey) parts.push('shift')
  if (event.altKey) parts.push('alt')
  const candidate = [...parts, key].join('+')
  // A chord without a modifier would swallow ordinary typing.
  return parts.length > 0 && parseChord(candidate) !== undefined ? candidate : undefined
}

/** One action's capture button. */
function BindingCapture({ label, chord, capturing, onCapture, onBegin, t }: {
  label: string
  chord: string
  capturing: boolean
  onCapture: (chord: string) => void
  onBegin: () => void
  t: KeybindingsRowProps['t']
}) {
  const [invalid, setInvalid] = useState(false)
  return (
    <div className={css.binding}>
      <div className={css.bindingLabel}>{t(label as Parameters<typeof t>[0])}</div>
      <button
        type="button"
        className={capturing ? `${css.chord} ${css.capturing}` : css.chord}
        aria-label={`${t(label as Parameters<typeof t>[0])}: ${chord}`}
        onClick={onBegin}
        onBlur={() => { setInvalid(false) }}
        onKeyDown={(event) => {
          if (!capturing) return
          event.preventDefault()
          if (event.key === 'Escape') {
            setInvalid(false)
            onCapture(chord)
            return
          }
          const next = chordFromEvent(event)
          if (next === undefined) {
            setInvalid(true)
            return
          }
          setInvalid(false)
          onCapture(next)
        }}
      >
        {capturing ? (invalid ? t('settings.keybindings.invalid') : t('settings.keybindings.capture')) : chord}
      </button>
    </div>
  )
}

/**
 * Render the keybinding preferences.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function KeybindingsRow({ useCommandPalette, useFocusComposer, setBinding, t }: KeybindingsRowProps) {
  const commandPalette = useCommandPalette(value => value)
  const focusComposer = useFocusComposer(value => value)
  const [capturing, setCapturing] = useState<KeybindingAction | undefined>(undefined)
  const chords: Readonly<Record<KeybindingAction, string>> = {
    commandPalette,
    focusComposer,
  }
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.keybindings.title')}</div>
        <div className={css.desc}>{t('settings.keybindings.description')}</div>
      </div>
      <div className={css.bindings}>
        {ACTIONS.map(({ action, label }) => (
          <BindingCapture
            key={action}
            label={label}
            chord={chords[action]}
            capturing={capturing === action}
            onBegin={() => { setCapturing(action) }}
            onCapture={(chord) => {
              setCapturing(undefined)
              setBinding(action, chord)
            }}
            t={t}
          />
        ))}
      </div>
    </div>
  )
}
