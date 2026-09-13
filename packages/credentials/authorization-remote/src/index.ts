/**
 * Host owner of the `authorization` Remote namespace: the conversational half
 * of `ctx.authorization` as a browser surface drives it.
 *
 * A sign-in flow is a conversation — the Host shows a page, the human answers
 * a question — but a Remote call is one request producing one result. This
 * service bridges the two with attempts: `begin` opens an attempt and runs its
 * flow in the background, `frames` polls the conversation since a cursor, and
 * `answer`/`decline` settle one pending prompt. Prompt answers travel only
 * from the browser toward the Host; notices, prompts, and the terminal
 * outcome travel only toward the browser. Stored credential values never ride
 * any method here.
 *
 * @module @deepseek-ai/dsh-authorization-remote
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import {
  AuthorizationDeclinedError,
  AuthorizationError,
} from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationEntry,
  AuthorizationNotice,
  AuthorizationPrompt,
} from '@deepseek-ai/dsh-authorization'
import { credentialKeyId, credentialKeyScope, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AuthorizationAttemptView,
  AuthorizationFlowView,
  AuthorizationFrameView,
  AuthorizationFramesView,
  AuthorizationOutcomeStatus,
  AuthorizationPromptView,
  AuthorizationStatusView,
} from './types.ts'

export type {
  AuthorizationAttemptView,
  AuthorizationFlowView,
  AuthorizationFrameView,
  AuthorizationFramesView,
  AuthorizationMethodView,
  AuthorizationOutcomeStatus,
  AuthorizationPromptOptionView,
  AuthorizationPromptView,
  AuthorizationStatusView,
} from './types.ts'

/** How many settled attempts are retained for late `frames` polls. */
const MAX_RETAINED_ATTEMPTS = 50

/** One prompt the flow waits on. */
interface PendingPrompt {
  /** Settles the promise the flow's `prompt` call awaits. */
  resolve: (value: string) => void
  /** Settles it as declined, withdrawn, or failed. */
  reject: (error: unknown) => void
  /** False once withdrawn by its flow or answered, while the attempt continues. */
  active: boolean
}

/** One attempt a browser surface follows. */
interface Attempt {
  /** The credential record this attempt authorizes. */
  key: CredentialKey
  /** User-facing name of what is being authorized. */
  label: string
  /** The method id this attempt runs. */
  method: string
  /** The conversation so far, in ascending `seq` order. */
  frames: AuthorizationFrameView[]
  /** Prompts the flow waits on, by prompt id. */
  pending: Map<string, PendingPrompt>
  /** Prompt ids minted so far. */
  prompts: number
  /** True once the attempt settled; `outcome` is then present. */
  done: boolean
  /** How the attempt ended; present only once `done` is true. */
  outcome?: AuthorizationOutcomeStatus
}

/** The attempt id the follow-up calls address. */
interface AttemptAddress {
  /** The attempt, never one that was evicted. */
  attempt: Attempt
  /** The id it was stored under. */
  attemptId: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `authorization` Remote namespace. */
    authorizationRemote: AuthorizationRemoteService
  }
}

/** Readable diagnostic for a flow failure, which the wire carries as text. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Host service backing the generated `ctx.remote.authorization` namespace.
 * Every method validates its wire ids before touching the seam, and every
 * seam refusal reaches the caller as a namespaced `authorization/*` failure
 * rather than a transport error.
 */
export class AuthorizationRemoteService extends TypertRemoteService {
  /** The flow registry and the record store this namespace converses through. */
  static inject = ['authorization', 'credentials']

  private readonly attempts = new Map<string, Attempt>()

  /** @param ctx - Host context where the authorization seam is mounted. */
  constructor(ctx: Context) {
    super(ctx, 'authorizationRemote', { namespace: 'authorization' })
  }

  /**
   * Every registered flow, for a surface listing what can be authorized.
   * @returns one view per flow, in registration order.
   */
  @Remote
  list(): AuthorizationFlowView[] {
    return this.ctx.authorization.list().map(flow => this.viewOf(flow))
  }

  /**
   * One registered flow.
   * @param key - the credential record as `scope/id`.
   * @returns the flow's view.
   * @throws RemoteError code `gateway/bad-request` when the key is malformed,
   *   or `authorization/no-flow` when nothing claims it.
   */
  @Remote
  describe(key: string): AuthorizationFlowView {
    const parsed = this.parseKey(key)
    const flow = this.ctx.authorization.describe(parsed)
    if (flow === undefined) {
      throw new RemoteError('authorization/no-flow', `no authorization flow is registered for "${key}"`, { key })
    }
    return this.viewOf(flow)
  }

