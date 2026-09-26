/**
 * MCP settings section: the servers declared in the project and user config
 * files, each with its trust label and live connection state, one editor at a
 * time, and one confirmation per removal.
 *
 * The section owns no configuration. It renders the Host's merged view and
 * sends drafts back through the Host's approval-gated service, which refuses a
 * reach-extending change when no approval answers. Stored `env` and `headers`
 * values never reach this page: the list shows their names, the editor starts
 * them blank, and a save merges over what the file already holds.
 */

import { useState } from 'react'
import { Button, Input, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { McpServerLayer, McpServerView } from '@deepseek-ai/dsh-mcp-project-config/types'
import { en } from './locales.ts'
import type { McpNotice, McpServerDraft, McpSettingsFace, McpSettingsState } from './mcp-settings-controller.ts'
import styles from './McpServersSection.module.css'

/**
 * Props delivered by the slot outlet: the inject face spread flat. Partial
 * because the renderer binds the face when the slot declaration resolves, and
 * a section rendered before that has nothing to show.
 */
export type McpServersSectionProps = Partial<InjectFace<McpSettingsFace>>

type Copy = (key: keyof typeof en) => string

/** The mark and tone one connection state renders as. */
function statusMark(state: McpServerView['state']): StateDotState {
  if (state.kind === 'not-mounted') return 'idle'
  switch (state.status) {
    case 'connected': return 'done'
    case 'connecting': return 'ongoing'
    case 'reconnecting': return 'warning'
    case 'disconnected': return 'error'
  }
}

/** The localized label of one connection state. */
function statusLabel(state: McpServerView['state'], t: Copy): string {
  if (state.kind === 'not-mounted') return t('statusNotMounted')
  switch (state.status) {
    case 'connected': return t('statusConnected')
    case 'connecting': return t('statusConnecting')
    case 'reconnecting': return t('statusReconnecting')
    case 'disconnected': return t('statusDisconnected')
  }
}

/** The tone one declared trust label renders as. */
function trustTone(trust: McpServerView['trust']): TagTone {
  switch (trust) {
    case 'trusted': return 'success'
    case 'untrusted': return 'outline'
    case 'unknown': return 'quiet'
  }
}

/** The localized label of one trust label. */
function trustLabel(trust: McpServerView['trust'], t: Copy): string {
  switch (trust) {
    case 'trusted': return t('trustTrusted')
    case 'untrusted': return t('trustUntrusted')
    case 'unknown': return t('trustUnknown')
  }
}

/** The Host's own technical detail of one notice, when it has one. */
function noticeDetail(notice: McpNotice): string | null {
  if (notice.kind === 'transport') return notice.detail
  if (notice.kind === 'refused') return notice.detail
  return null
}

/** The localized sentence for one notice. */
function noticeCopy(notice: McpNotice, t: Copy): string {
  switch (notice.kind) {
    case 'load': return t('loadFailed')
    case 'transport': return t('requestFailed')
    case 'draft':
      switch (notice.problem) {
        case 'name': return t('problemName')
        case 'command': return t('problemCommand')
        case 'url': return t('problemUrl')
        case 'env': return t('problemEnv')
        case 'headers': return t('problemHeaders')
      }
    case 'refused':
      switch (notice.refusal) {
        case 'approval-required': return t('refusalApprovalRequired')
        case 'approval-refused': return t('refusalApprovalRefused')
        case 'invalid-declaration': return t('refusalInvalidDeclaration')
        case 'unknown-server': return t('refusalUnknownServer')
        case 'unreadable-config': return t('refusalUnreadableConfig')
      }
  }
}

/** The one-line endpoint summary of a server, without its credential values. */
function endpointSummary(server: McpServerView): string {
  const endpoint = server.endpoint
  if (endpoint === null) return server.state.kind === 'not-mounted' ? server.state.reason : ''
  if (endpoint.transport === 'stdio') return [endpoint.command, ...endpoint.args].join(' ')
  return endpoint.url
}

/** The secret names a declaration sets, for the one-line summary. */
function secretNames(server: McpServerView): readonly string[] {
  const endpoint = server.endpoint
  if (endpoint === null) return []
  return endpoint.transport === 'stdio' ? endpoint.envKeys : endpoint.headerNames
}

/** Server count, or the empty-state sentence. */
function listCopy(state: McpSettingsState, t: Copy): string {
  if (state.status === 'loading') return t('loading')
  if (state.view === null || state.view.servers.length === 0) return t('empty')
  return t('servers')
}

/** The draft an existing declaration opens in the editor with. */
function draftOf(server: McpServerView): McpServerDraft {
  const endpoint = server.endpoint
  return {
    name: server.name,
    layer: server.layer,
    transport: endpoint?.transport ?? 'stdio',
    command: endpoint?.transport === 'stdio' ? endpoint.command : '',
    args: endpoint?.transport === 'stdio' ? endpoint.args.join('\n') : '',
    env: '',
    url: endpoint?.transport === 'http' ? endpoint.url : '',
    headers: '',
    trust: server.trust,
    existing: true,
  }
}

/** A new declaration's starting draft in one layer. */
function blankDraft(layer: McpServerLayer): McpServerDraft {
  return {
    name: '',
    layer,
    transport: 'stdio',
    command: '',
    args: '',
    env: '',
    url: '',
    headers: '',
    trust: 'untrusted',
    existing: false,
  }
}

/**
 * Render the MCP settings section: `null` until the renderer binds the face.
 * @param props - the injected face.
 * @returns the section, or nothing while the face is unbound.
 */
export function McpServersSection(props: McpServersSectionProps) {
  const { useMcpSettings } = props
  if (useMcpSettings === undefined) return null
  return <Bound face={props} useMcpSettings={useMcpSettings} />
}

/** The body, once the store hook and the face are both available. */
function Bound({ face, useMcpSettings }: {
  readonly face: McpServersSectionProps
  readonly useMcpSettings: NonNullable<McpServersSectionProps['useMcpSettings']>
}) {
  const state = useMcpSettings(snapshot => snapshot)
  const { save, remove, dismiss, refresh, t } = face
  if (save === undefined || remove === undefined || dismiss === undefined || refresh === undefined || t === undefined) return null
  return <Section state={state} save={save} remove={remove} dismiss={dismiss} refresh={refresh} t={t} />
}

/** The section body: the list, the editor, and the message area. */
function Section({ state, save, remove, dismiss, refresh, t }: {
  readonly state: McpSettingsState
  readonly save: McpSettingsFace['save']
  readonly remove: McpSettingsFace['remove']
  readonly dismiss: McpSettingsFace['dismiss']
  readonly refresh: McpSettingsFace['refresh']
  readonly t: Copy
}) {
  const [draft, setDraft] = useState<McpServerDraft | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{t('title')}</h2>
      <p className={styles.lead}>{t('description')}</p>
      {state.notice !== null
        && (
          <p className={styles.notice} role="status">
            {noticeCopy(state.notice, t)}
            {noticeDetail(state.notice) === null
              ? null
              : <span className={styles.detail}>{`${t('detail')}: ${noticeDetail(state.notice) ?? ''}`}</span>}
            <Button size="sm" onClick={dismiss}>{t('keep')}</Button>
          </p>
        )}
      <h3 className={styles.subheading}>{listCopy(state, t)}</h3>
      {state.view !== null
        && (
          <ul className={styles.list}>
            {state.view.servers.map(server => (
              <li key={`${server.layer}:${server.name}`} className={styles.row} data-server={server.name}>
                <StateDot state={statusMark(server.state)} />
                <span className={styles.name}>{server.name}</span>
                <span className={styles.status}>{statusLabel(server.state, t)}</span>
                <Tag tone={trustTone(server.trust)}>{trustLabel(server.trust, t)}</Tag>
                <Tag tone="quiet">{server.layer === 'project' ? t('layerProject') : t('layerUser')}</Tag>
                <span className={styles.endpoint}>{endpointSummary(server)}</span>
                <span className={styles.secrets}>{secretNames(server).join(', ')}</span>
                {server.state.kind === 'mounted' && server.state.attempt > 0
                  ? <span className={styles.attempt}>{`${t('attempt')} ${String(server.state.attempt)}/${String(server.state.maxAttempts)}`}</span>
                  : null}
                {confirming === `${server.layer}:${server.name}`
                  ? (
                    <>
                      <span className={styles.status}>{t('confirmRemove')}</span>
                      <Button size="sm" variant="primary" onClick={() => { setConfirming(null); remove(server.name, server.layer) }}>{t('remove')}</Button>
                      <Button size="sm" onClick={() => { setConfirming(null) }}>{t('keep')}</Button>
                    </>
                  )
                  : (
                    <>
                      <Button size="sm" onClick={() => { setDraft(draftOf(server)) }}>{t('edit')}</Button>
                      <Button size="sm" onClick={() => { setConfirming(`${server.layer}:${server.name}`) }}>{t('remove')}</Button>
                    </>
                  )}
              </li>
            ))}
          </ul>
        )}
      {draft === null
        ? (
          <div className={styles.actions}>
            <Button variant="primary" disabled={state.busy} onClick={() => { setDraft(blankDraft('project')) }}>{t('add')}</Button>
            <Button size="sm" onClick={refresh}>{t('refresh')}</Button>
          </div>
        )
        : (
          <Editor
            draft={draft}
            busy={state.busy}
            t={t}
            onPatch={(change) => { setDraft(current => current === null ? null : { ...current, ...change }) }}
            onCancel={() => { setDraft(null) }}
            onSave={(next) => { setDraft(null); save(next) }}
          />
        )}
      <p className={styles.lead}>{t('secretsNote')}</p>
    </section>
  )
}

