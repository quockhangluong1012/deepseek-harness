/**
 * Themed frameless window titlebar, rendered only inside the non-macOS desktop
 * shell. Electron drops the native frame (`frame: false`) so the web client
 * draws its own top bar: the product and active session title on the left and
 * the window controls on the right. The bar exposes a drag region
 * (`-webkit-app-region: drag`) with `no-drag` on the controls, and the active
 * session title follows the selected main panel just as the browser title task
 * does. In a plain browser the `window.dshDesktop` bridge is absent, so this
 * substructure renders nothing and the AppFrame keeps its single-row grid.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './TitleBar.module.css'

/**
 * Resolve the desktop titlebar window-control bridge, or undefined when the
 * current document runs outside the frameless Electron shell (the web browser,
 * a shell recovery document, or a macOS frame that keeps native controls).
 */
function windowControls(): DshDesktopWindowControls | undefined {
  const bridge = (globalThis as typeof globalThis & { dshDesktop?: { window?: DshDesktopWindowControls } }).dshDesktop?.window
  return bridge?.available === true ? bridge : undefined
}

/**
 * Whether the current document runs inside the frameless desktop shell and
 * therefore reserves a row for the themed titlebar.
 */
export function hasFramelessTitleBar(): boolean {
  return windowControls() !== undefined
}

/** Props for the themed frameless titlebar. */
export type TitleBarProps =
  & Pick<PropsRuntime<'root'>, 'useSessions' | 'usePanelInfo'>
  & PropsLocale<'common'>
  & { productTitle: string }

/**
 * Render the desktop window titlebar, or nothing outside the frameless shell.
 * @param props - session-title projection sources, localized copy, product title.
 * @returns the titlebar row, or null when no window-control bridge is present.
 */
export function TitleBar({ useSessions, usePanelInfo, productTitle, t }: TitleBarProps): JSX.Element | null {
  const controls = useMemo(windowControls, [])
  const showSessionTitle = usePanelInfo(info => info.activePanelId === null)
  const sessionTitle = useSessions((state) => {
    if (!showSessionTitle) return undefined
    return Object.values(state.byId)
      .find(session => (session.retainedBy.mainView ?? 0) > 0)?.title
  })
  const [maximized, setMaximized] = useState(() => false)

  useEffect(() => {
    if (!controls) return undefined
    void controls.isMaximized().then((value) => { setMaximized(value) }).catch(() => {})
    return controls.subscribe(setMaximized)
  }, [controls])

  const onTitleBarDoubleClick = useCallback(() => {
    controls?.toggleMaximize().catch(() => {})
  }, [controls])

  if (!controls) return null

  return (
    <div
      className={css.bar}
      data-testid="titlebar"
      onDoubleClick={onTitleBarDoubleClick}
    >
      <div className={css.title} aria-hidden="true">
        <span className={css.product}>{productTitle}</span>
        {sessionTitle !== undefined && <span className={css.session}>{sessionTitle}</span>}
      </div>
      <div className={css.controls}>
        <button
          type="button"
          className={css.control}
          aria-label={t('window.minimize')}
          onClick={() => { controls.minimize().catch(() => {}) }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          type="button"
          className={css.control}
          aria-label={maximized ? t('window.restore') : t('window.maximize')}
          onClick={() => { controls.toggleMaximize().catch(() => {}) }}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className={`${css.control} ${css.close}`}
          aria-label={t('window.close')}
          onClick={() => { controls.close().catch(() => {}) }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </div>
  )
}