  /**
   * Whether a stored grant exists for a record, without revealing anything it
   * holds.
   * @param key - the credential record as `scope/id`.
   * @returns the stored state.
   * @throws RemoteError code `gateway/bad-request` when the key is malformed.
   */
  @Remote
  async status(key: string): Promise<AuthorizationStatusView> {
    const stored = await this.provider().describeRecord(this.parseKey(key))
    return { configured: stored.configured }
  }

  /**
   * Forget the stored grant for a record. The issuer is not told: a provider
   * that needs a server-side revoke has no place to declare it.
   * @param key - the credential record as `scope/id`.
   * @throws RemoteError code `gateway/bad-request` when the key is malformed.
   */
  @Remote
  async signOut(key: string): Promise<void> {
    await this.provider().deleteRecord(this.parseKey(key))
  }

  /**
   * Open an attempt for a record and run its flow in the background. The
   * attempt's conversation is then polled through `frames`, and its pending
   * prompts answered through `answer` and `decline`.
   * @param key - the credential record as `scope/id`.
   * @param method - which of the flow's methods to run; the flow's first when
   *   absent.
   * @returns the attempt to follow.
   * @throws RemoteError code `gateway/bad-request` when the key is malformed,
   *   `authorization/no-flow` when nothing claims the key,
   *   `authorization/unknown-method` when the method is not offered, or
   *   `authorization/in-flight` when an attempt already runs for the key.
   */
  @Remote
  begin(key: string, method: string | undefined): AuthorizationAttemptView {
    const parsed = this.parseKey(key)
    const flow = this.ctx.authorization.describe(parsed)
    if (flow === undefined) {
      throw new RemoteError('authorization/no-flow', `no authorization flow is registered for "${key}"`, { key })
    }
    const resolved = method ?? flow.methods[0].id
    if (resolved.length === 0 || !flow.methods.some(candidate => candidate.id === resolved)) {
      throw new RemoteError(
        'authorization/unknown-method',
        `authorization flow for "${key}" offers no method "${resolved}"`,
        { key, method: resolved },
      )
    }
    if (flow.inFlight) {
      throw new RemoteError(
        'authorization/in-flight', `an authorization attempt for "${key}" is already running`, { key })
    }
    const attemptId = randomUUID()
    const attempt: Attempt = {
      key: parsed,
      label: flow.label,
      method: resolved,
      frames: [],
      pending: new Map(),
      prompts: 0,
      done: false,
    }
    this.remember(attemptId, attempt)
    void this.ctx.authorization.begin({
      key: parsed,
      method: resolved,
      interaction: {
        notify: notice => { this.pushNotice(attempt, notice) },
        prompt: prompt => this.waitForAnswer(attempt, prompt),
      },
    }).then(
      outcome => { this.finish(attempt, outcome.status) },
      (error: unknown) => { this.finish(attempt, 'failed', messageOf(error)) },
    )
    return { attemptId, key: flow.key, label: flow.label, method: resolved }
  }