/** The one open editor: a new declaration or an existing one being edited. */
function Editor({ draft, busy, t, onPatch, onCancel, onSave }: {
  readonly draft: McpServerDraft
  readonly busy: boolean
  readonly t: Copy
  readonly onPatch: (change: Partial<McpServerDraft>) => void
  readonly onCancel: () => void
  readonly onSave: (draft: McpServerDraft) => void
}) {
  return (
    <div className={styles.editor}>
      <h3 className={styles.subheading}>{draft.name.length === 0 ? t('addTitle') : t('editTitle')}</h3>
      <label className={styles.field}>
        <span>{t('name')}</span>
        <Input value={draft.name} disabled={busy} onChange={(event) => { onPatch({ name: event.target.value }) }} />
        <span className={styles.hint}>{t('nameHint')}</span>
      </label>
      <label className={styles.field}>
        <span>{t('layer')}</span>
        <select className={styles.select} value={draft.layer} disabled={busy} onChange={(event) => { onPatch({ layer: event.target.value === 'user' ? 'user' : 'project' }) }}>
          <option value="project">{t('layerProject')}</option>
          <option value="user">{t('layerUser')}</option>
        </select>
      </label>
      <label className={styles.field}>
        <span>{t('transport')}</span>
        <select className={styles.select} value={draft.transport} disabled={busy} onChange={(event) => { onPatch({ transport: event.target.value === 'http' ? 'http' : 'stdio' }) }}>
          <option value="stdio">{t('transportStdio')}</option>
          <option value="http">{t('transportHttp')}</option>
        </select>
      </label>
      {draft.transport === 'stdio'
        ? (
          <>
            <label className={styles.field}>
              <span>{t('command')}</span>
              <Input value={draft.command} disabled={busy} onChange={(event) => { onPatch({ command: event.target.value }) }} />
            </label>
            <label className={styles.field}>
              <span>{t('args')}</span>
              <textarea
                className={styles.textarea}
                value={draft.args}
                disabled={busy}
                onChange={(event) => { onPatch({ args: event.target.value }) }}
              />
              <span className={styles.hint}>{t('argsHint')}</span>
            </label>
            <label className={styles.field}>
              <span>{t('env')}</span>
              <textarea
                className={styles.textarea}
                value={draft.env}
                disabled={busy}
                onChange={(event) => { onPatch({ env: event.target.value }) }}
              />
              <span className={styles.hint}>{t('envHint')}</span>
            </label>
          </>
        )
        : (
          <>
            <label className={styles.field}>
              <span>{t('url')}</span>
              <Input value={draft.url} disabled={busy} onChange={(event) => { onPatch({ url: event.target.value }) }} />
            </label>
            <label className={styles.field}>
              <span>{t('headers')}</span>
              <textarea
                className={styles.textarea}
                value={draft.headers}
                disabled={busy}
                onChange={(event) => { onPatch({ headers: event.target.value }) }}
              />
              <span className={styles.hint}>{t('headersHint')}</span>
            </label>
          </>
        )}
      <label className={styles.field}>
        <span>{t('trust')}</span>
        <select className={styles.select} value={draft.trust} disabled={busy} onChange={(event) => {
          onPatch({ trust: event.target.value === 'trusted' ? 'trusted' : event.target.value === 'unknown' ? 'unknown' : 'untrusted' })
        }}>
          <option value="untrusted">{t('trustUntrusted')}</option>
          <option value="trusted">{t('trustTrusted')}</option>
          <option value="unknown">{t('trustUnknown')}</option>
        </select>
      </label>
      <div className={styles.actions}>
        <Button variant="primary" disabled={busy} onClick={() => { onSave(draft) }}>{busy ? t('saving') : t('save')}</Button>
        <Button disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  )
}
