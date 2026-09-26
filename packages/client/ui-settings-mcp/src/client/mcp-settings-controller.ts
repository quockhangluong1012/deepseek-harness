/**
 * The MCP settings page's state and Host calls.
 *
 * The page owns no configuration: every read and write goes through the
 * `mcpServers` Remote of `dsh-mcp-project-config`, which holds the two config
 * files. A write that extends what the model can reach is refused there unless
 * the approval seam grants it, so this controller only reports what the Host
 * answered and never assumes a write landed. Environment and header values are
 * write-only: no state here carries a stored value back to the page.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the ctx.remote Context merge and the Remote result vocabulary.
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.uiSession Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: merges the generated `mcpServers` namespace into `ctx.remote`.
import type {} from '@deepseek-ai/dsh-mcp-project-config/remote'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  McpMutationOutcome, McpMutationRefusal, McpServerLayer, McpServerUpsert, McpServerView, McpServersView,
} from '@deepseek-ai/dsh-mcp-project-config/types'
import type { McpSettingsLocaleKey } from './locales.ts'

/** One server declaration as the editor holds it: every field is the text in its control. */
export interface McpServerDraft {
  /** The `mcpServers` key. */
  readonly name: string
  /** The config file to write. */
  readonly layer: McpServerLayer
  /** The transport the declaration selects. */
  readonly transport: 'stdio' | 'http'
  /** Executable to start; read only for a stdio draft. */
  readonly command: string
  /** One argument per line; read only for a stdio draft. */
  readonly args: string
  /** One `NAME=value` per line; read only for a stdio draft. */
  readonly env: string
  /** Endpoint URL; read only for an http draft. */
  readonly url: string
  /** One `Name: value` per line; read only for an http draft. */
  readonly headers: string
  /** Declared trust label. */
  readonly trust: McpServerView['trust']
  /**
   * Whether the draft edits a declaration the files already hold. Such a save
   * asks the Host to keep the stored `env`/`headers` values, which this page
   * never reads.
   */
  readonly existing: boolean
}

/** Why a draft cannot become a request; each maps to one localized sentence. */
export type McpDraftProblem = 'name' | 'command' | 'url' | 'env' | 'headers'

/** Where the last attempt stopped, for the page's message area. */
export type McpNotice =
  | { readonly kind: 'load' }
  | { readonly kind: 'transport'; readonly detail: string }
  | { readonly kind: 'draft'; readonly problem: McpDraftProblem }
  | { readonly kind: 'refused'; readonly refusal: McpMutationRefusal; readonly detail: string | null }

/** What the MCP page renders. */
export interface McpSettingsState {
  /** Load lifecycle of the merged view. */
  readonly status: 'loading' | 'ready' | 'failed'
  /** The merged view, absent until the Host answers. */
  readonly view: McpServersView | null
  /** Whether a write is in flight. */
  readonly busy: boolean
  /** The last failure or refusal, absent while the page has nothing to report. */
  readonly notice: McpNotice | null
}

/** The face the page's slot registration injects. */
export interface McpSettingsFace {
  hooks: {
    /** Page snapshot bound by the renderer as `useMcpSettings`. */
    readonly mcpSettings: SnapshotStore<McpSettingsState>
  }
  /** Re-read the merged view. */
  refresh(): void
  /** Apply one draft, through the Host's approval-gated write. */
  save(draft: McpServerDraft): void
  /** Delete one declaration from one layer. */
  remove(name: string, layer: McpServerLayer): void
  /** Clear the message area. */
  dismiss(): void
  /** Page copy. */
  t: (key: McpSettingsLocaleKey) => string
}

/** The declaration a draft describes, or the first problem that prevents one. */
export type DraftDeclaration =
  | { readonly upsert: Omit<McpServerUpsert, 'sessionId'> }
  | { readonly problem: McpDraftProblem }

/**
 * Read one `left<separator>right` pair per line.
 * @param text - the staged multi-line text.
 * @param separator - the separator between the name and the value.
 * @param trimValue - whether the value's surrounding spaces are insignificant.
 * @returns the pairs, or undefined when a line carries no usable name/value split.
 */
function pairsOf(text: string, separator: string, trimValue: boolean): Record<string, string> | undefined {
  const pairs: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    const at = line.indexOf(separator)
    if (at <= 0) return undefined
    const value = line.slice(at + separator.length)
    pairs[line.slice(0, at).trim()] = trimValue ? value.trim() : value
  }
  return pairs
}

/**
 * Turn a draft into the declaration the Host writes.
 *
 * @param draft - the editor's staged declaration.
 * @returns the declaration, or the first problem that prevents one.
 */