  /**
   * The attempt's conversation after a cursor.
   * @param attemptId - the id `begin` returned.
   * @param cursor - the `next` value of the previous poll, or 0 to read from
   *   the start.
   * @returns the frames after the cursor, with the terminal state.
   * @throws RemoteError code `gateway/bad-request` when either id is
   *   malformed, or `authorization/unknown-attempt` when no attempt runs
   *   under the id.
   */
  @Remote
  frames(attemptId: string, cursor: number): AuthorizationFramesView {
    const { attempt } = this.address(attemptId)
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new RemoteError('gateway/bad-request', `invalid cursor for authorization frames: ${String(cursor)}`, {})
    }
    return {
      frames: attempt.frames.slice(cursor),
      next: attempt.frames.length,
      done: attempt.done,
      ...attempt.outcome === undefined ? {} : { outcome: attempt.outcome },
    }
  }

  /**
   * Answer one pending prompt.
   * @param attemptId - the id `begin` returned.
   * @param promptId - the id of the prompt frame to answer.
   * @param value - the typed text, or the chosen option's id; never empty.
   * @throws RemoteError code `gateway/bad-request` when an id is malformed or
   *   the value is empty, `authorization/unknown-attempt` when no attempt runs
   *   under the id, `authorization/unknown-prompt` when the attempt holds no
   *   such prompt, or `authorization/inactive-prompt` when it was already
   *   answered or withdrawn.
   */
  @Remote
  async answer(attemptId: string, promptId: string, value: string): Promise<void> {
    const { attempt } = this.address(attemptId)
    this.checkPromptId(promptId)
    if (typeof value !== 'string' || value.length === 0) {
      throw new RemoteError('gateway/bad-request', 'an authorization prompt answer must not be empty', {})
    }
    this.settlePrompt(attempt, attemptId, promptId, { kind: 'answer', value })
  }

  /**
   * Decline one pending prompt. A declined prompt settles the attempt as
   * `cancelled`, the same outcome as withdrawing it.
   * @param attemptId - the id `begin` returned.
   * @param promptId - the id of the prompt frame to decline.
   * @throws RemoteError code `gateway/bad-request` when an id is malformed,
   *   `authorization/unknown-attempt` when no attempt runs under the id,
   *   `authorization/unknown-prompt` when the attempt holds no such prompt, or
   *   `authorization/inactive-prompt` when it was already answered or
   *   withdrawn.
   */
  @Remote
  async decline(attemptId: string, promptId: string): Promise<void> {
    const { attempt } = this.address(attemptId)
    this.checkPromptId(promptId)
    this.settlePrompt(attempt, attemptId, promptId, { kind: 'decline' })
  }

  /**
   * Settle one pending prompt by answering or declining it.
   * @param attempt - the attempt holding the prompt.
   * @param attemptId - the id the attempt was stored under.
   * @param promptId - the id of the prompt frame to settle.
   * @param decision - the answer value, or a decline.
   * @throws RemoteError code `authorization/unknown-prompt` when the attempt
   *   holds no such prompt, or `authorization/inactive-prompt` when it was
   *   already answered or withdrawn.
   */
  private settlePrompt(
    attempt: Attempt,
    attemptId: string,
    promptId: string,
    decision: { kind: 'answer'; value: string } | { kind: 'decline' },
  ): void {
    const pending = attempt.pending.get(promptId)
    if (pending === undefined) {
      throw new RemoteError(
        'authorization/unknown-prompt',
        `attempt "${attemptId}" holds no prompt "${promptId}"`,
        { attempt: attemptId, prompt: promptId },
      )
    }
    if (!pending.active) {
      throw new RemoteError(
        'authorization/inactive-prompt',
        `prompt "${promptId}" on attempt "${attemptId}" is no longer answerable`,
        { attempt: attemptId, prompt: promptId },
      )
    }
    pending.active = false
    attempt.pending.delete(promptId)
    if (decision.kind === 'answer') pending.resolve(decision.value)
    else pending.reject(new AuthorizationDeclinedError())
  }

  /**
   * Withdraw the attempt running for a record, if any. A withdrawn attempt
   * settles as `cancelled`.
   * @param key - the credential record as `scope/id`.
   * @throws RemoteError code `gateway/bad-request` when the key is malformed.
   */
  @Remote
  async cancel(key: string): Promise<void> {
    this.ctx.authorization.cancel(this.parseKey(key))
  }

  /**
   * The public view of one registered flow.
   * @param flow - the seam's entry.
   * @returns the wire view a surface renders.
   */
  private viewOf(flow: AuthorizationEntry): AuthorizationFlowView {
    return {
      key: flow.key,
      scope: credentialKeyScope(flow.key),
      id: credentialKeyId(flow.key),
      label: flow.label,
      methods: flow.methods.map(method => ({ id: method.id, label: method.label })),
      inFlight: flow.inFlight,
    }
  }

  /**
   * Parse a wire record key.
   * @param key - the record as `scope/id`.
   * @returns the branded key.
   * @throws RemoteError code `gateway/bad-request` when the key is malformed.
   */
  private parseKey(key: string): CredentialKey {
    try {
      return parseCredentialKey(key)
    } catch {
      throw new RemoteError('gateway/bad-request', `invalid credential record key: ${JSON.stringify(key)}`, {})
    }
  }

  /**
   * Resolve the attempt an id addresses.
   * @param attemptId - the id `begin` returned.
   * @returns the attempt with the id it was stored under.
   * @throws RemoteError code `gateway/bad-request` when the id is malformed,
   *   or `authorization/unknown-attempt` when no attempt runs under it.
   */
  private address(attemptId: string): AttemptAddress {
    if (typeof attemptId !== 'string' || attemptId.length === 0 || attemptId.length > 128) {
      throw new RemoteError('gateway/bad-request', 'invalid authorization attempt id', {})
    }
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined) {
      throw new RemoteError(
        'authorization/unknown-attempt', `no authorization attempt runs under "${attemptId}"`, { attempt: attemptId })
    }
    return { attempt, attemptId }
  }

  /**
   * Reject a malformed prompt id.
   * @param promptId - the id of a prompt frame.
   * @throws RemoteError code `gateway/bad-request` when the id is malformed.
   */
  private checkPromptId(promptId: string): void {
    if (typeof promptId !== 'string' || promptId.length === 0 || promptId.length > 64) {
      throw new RemoteError('gateway/bad-request', 'invalid authorization prompt id', {})
    }
  }

  /** The credential provider this namespace reads and forgets grants through. */
  private provider(): CredentialProvider {
    return this.ctx.credentials
  }

  /**
   * Store an attempt, evicting past the bound oldest-first, settled first.
   * @param attemptId - the id to store under.
   * @param attempt - the attempt to store.
   */
  private remember(attemptId: string, attempt: Attempt): void {
    this.attempts.set(attemptId, attempt)
    while (this.attempts.size > MAX_RETAINED_ATTEMPTS) {
      const settled = [...this.attempts].find(([, candidate]) => candidate.done)?.[0]
      this.attempts.delete(settled ?? (this.attempts.keys().next().value as string))
    }
  }

  /**
   * Append a notice frame.
   * @param attempt - the attempt to append to.
   * @param notice - what the flow reported; never carries a secret.
   */
  private pushNotice(attempt: Attempt, notice: AuthorizationNotice): void {
    attempt.frames.push({
      seq: attempt.frames.length,
      kind: 'notice',
      message: notice.message,
      ...notice.url === undefined ? {} : { url: notice.url },
      ...notice.code === undefined ? {} : { code: notice.code },
    })
  }

  /**
   * Append a prompt frame and wait for its answer.
   * @param attempt - the attempt to append to.
   * @param prompt - what the flow asked.
   * @returns the typed text, or the chosen option's id.
   * @throws when the human declines, or the flow withdraws the prompt.
   */
  private waitForAnswer(attempt: Attempt, prompt: AuthorizationPrompt): Promise<string> {
    attempt.prompts += 1
    const id = `p${String(attempt.prompts)}`
    const view: AuthorizationPromptView = {
      id,
      kind: prompt.kind,
      message: prompt.message,
      ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      ...prompt.kind !== 'select' ? {} : {
        options: prompt.options.map(option => ({
          id: option.id,
          label: option.label,
          ...option.description === undefined ? {} : { description: option.description },
        })),
      },
    }
    attempt.frames.push({ seq: attempt.frames.length, kind: 'prompt', prompt: view })
    return new Promise<string>((resolve, reject) => {
      attempt.pending.set(id, { resolve, reject, active: true })
      prompt.signal?.addEventListener('abort', () => {
        const pending = attempt.pending.get(id)
        if (pending === undefined) return
        pending.active = false
        attempt.frames.push({ seq: attempt.frames.length, kind: 'prompt-withdrawn', promptId: id })
        reject(new AuthorizationError('the flow withdrew its prompt before it was answered', 'WITHDRAWN'))
      }, { once: true })
    })
  }

  /**
   * Settle an attempt and append its outcome frame.
   * @param attempt - the attempt to settle.
   * @param status - how it ended.
   * @param error - the flow's own diagnostic when it failed.
   */
  private finish(attempt: Attempt, status: AuthorizationOutcomeStatus, error?: string): void {
    /* v8 ignore next -- the seam settles every attempt exactly once, so the
       paired resolver below never runs twice; the guard keeps a second
       settlement from appending a second outcome frame if that ever changes. */
    if (attempt.done) return
    attempt.done = true
    attempt.outcome = status
    attempt.frames.push({
      seq: attempt.frames.length,
      kind: 'outcome',
      status,
      ...error === undefined ? {} : { error },
    })
  }
}

export default AuthorizationRemoteService
