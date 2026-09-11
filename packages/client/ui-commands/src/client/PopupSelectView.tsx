/**
 * Official popupSelect shell: renders one session's PopupSelectController
 * store from the conversation.input.overlay anchor, portaled to the document
 * body and hung from the composer card the slot hands it. Unlike the slash
 * menu (combobox — textarea keeps focus), this shell HOLDS focus while open: the
 * inner search input takes focus, plain typing filters the loaded options
 * locally, Enter/↑↓ drive the filtered highlight (scrolled into view), Escape
 * dismisses back to the composer, and ←→ keep the search input's native
 * caret. Any pointer interaction outside the box dismisses (the click's own
 * target takes focus). Closed state renders null; the overlay slot stays
 * mounted. The card hangs from whichever side of the composer card has the
 * room and clamps its height to that side.
 */
import { useEffect, useRef } from 'react'
import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCheckOutline16, RiskConfirmation, useFloatingPanel } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerOverlayOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { filterOptions } from './popup.ts'
import type { PopupSelectController } from './popup.ts'
import css from './PopupSelectView.module.css'

/** Design cap on the card height (same MenuDropdown family as the slash menu). */
const MAX_HEIGHT = 320

/** Injected business face of the popupSelect overlay entry. */
export interface PopupSelectInjected {
  /** The session's shell controller (state store + verbs; the view never touches the open-context type). */
  popup: PopupSelectController
}

/**
 * Full shell props: injected face, the composer card the panel hangs from, and
 * the locale seat. The owner share is spread by its own interface rather than
 * `PropsRuntime`, whose session scope would demand the standard session props
 * this entry never reads; the call site stays typed by the slot map.
 */
export type PopupSelectViewProps = PopupSelectInjected & ComposerOverlayOwnerProps & PropsLocale<'command'>

/**
 * Render the popupSelect shell overlay entry.
 * @param props - injected face: the session's shell controller; `t` rides the standard locale seat.
 * @returns the select card while open; null while closed.
 */
export function PopupSelectView({ popup, anchorRef, t }: PopupSelectViewProps) {
  const state = useSyncExternalStore(
    fn => popup.state.subscribe(fn),
    () => popup.state.getSnapshot(),
  )
  const cardRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // The portaled card hangs from the side of the composer card with room for
  // it, re-placed on every store update and on viewport scroll/resize.
  const placement = useFloatingPanel({ open: state.open, anchorRef, cap: MAX_HEIGHT, signal: state })
  const active = state.open ? state.active : null

  // The search input keeps focus while arrows move a virtual highlight, so
  // the browser never scrolls the active row into view — do it here.
  useEffect(() => {
    if (active === null) return
    cardRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // Focus ownership: the search input grabs on open, and ANY outside
  // pointer interaction dismisses —
  // capture phase so a click landing anywhere else (textarea included)
  // closes the shell before its own handlers run; that click's target then
  // takes focus naturally, so no focusComposer here.
  useEffect(() => {
    if (!state.open || state.confirming !== null) return
    const onPointerDown = (ev: PointerEvent): void => {
      if (cardRef.current !== null && ev.target instanceof Node && cardRef.current.contains(ev.target)) return
      popup.dismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [state.open, state.confirming, popup])

  // Focus the search input after it mounts (separate effect so the ref is populated).
  useEffect(() => {
    if (state.open && state.confirming === null) searchRef.current?.focus()
  }, [state.open, state.confirming])

  if (!state.open) return null

  const rows = filterOptions(state.options, state.search)
  const confirmation = state.confirming?.confirmation

  const onKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>): void => {
    // ArrowLeft/ArrowRight fall through on purpose: the search input keeps
    // its native caret movement.
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault()
        popup.move(1)
        return
      case 'ArrowUp':
        ev.preventDefault()
        popup.move(-1)
        return
      case 'Enter':
        ev.preventDefault()
        void popup.select(state.active)
        return
      case 'Escape':
        ev.preventDefault()
        popup.dismiss({ focusComposer: true })
        return
      default:
    }
  }

  return (
    <>
      {state.confirming === null && createPortal(
        <div
          ref={cardRef}
          className={css.card}
          style={placement?.style}
          data-command-popup=""
          data-side={placement?.side}
          aria-label={t('overlay.aria', { command: String(state.command) })}
          onKeyDown={onKeyDown}
        >
          <input
            ref={searchRef}
            className={css.search}
            type="text"
            placeholder={t('search.placeholder')}
            aria-label={t('search.aria')}
            value={state.search}
            readOnly={state.submitting}
            onChange={(ev) => { popup.setSearch(ev.currentTarget.value) }}
          />
          {state.error !== null && (
            <div className={css.error} role="alert">
              <span className={css.errorText}>{state.error}</span>
              {state.status === 'failed' && (
                <button type="button" className={css.retry} onClick={() => { popup.retry() }}>{t('retry')}</button>
              )}
            </div>
          )}
          {state.status === 'pending' && <div className={css.status}>{t('status.loading')}</div>}
          {state.submitting && <div className={css.status}>{t('status.applying')}</div>}
          {state.status === 'ready' && rows.length === 0 && <div className={css.status}>{t('status.empty')}</div>}
          {state.status === 'ready' && (
            <div role="listbox" aria-label={t('listbox.aria', { command: String(state.command) })} className={css.viewport}>
              {rows.map((option, index) => (
                <div
                  key={option.id}
                  role="option"
                  aria-selected={index === state.active}
                  className={clsx(css.row, index === state.active && css.rowActive)}
                  // mousedown would race the document capture listener; the shell
                  // owns focus anyway, so a plain click (inside the card → no
                  // dismiss) works.
                  onClick={() => { void popup.select(index) }}
                  onMouseEnter={() => { popup.highlight(index) }}
                >
                  <span className={css.label}>{option.label}</span>
                  {option.detail !== undefined && <span className={css.detail}>{option.detail}</span>}
                  {option.active === true && <span className={css.check}><IconCheckOutline16 /></span>}
                </div>
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}
      {confirmation !== undefined && (
        <RiskConfirmation
          open
          title={confirmation.title}
          description={confirmation.description}
          acknowledgeLabel={confirmation.acknowledgeLabel}
          cancelLabel={confirmation.cancelLabel}
          closeLabel={t('close')}
          confirmLabel={confirmation.confirmLabel}
          acknowledged={state.acknowledged}
          onAcknowledgedChange={(value) => { popup.acknowledge(value) }}
          onCancel={() => { popup.cancelConfirmation() }}
          onConfirm={() => { void popup.confirm() }}
        />
      )}
    </>
  )
}