export function draftDeclaration(draft: McpServerDraft): DraftDeclaration {
  const name = draft.name.trim()
  if (name.length === 0) return { problem: 'name' }
  const common = { name, layer: draft.layer, trust: draft.trust }
  if (draft.transport === 'stdio') {
    const command = draft.command.trim()
    if (command.length === 0) return { problem: 'command' }
    const env = pairsOf(draft.env, '=', false)
    if (env === undefined) return { problem: 'env' }
    return { upsert: { ...common, transport: 'stdio', command, args: draft.args.split('\n').map(line => line.trim()).filter(line => line.length > 0), env } }
  }
  const url = draft.url.trim()
  if (!/^https?:\/\//u.test(url)) return { problem: 'url' }
  const headers = pairsOf(draft.headers, ':', true)
  if (headers === undefined) return { problem: 'headers' }
  return { upsert: { ...common, transport: 'http', url, headers } }
}

/** Reads the session an approval ask is addressed to; a write with none is refused. */
export type McpSessionProvider = () => SessionId | undefined

/** Merged MCP configuration state and the Host calls the page makes. */
export class McpSettingsController {
  private readonly store = createSnapshotStore<McpSettingsState>({
    status: 'loading',
    view: null,
    busy: false,
    notice: null,
  })

  /**
   * @param ctx - the page plugin's context; `remote.mcpServers` answers.
   * @param session - reads the session the user is viewing, when the client
   * composes one; a write without it is refused before it reaches the Host.
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly session: McpSessionProvider,
  ) {}

  private patch(change: Partial<McpSettingsState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...change })
  }

  /** Read the merged configuration and every server's live state. */
  async load(): Promise<void> {
    this.patch({ status: 'loading' })
    const response = await this.ctx.remote.mcpServers.list()
    if (!response.ok) {
      this.patch({ status: 'failed', notice: { kind: 'transport', detail: response.error.message } })
      return
    }
    this.patch({ status: 'ready', view: response.value, notice: null })
  }

  /**
   * Apply one draft, then render whatever the Host answered. A page showing no
   * session cannot address the Host's approval ask, so it refuses the write.
   * @param draft - the staged declaration.
   */
  async save(draft: McpServerDraft): Promise<void> {
    const declaration = draftDeclaration(draft)
    if ('problem' in declaration) {
      this.patch({ notice: { kind: 'draft', problem: declaration.problem } })
      return
    }
    const sessionId = this.session()
    if (sessionId === undefined) {
      this.patch({ notice: { kind: 'refused', refusal: 'approval-required', detail: null } })
      return
    }
    this.patch({ busy: true })
    const response = await this.ctx.remote.mcpServers.upsert({
      ...declaration.upsert,
      // An edit starts from a blank secret field, so the Host keeps what the
      // file already holds and merges this draft's pairs over it.
      ...draft.existing ? { keepStoredSecrets: true } : {},
      sessionId,
    })
    this.settle(response)
  }

  /**
   * Delete one declaration from one layer.
   * @param name - the `mcpServers` key.
   * @param layer - the config file to delete it from.
   */
  async remove(name: string, layer: McpServerLayer): Promise<void> {
    const sessionId = this.session()
    if (sessionId === undefined) {
      this.patch({ notice: { kind: 'refused', refusal: 'approval-required', detail: null } })
      return
    }
    this.patch({ busy: true })
    const response = await this.ctx.remote.mcpServers.remove({ name, layer, sessionId })
    this.settle(response)
  }

  /** Publish one mutation's answer: a refusal is a result, not a transport failure. */
  private settle(response: RemoteResult<McpMutationOutcome>): void {
    if (!response.ok) {
      this.patch({ busy: false, notice: { kind: 'transport', detail: response.error.message } })
      return
    }
    const outcome = response.value
    this.patch({
      busy: false,
      status: 'ready',
      view: outcome.view,
      notice: outcome.ok || outcome.refusal === null
        ? null
        : { kind: 'refused', refusal: outcome.refusal, detail: outcome.detail },
    })
  }

  /**
   * Build the face the page's slot registration injects.
   * @param t - the page's locale reader.
   * @returns the page snapshot, its actions, and its copy.
   */
  inject(t: (key: McpSettingsLocaleKey) => string): McpSettingsFace {
    return {
      hooks: { mcpSettings: this.store },
      refresh: () => { void this.load() },
      save: (draft) => { void this.save(draft) },
      remove: (name, layer) => { void this.remove(name, layer) },
      dismiss: () => { this.patch({ notice: null }) },
      t,
    }
  }
}
