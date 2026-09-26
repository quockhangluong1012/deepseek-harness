/**
 * Workspace page body: the identity row carrying the Workspace name, its path,
 * and the editable description; the composer band the conversation's resident
 * seat docks into; the produced-file rail; the chats/activity list; and the
 * instructions, memory, and context cards in a side rail. The page draws no
 * input of its own: it holds the band open at the seat's published height and
 * publishes the band's own top offset, so the one editor the chat surface owns
 * lands between the identity row and the body. Pure props: every fact and
 * action arrives through shares; the component owns only viewing state.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconEditOutlineRegular,
  IconTrashOutlineRegular,
  Input, MarkdownText, Modal, Pill, relativeTime,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceMemoryValue } from '../types.ts'
import { followMemory } from './rpc.ts'
import type { PageRemote } from './rpc.ts'
import type { WorkspaceMemoryKey } from './locales.ts'
import css from './Page.module.css'

/** Locale seat. */
export type PageTranslate = (key: WorkspaceMemoryKey, params?: Record<string, string | number>) => string

/** Workspace identity the page opens with. */
export interface PageWorkspace {
  workspaceId: string
  title: string
  path: string
}

/** One chat row: session title and last-updated time. */
export interface PageSession {
  id: string
  title: string
  updatedAt: number
}

/** One activity row: session title, turn number, and prompt preview. */
export interface PageActivityRow {
  sessionId: string
  sessionTitle: string
  turn: number
  prompt: string
}

/** Page props: viewing state plus the Remote verbs and navigation. */
export interface WorkspaceMemoryPageProps {
  /** Open Workspace identity, or null while no page is showing. */
  openWorkspaceId: string | null
  /** Header facts; null only while the record is still loading. */
  workspace: PageWorkspace | null
  /** Chat rows in workspace order. */
  sessions: readonly PageSession[]
  /** Activity rows ordered by session recency then turn, capped at 50. */
  activity: readonly PageActivityRow[]
  /** Throwing Remote verbs plus the follow transport. */
  remote: PageRemote
  /** Open a session and leave the page. */
  onOpenSession: (sessionId: string) => void
  /** Locale seat. */
  t: PageTranslate
}

/** File-picker add mode. */
type AddMode = { readonly kind: 'text' } | { readonly kind: 'file'; readonly query: string } | null

/**
 * Basename of a host path on either separator.
 * @param path - absolute host path.
 * @returns the final segment.
 */
export function outputBasename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] as string
}

/**
 * Workspace-relative directory of a produced file. Both separators compare
 * alike, so a Windows Workspace (`C:\proj`) still matches backslash output
 * paths; anything outside the Workspace falls back to the full directory.
 * @param workspacePath - canonical Workspace path.
 * @param path - absolute produced-file path.
 * @returns the containing directory relative to the Workspace, or '' at the root.
 */
export function outputDirectory(workspacePath: string, path: string): string {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = normalize(workspacePath)
  const full = normalize(path)
  const relative = full === root ? '' : full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full
  const parts = relative.split('/')
  parts.pop()
  return parts.join('/')
}

/**
 * Localized relative time for one durable instant.
 * @param t - locale seat.
 * @param at - epoch ms of the dated moment.
 * @param now - current epoch ms.
 * @returns localized bucket label.
 */
export function relativeLabel(t: PageTranslate, at: number, now: number): string {
  const { unit, n } = relativeTime(at, now)
  if (unit === 'now') return t('time.now')
  return t('time.ago', { t: t(`time.${unit}`, { n }) })
}

function tooLargeCopy(reason: unknown, t: PageTranslate): string | undefined {
  const code = (reason as { code?: string }).code
  if (code !== 'workspace-memory/too-large') return undefined
  const details = (reason as { details?: { bytes?: number; maxBytes?: number } }).details
  return t('error.tooLarge', { bytes: details?.bytes ?? 0, maxBytes: details?.maxBytes ?? 0 })
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Render the Workspace page.
 * @param props - viewing state, Remote verbs, and locale.
 * @returns the page element, or null while no Workspace is open.
 */
export function WorkspaceMemoryPage({
  openWorkspaceId, workspace, sessions, activity, remote, onOpenSession, t,
}: WorkspaceMemoryPageProps) {
  const [value, setValue] = useState<WorkspaceMemoryValue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'chats' | 'activity'>('chats')
  const [descEditing, setDescEditing] = useState(false)
  const [descDraft, setDescDraft] = useState('')
  const [instrEditing, setInstrEditing] = useState(false)
  const [instrDraft, setInstrDraft] = useState('')
  const [instrError, setInstrError] = useState<string | null>(null)
  const [memPreview, setMemPreview] = useState(false)
  const [memEditing, setMemEditing] = useState(false)
  const [memDraft, setMemDraft] = useState('')
  const [memError, setMemError] = useState<string | null>(null)
  const [addMode, setAddMode] = useState<AddMode>(null)
  const [textLabel, setTextLabel] = useState('')
  const [textDraft, setTextDraft] = useState('')
  const [fileResults, setFileResults] = useState<readonly string[]>([])
  const [fileSearching, setFileSearching] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [ends, setEnds] = useState({ prev: false, next: false })
  const trackRef = useRef<HTMLDivElement>(null)
  const markdownLabels = useMemo(() => ({
    code: { copyLabel: t('markdown.copy'), copiedLabel: t('markdown.copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])

  const measureEnds = (): void => {
    const track = trackRef.current
    if (track === null) return
    const prev = track.scrollLeft > 0
    const next = track.scrollLeft + track.clientWidth < track.scrollWidth
    setEnds(current => (current.prev === prev && current.next === next ? current : { prev, next }))
  }

  // The resident composer docks into this page's band: the conversation's seat
  // reads the band's box off the document root — the two subtrees' nearest
  // shared ancestor, the same channel that carries --dsh-composer-height the
  // other way. The offsets are measured against the page's own box, which
  // starts where the conversation's column does, so the seat lands on the left
  // column the outputs and the chats fill. The observer watches the boxes that
  // move the band: the intro (its height, as the description wraps), the band
  // (the column's width, as the rail wraps under it), and the page itself (a
  // column resize).
  const pageRef = useRef<HTMLElement | null>(null)
  const introRef = useRef<HTMLDivElement | null>(null)
  const bandRef = useRef<HTMLDivElement | null>(null)
  const bandObserver = useRef<ResizeObserver | null>(null)
  const publishBandBox = useCallback((): void => {
    const page = pageRef.current
    const band = bandRef.current
    const style = document.documentElement.style
    if (page === null || band === null) {
      style.removeProperty('--dsh-page-composer-top')
      style.removeProperty('--dsh-page-composer-left')
      style.removeProperty('--dsh-page-composer-right')
      return
    }
    const pageBox = page.getBoundingClientRect()
    const bandBox = band.getBoundingClientRect()
    style.setProperty('--dsh-page-composer-top', `${band.offsetTop}px`)
    style.setProperty('--dsh-page-composer-left', `${bandBox.left - pageBox.left}px`)
    style.setProperty('--dsh-page-composer-right', `${pageBox.right - bandBox.right}px`)
  }, [])
  // No dependency array: the boxes mount with the record, so every render
  // republishes against whatever is on screen (observing an already-observed
  // element is a no-op).
  useLayoutEffect(() => {
    publishBandBox()
    // Runtimes without the observer (jsdom) keep that one measurement.
    if (typeof ResizeObserver === 'undefined') return
    bandObserver.current ??= new ResizeObserver(() => { publishBandBox() })
    for (const node of [pageRef.current, introRef.current, bandRef.current]) {
      if (node !== null) bandObserver.current.observe(node)
    }
  })
  useEffect(() => () => {
    bandObserver.current?.disconnect()
    const style = document.documentElement.style
    style.removeProperty('--dsh-page-composer-top')
    style.removeProperty('--dsh-page-composer-left')
    style.removeProperty('--dsh-page-composer-right')
  }, [])

  useEffect(() => {
    if (openWorkspaceId === null) return
    let cancelled = false
    setValue(null)
    setError(null)
    void remote.read(openWorkspaceId as WorkspaceId).then(
      (next) => { if (!cancelled) setValue(next) },
      (reason: unknown) => { if (!cancelled) setError(messageOf(reason)) },
    )
    return () => { cancelled = true }
  }, [openWorkspaceId, remote])

  useEffect(() => {
    if (openWorkspaceId === null) return
    let cancelled = false
    const stream = followMemory(remote, {
      replace: (values) => {
        if (cancelled) return
        setValue(values.find(entry => String(entry.workspaceId) === openWorkspaceId) ?? null)
      },
      upsert: (entry) => {
        if (cancelled || String(entry.workspaceId) !== openWorkspaceId) return
        setValue(entry)
      },
      failed: (failure: unknown) => {
        /* v8 ignore next -- the snapshot stream suppresses failures once
        disposed, and disposal always accompanies cancellation. */
        if (!cancelled) setError(messageOf(failure))
      },
    })
    return () => {
      cancelled = true
      void stream.dispose()
    }
  }, [openWorkspaceId, remote])

  useEffect(() => {
    if (addMode?.kind !== 'file' || openWorkspaceId === null) return
    const query = addMode.query
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setFileSearching(true)
      void remote.listContextFiles(openWorkspaceId as WorkspaceId, query, controller.signal).then(
        (paths) => {
          if (controller.signal.aborted) return
          setFileResults(paths)
          setFileSearching(false)
        },
        (reason: unknown) => {
          if (controller.signal.aborted) return
          setFileError(messageOf(reason))
          setFileSearching(false)
        },
      )
    }, 250)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [addMode, openWorkspaceId, remote])

  useEffect(() => {
    measureEnds()
  })

  if (openWorkspaceId === null || workspace === null) return null

  const saveDescription = (description: string): void => {
    setDescEditing(false)
    void remote.setDescription(workspace.workspaceId as WorkspaceId, description).then(
      setValue,
      (reason: unknown) => { setError(messageOf(reason)) },
    )
  }

  const saveInstructions = (): void => {
    void remote.setInstructions(workspace.workspaceId as WorkspaceId, instrDraft).then(
      (next) => {
        setValue(next)
        setInstrEditing(false)
        setInstrError(null)
      },
      (reason: unknown) => {
        setInstrError(tooLargeCopy(reason, t) ?? messageOf(reason))
      },
    )
  }

  const saveMemory = (): void => {
    void remote.setMemory(workspace.workspaceId as WorkspaceId, memDraft).then(
      (next) => {
        setValue(next)
        setMemEditing(false)
        setMemError(null)
      },
      (reason: unknown) => {
        setMemError(tooLargeCopy(reason, t) ?? messageOf(reason))
      },
    )
  }

  const removeItem = (itemId: string): void => {
    void remote.removeContextItem(workspace.workspaceId as WorkspaceId, itemId).then(
      setValue,
      (reason: unknown) => { setError(messageOf(reason)) },
    )
  }

  const saveTextItem = (): void => {
    if (textDraft.trim().length === 0) return
    const label = textLabel.trim() === '' ? t('context.textLabel') : textLabel.trim()
    void remote.addTextItem(workspace.workspaceId as WorkspaceId, label, textDraft).then(
      (next) => {
        setValue(next)
        setAddMode(null)
        setTextLabel('')
        setTextDraft('')
      },
      (reason: unknown) => { setError(messageOf(reason)) },
    )
  }

  const addFilePath = (path: string): void => {
    void remote.addFileItem(workspace.workspaceId as WorkspaceId, outputBasename(path), path).then(
      (next) => {
        setValue(next)
        setAddMode(null)
      },
      (reason: unknown) => { setError(messageOf(reason)) },
    )
  }

  const usedBytes = value?.usage.usedBytes ?? 0
  const capacityBytes = value?.usage.capacityBytes ?? 0
  // The outputs and context sections render only for a loaded record, so
  // these lists are the single null-tolerant read each section reuses.
  const outputs = value?.outputs ?? []
  const contextItems = value?.contextItems ?? []
  const capacityPct = Math.min(100, (usedBytes / Math.max(1, capacityBytes)) * 100)
  const memoryTime = value?.memoryUpdatedAt === null || value?.memoryUpdatedAt === undefined
    ? null
    : relativeLabel(t, Date.parse(value.memoryUpdatedAt), Date.now())
  const loading = value === null && error === null

  const openInstructionEditor = (): void => {
    setInstrDraft(value?.instructions ?? '')
    setInstrError(null)
    setInstrEditing(true)
  }

  const openMemoryEditor = (): void => {
    setMemDraft(value?.memory ?? '')
    setMemError(null)
    setMemEditing(true)
  }

  const openDescriptionEditor = (draft: string): void => {
    setDescDraft(draft)
    setDescEditing(true)
  }

  return (
    <section ref={pageRef} className={css.page} aria-label={t('page.title')} data-testid="workspace-memory-page">
      <div className={css.introRow}>
        <div ref={introRef} className={css.intro}>
          <h1 className={css.title}>{workspace.title}</h1>
          <p className={css.path}>{workspace.path}</p>
          <section aria-label={t('description.label')} className={css.description}>
            {descEditing
              ? (
                <>
                  <textarea
                    className={css.editor}
                    aria-label={t('description.label')}
                    value={descDraft}
                    autoFocus
                    onChange={(event) => { setDescDraft(event.target.value) }}
                    onBlur={() => { saveDescription(descDraft) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setDescEditing(false)
                    }}
                  />
                  <div className={css.actions}>
                    <Button variant="primary" size="sm" onClick={() => { saveDescription(descDraft) }}>{t('description.save')}</Button>
                    <Button variant="outline" size="sm" onClick={() => { setDescEditing(false) }}>{t('description.cancel')}</Button>
                  </div>
                </>
              )
              : (value !== null && value.description !== ''
                ? (
                  <button type="button" className={css.descriptionText} onClick={() => { openDescriptionEditor(value.description) }}>
                    <span>{value.description}</span>
                    <IconEditOutlineRegular className={css.edit} />
                  </button>
                )
                : (
                  <button
                    type="button"
                    className={`${css.descriptionText} ${css.descriptionPlaceholder}`}
                    onClick={() => { openDescriptionEditor('') }}
                  >
                    <span>{t('description.placeholder')}</span>
                    <IconEditOutlineRegular className={css.edit} />
                  </button>
                ))}
          </section>
        </div>
      </div>

      <div className={css.columns}>
        <div className={css.column}>
          {(loading || error !== null) && (
            <div className={css.notice}>
              {loading && <p role="status" className={css.status}>{t('page.loading')}</p>}
              {error !== null && <p role="alert" className={css.error}>{error}</p>}
            </div>
          )}

          {/* The band the resident composer docks into: transparent, so the seat
              painted by the conversation underneath shows through, and reserved at
              the seat's published height so the body starts below the card. It
              sits outside the body's scrollport, so the composer never moves. */}
          <div ref={bandRef} className={css.band} data-page-band="" />

          <div className={css.body} style={{ paddingTop: '10px' }} >
            <section aria-label={t('outputs.title')} className={css.section}>
              <div className={css.sectionHead}>
                <h2 className={css.sectionTitle}>{t('outputs.title')}</h2>
                {outputs.length > 0 && (
                  <div className={css.railNav}>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<IconChevronLeftOutlineRegular />}
                      aria-label={t('outputs.previous')}
                      disabled={!ends.prev}
                      onClick={() => {
                        const track = trackRef.current
                        /* v8 ignore next -- the buttons mount with the track, so a click always finds the ref set. */
                        if (track === null) return
                        track.scrollLeft -= track.clientWidth
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<IconChevronRightOutlineRegular />}
                      aria-label={t('outputs.next')}
                      disabled={!ends.next}
                      onClick={() => {
                        const track = trackRef.current
                        /* v8 ignore next -- the buttons mount with the track, so a click always finds the ref set. */
                        if (track === null) return
                        track.scrollLeft += track.clientWidth
                      }}
                    />
                  </div>
                )}
              </div>
              {outputs.length === 0
                ? <p className={css.empty}>{t('outputs.empty')}</p>
                : (
                  <div ref={trackRef} data-testid="workspace-memory-track" className={css.tiles} onScroll={measureEnds}>
                    {outputs.map((entry) => {
                      const directory = outputDirectory(workspace.path, entry.path)
                      return (
                        <button
                          key={entry.path}
                          type="button"
                          className={css.tile}
                          title={entry.path}
                          onClick={() => { onOpenSession(entry.sessionId) }}
                        >
                          <span className={css.tileName}>{outputBasename(entry.path)}</span>
                          <span className={css.tileMeta}>
                            {directory === '' ? entry.tool : `${directory} · ${entry.tool}`}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
            </section>

            <section aria-label={t('chats.title')} className={css.section}>
              <div role="tablist" className={css.tabs}>
                <Pill role="tab" aria-selected={tab === 'chats'} active={tab === 'chats'} onClick={() => { setTab('chats') }}>{t('chats.title')}</Pill>
                <Pill role="tab" aria-selected={tab === 'activity'} active={tab === 'activity'} onClick={() => { setTab('activity') }}>{t('activity.title')}</Pill>
              </div>
              {tab === 'chats'
                ? (sessions.length === 0
                  ? <p className={css.empty}>{t('chats.empty')}</p>
                  : (
                    <ul className={css.rows}>
                      {sessions.map(session => (
                        <li key={session.id}>
                          <button type="button" className={css.row} onClick={() => { onOpenSession(session.id) }}>
                            <span className={css.rowTitle}>{session.title}</span>
                            <span className={css.rowMeta}>{relativeLabel(t, session.updatedAt, Date.now())}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ))
                : (activity.length === 0
                  ? <p className={css.empty}>{t('activity.empty')}</p>
                  : (
                    <ul className={css.rows}>
                      {activity.map(row => (
                        <li key={`${row.sessionId}:${row.turn}`}>
                          <button
                            type="button"
                            className={`${css.row} ${css.rowStacked}`}
                            onClick={() => { onOpenSession(row.sessionId) }}
                          >
                            <span className={css.rowHead}>
                              <span className={css.rowTitle}>{row.sessionTitle}</span>
                              <span className={css.rowMeta}>{t('activity.turn', { n: row.turn })}</span>
                            </span>
                            <span className={css.rowPrompt}>{row.prompt}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ))}
            </section>
          </div>

        </div>
        <aside className={css.rail}>
          <section aria-label={t('card.instructions')} className={css.card}>
            <div className={css.cardHead}>
              <h2 className={css.cardTitle}>{t('card.instructions')}</h2>
              <Button variant="ghost" size="sm" icon={<IconEditOutlineRegular />} onClick={openInstructionEditor}>
                {t('card.edit')}
              </Button>
            </div>
            {value?.instructions === '' || value?.instructions === undefined
              ? <p className={css.empty}>{t('instructions.empty')}</p>
              : <p className={css.preview}>{value.instructions}</p>}
            {instrError !== null && <p role="alert" className={css.error}>{instrError}</p>}
          </section>

          <section aria-label={t('card.memory')} className={css.card}>
            <div className={css.cardHead}>
              <h2 className={css.cardTitle}>{t('card.memory')}</h2>
              <Button variant="ghost" size="sm" icon={<IconEditOutlineRegular />} onClick={openMemoryEditor}>
                {t('card.edit')}
              </Button>
            </div>
            {value?.memory === '' || value?.memory === undefined
              ? <p className={css.empty}>{t('memory.empty')}</p>
              : <p className={css.preview}>{value.memory}</p>}
            <p className={css.meta}>{memoryTime ?? t('memory.neverUpdated')}</p>
            {value?.lastExtraction !== null && value?.lastExtraction !== undefined && (
              <p className={css.meta}>{t('memory.model', { model: value.lastExtraction.model })}</p>
            )}
            <div className={css.cardFoot}>
              <Button variant="outline" size="sm" onClick={() => { setMemPreview(true) }}>{t('card.preview')}</Button>
            </div>
            {memError !== null && <p role="alert" className={css.error}>{memError}</p>}
          </section>

          <section aria-label={t('card.context')} className={css.card}>
            <div className={css.cardHead}>
              <h2 className={css.cardTitle}>{t('card.context')}</h2>
            </div>
            <p className={css.meta}>{t('card.capacity', { used: usedBytes, capacity: capacityBytes })}</p>
            <div className={css.capacity}>
              <div className={css.capacityFill} style={{ width: `${capacityPct}%` }} />
            </div>
            {contextItems.length === 0
              ? <p className={css.empty}>{t('context.empty')}</p>
              : (
                <ul className={css.contextList}>
                  {contextItems.map(item => (
                    <li key={item.id} className={css.contextItem}>
                      <span className={css.contextLabel}>{item.label}</span>
                      <span className={css.contextSize}>{item.sizeBytes}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<IconTrashOutlineRegular />}
                        aria-label={`${t('card.remove')} ${item.label}`}
                        onClick={() => { removeItem(item.id) }}
                      />
                    </li>
                  ))}
                </ul>
              )}
            {addMode === null && (
              <div className={css.cardFoot}>
                <Button variant="outline" size="sm" onClick={() => { setAddMode({ kind: 'text' }) }}>{t('card.addText')}</Button>
                <Button variant="outline" size="sm" onClick={() => { setAddMode({ kind: 'file', query: '' }); setFileResults([]); setFileError(null) }}>{t('card.addFile')}</Button>
              </div>
            )}
            {addMode?.kind === 'text' && (
              <div className={css.field}>
                <Input
                  aria-label={t('context.labelLabel')}
                  placeholder={t('context.labelPlaceholder')}
                  value={textLabel}
                  onChange={(event) => { setTextLabel(event.target.value) }}
                />
                <textarea
                  className={css.editor}
                  aria-label={t('context.textLabel')}
                  placeholder={t('context.textPlaceholder')}
                  value={textDraft}
                  onChange={(event) => { setTextDraft(event.target.value) }}
                />
                <div className={css.cardFoot}>
                  <Button variant="primary" size="sm" onClick={saveTextItem}>{t('card.save')}</Button>
                  <Button variant="outline" size="sm" onClick={() => { setAddMode(null) }}>{t('card.cancel')}</Button>
                </div>
              </div>
            )}
            {addMode?.kind === 'file' && (
              <div className={css.field}>
                <Input
                  aria-label={t('context.queryPlaceholder')}
                  placeholder={t('context.queryPlaceholder')}
                  value={addMode.query}
                  onChange={(event) => { setAddMode({ kind: 'file', query: event.target.value }) }}
                />
                {fileSearching && <p role="status" className={css.status}>{t('context.searching')}</p>}
                {fileError !== null && <p role="alert" className={css.error}>{fileError}</p>}
                {!fileSearching && fileError === null && fileResults.length === 0 && <p className={css.empty}>{t('context.noMatches')}</p>}
                {fileResults.length > 0 && (
                  <ul className={css.results}>
                    {fileResults.map(path => (
                      <li key={path}>
                        <button type="button" className={css.result} onClick={() => { addFilePath(path) }}>{path}</button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className={css.cardFoot}>
                  <Button variant="outline" size="sm" onClick={() => { setAddMode(null) }}>{t('card.cancel')}</Button>
                </div>
              </div>
            )}
          </section>
        </aside>
      </div>

      <Modal
        open={instrEditing}
        onClose={() => { setInstrEditing(false) }}
        closeLabel={t('page.close')}
        title={t('card.instructions')}
        className={css.textDialog ?? ''}
        contentClassName={css.textDialogContent ?? ''}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setInstrEditing(false) }}>{t('card.cancel')}</Button>
            <Button variant="primary" onClick={saveInstructions}>{t('card.save')}</Button>
          </>
        )}
      >
        <textarea
          className={`${css.editor} ${css.dialogEditor}`}
          aria-label={t('card.instructions')}
          value={instrDraft}
          onChange={(event) => { setInstrDraft(event.target.value) }}
        />
      </Modal>

      <Modal
        open={memPreview}
        onClose={() => { setMemPreview(false) }}
        closeLabel={t('page.close')}
        title={t('card.memory')}
        className={css.textDialog ?? ''}
        contentClassName={css.textDialogContent ?? ''}
        footer={<Button variant="outline" onClick={() => { setMemPreview(false) }}>{t('page.close')}</Button>}
      >
        <MarkdownText text={value?.memory ?? ''} labels={markdownLabels} />
      </Modal>

      <Modal
        open={memEditing}
        onClose={() => { setMemEditing(false) }}
        closeLabel={t('page.close')}
        title={t('card.memory')}
        className={css.textDialog ?? ''}
        contentClassName={css.textDialogContent ?? ''}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setMemEditing(false) }}>{t('card.cancel')}</Button>
            <Button variant="primary" onClick={saveMemory}>{t('card.save')}</Button>
          </>
        )}
      >
        <textarea
          className={`${css.editor} ${css.dialogEditor}`}
          aria-label={t('card.edit')}
          value={memDraft}
          onChange={(event) => { setMemDraft(event.target.value) }}
        />
      </Modal>
    </section>
  )
}
