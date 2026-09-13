/**
 * Sign-in companion for one Models provider card: the OAuth and interactive
 * login half of a `llm-pi-ai` route, rendered inside the card's
 * `settings.models.provider-card` seat. The page itself owns API keys; this
 * card owns every other method the route's authorization flow offers, so a
 * Claude Pro/Max subscription signs in through the flow pi-ai ships instead of
 * a key the subscription never issued.
 *
 * The card polls the attempt it opened: notices render as text with an
 * optional sign-in link and code, the latest unanswered prompt renders its
 * input, and the terminal outcome closes the loop. A stored grant renders a
 * signed-in state with a sign-out action; the Models page refreshes itself
 * through its own credential subscription once a grant lands.
 */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProviderCardExtrasOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {
  AuthorizationAttemptView,
  AuthorizationFlowView,
  AuthorizationFrameView,
  AuthorizationFramesView,
  AuthorizationOutcomeStatus,
  AuthorizationPromptView,
  RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { AuthorizationOperations } from './operations.ts'
import { en } from './locales.ts'
import styles from './SignInCard.module.css'

/** How often an open dialog polls its attempt while it runs. */
const POLL_INTERVAL_MS = 1200

/** Injected dependencies of {@link SignInCard}. */
export interface SignInCardInjected {
  /** The Host operations the card and its dialog invoke. */
  operations: AuthorizationOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Props delivered by the slot outlet: owner share plus inject face. */
export type SignInCardProps = Partial<InjectFace<SignInCardInjected>> & Partial<ProviderCardExtrasOwnerProps>

/** The card's snapshot of the flow registry and the stored grant. */
type Snapshot =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly flows: readonly AuthorizationFlowView[]; readonly stored: boolean }

/** A settled attempt, as the dialog reports it. */
interface Outcome {
  /** How the attempt ended. */
  readonly status: AuthorizationOutcomeStatus
  /** The flow's own diagnostic when it failed. */
  readonly error?: string
}

/**
 * The latest prompt no withdrawal retired and no answer settled, or undefined
 * when the conversation currently asks nothing.
 * @param frames - the attempt's frames in order.
 * @param answered - prompt ids this dialog already answered.
 * @returns the actionable prompt, if any.
 */
export function actionablePrompt(
  frames: readonly AuthorizationFrameView[],
  answered: ReadonlySet<string>,
): AuthorizationPromptView | undefined {
  const withdrawn = new Set<string>()
  const prompts: AuthorizationPromptView[] = []
  for (const frame of frames) {
    if (frame.kind === 'prompt-withdrawn') withdrawn.add(frame.promptId)
    else if (frame.kind === 'prompt') prompts.push(frame.prompt)
  }
  return prompts.reverse().find(prompt => !withdrawn.has(prompt.id) && !answered.has(prompt.id))
}

/**
 * Render the sign-in companion for one provider card.
 * @param props - slot-delivered owner share and inject face.
 * @returns the companion, or null while the shell has not injected yet and
 *   whenever the route offers no sign-in beside its API key.
 */
export function SignInCard(props: SignInCardProps): ReactNode {
  const { provider, operations, t } = props
  if (provider === undefined || operations === undefined || t === undefined) return null
  return <Loaded route={provider.provider} operations={operations} t={t} />
}

function Loaded({ route, operations, t }: {
  route: string
  operations: AuthorizationOperations
  t: SignInCardInjected['t']
}): ReactNode {
  const key = `llm-pi-ai/${route}`
  const [snapshot, setSnapshot] = useState<Snapshot>({ status: 'loading' })
  const [attempt, setAttempt] = useState<AuthorizationAttemptView | null>(null)
  const [busy, setBusy] = useState(false)
  const [cardFailure, setCardFailure] = useState<string | undefined>(undefined)
  const [methodId, setMethodId] = useState<string | undefined>(undefined)

  if (snapshot.status === 'loading') {
    void (async () => {
      const listed = await operations.list()
      if (!listed.ok) {
        setSnapshot({ status: 'error', message: listed.error.message })
        return
      }
      const state = await operations.status(key)
      if (!state.ok) {
        setSnapshot({ status: 'error', message: state.error.message })
        return
      }
      setSnapshot({ status: 'ready', flows: listed.value, stored: state.value.configured })
    })()
    return null
  }
  if (snapshot.status === 'error') {
    return (
      <div className={styles['block']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${snapshot.message}`}</p>
        <Button variant="outline" onClick={() => { setSnapshot({ status: 'loading' }) }}>
          {t('retry')}
        </Button>
      </div>
    )
  }

  const entry = snapshot.flows.find(flow => flow.key === key)
  const methods = entry?.methods.filter(method => method.id !== 'api-key') ?? []
  if (entry === undefined || methods.length === 0) return null
  const first = methods[0]
  /* v8 ignore next -- methods is non-empty: the card returned null above otherwise. */
  if (first === undefined) return null
  const picked = methodId ?? first.id

  const start = async (): Promise<void> => {
    setBusy(true)
    setCardFailure(undefined)
    try {
      const result = await operations.begin(key, picked)
      if (!result.ok) {
        setCardFailure(result.error.message)
        return
      }
      setAttempt(result.value)
    } finally {
      setBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    setBusy(true)
    setCardFailure(undefined)
    try {
      const result = await operations.signOut(key)
      if (!result.ok) {
        setCardFailure(result.error.message)
        return
      }
      setSnapshot({ status: 'ready', flows: snapshot.flows, stored: false })
    } finally {
      setBusy(false)
    }
  }

  /** Withdraw the open attempt, close its dialog, and refresh the grant state. */
  const withdraw = async (): Promise<void> => {
    setAttempt(null)
    await operations.cancel(key)
    const state = await operations.status(key)
    if (state.ok) setSnapshot({ status: 'ready', flows: snapshot.flows, stored: state.value.configured })
  }

  return (
    <div className={styles['block']}>
      {snapshot.stored
        ? (
          <div className={styles['row']}>
            <span className={styles['signedIn']}>{t('signedIn')}</span>
            <Button variant="outline" disabled={busy} onClick={() => { void signOut() }}>
              {t('signOut')}
            </Button>
          </div>
        )
        : (
          <div className={styles['row']}>
            {methods.length > 1
              ? (
                <select
                  className={styles['select']}
                  value={picked}
                  aria-label={t('method')}
                  disabled={busy}
                  onChange={(event) => { setMethodId(event.target.value) }}
                >
                  {methods.map(method => (
                    <option key={method.id} value={method.id}>{method.label}</option>
                  ))}
                </select>
              )
              : null}
            <Button variant="outline" disabled={busy} onClick={() => { void start() }}>
              {busy ? t('signingIn') : t('signIn')}
            </Button>
          </div>
        )}
      {cardFailure === undefined ? null : <p className={styles['error']}>{cardFailure}</p>}
      <Modal
        open={attempt !== null}
        onClose={() => { void withdraw() }}
        title={attempt?.label ?? ''}
        closeLabel={t('close')}
        footer={(
          <Button variant="outline" onClick={() => { void withdraw() }}>
            {t('cancel')}
          </Button>
        )}
      >
        {attempt === null ? null : (
          <DialogBody
            attempt={attempt}
            operations={operations}
            onClose={() => { void withdraw() }}
            t={t}
          />
        )}
      </Modal>
    </div>
  )
}

/** Props of {@link DialogBody}: every share required, nothing optional. */
interface DialogBodyProps {
  /** The attempt the dialog follows. */
  attempt: AuthorizationAttemptView
  /** The Host operations the dialog invokes. */
  operations: AuthorizationOperations
  /** Withdraw the attempt and close its dialog. */
  onClose: () => void
  /** Section copy. */
  t: SignInCardInjected['t']
}

/**
 * Render one open attempt: its notices, its actionable prompt, and its
 * terminal outcome.
 * @param props - the attempt and the callbacks that drive it.
 * @returns the dialog body.
 */
export function DialogBody({ attempt, operations, onClose, t }: DialogBodyProps): ReactNode {
  const [frames, setFrames] = useState<readonly AuthorizationFrameView[]>([])
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // The cursor the next poll reads. It is a ref because an empty answer does
  // not change `frames`, and the poll must still re-arm with the same cursor.
  const cursor = useRef(0)
  // The pending poll timer, so closing the dialog stops the chain.
  const tick = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (outcome !== null) return undefined
    let stopped = false

    /** Poll once and re-arm until the attempt settles or the dialog closes. */
    async function advance(): Promise<void> {
      const polled: RemoteResult<AuthorizationFramesView> = await operations.frames(
        attempt.attemptId, cursor.current)
      if (stopped) return
      if (!polled.ok) {
        setFailure(polled.error.message)
        return
      }
      // The cursor the Host answered from is the one the next poll reads.
      cursor.current = polled.value.next
      if (polled.value.frames.length > 0) setFrames(current => [...current, ...polled.value.frames])
      if (polled.value.done) {
        const terminal = polled.value.frames.find(frame => frame.kind === 'outcome')
        setOutcome({
          status: terminal?.status ?? polled.value.outcome ?? 'failed',
          ...terminal?.error === undefined ? {} : { error: terminal.error },
        })
        return
      }
      tick.current = window.setTimeout(() => { void advance() }, POLL_INTERVAL_MS)
    }

    // The first poll runs from a timer, never inline in this effect body: an
    // immediate promise chain would land its state update outside act while
    // the mount is still running.
    tick.current = window.setTimeout(() => { void advance() }, POLL_INTERVAL_MS)
    return () => {
      stopped = true
      if (tick.current !== undefined) clearTimeout(tick.current)
    }
  }, [attempt, outcome, operations])

  const prompt = outcome !== null ? undefined : actionablePrompt(frames, answered)

  const submit = (event: FormEvent<HTMLFormElement>, current: AuthorizationPromptView): void => {
    event.preventDefault()
    const form = event.currentTarget
    // The form always carries its answer control; anything else reads as the
    // empty string, which the Host refuses alongside a genuinely empty answer.
    const answer = new FormData(form).get('answer')
    const value = typeof answer === 'string' ? answer : ''
    void (async () => {
      setBusy(true)
      setFailure(undefined)
      try {
        const result = await operations.answer(attempt.attemptId, current.id, value)
        if (!result.ok) {
          setFailure(result.error.message)
          return
        }
        setAnswered(previous => new Set([...previous, current.id]))
        form.reset()
      } finally {
        setBusy(false)
      }
    })()
  }

  if (outcome !== null && outcome.status !== 'failed') {
    return (
      <div>
        <p>{outcome.status === 'authorized' ? t('signedIn') : t('cancel')}</p>
        <Button variant="outline" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
    )
  }

  return (
    <div>
      {frames.map((frame) => {
        if (frame.kind !== 'notice') return null
        return (
          <div key={frame.seq} className={styles['notice']}>
            <p>{frame.message}</p>
            {frame.url === undefined
              ? null
              : (
                <a href={frame.url} target="_blank" rel="noreferrer">
                  {t('openPage')}
                </a>
              )}
            {frame.code === undefined ? null : <code>{frame.code}</code>}
          </div>
        )
      })}
      {prompt === undefined
        ? null
        : (
          <form onSubmit={(event) => { submit(event, prompt) }}>
            <p>{prompt.message}</p>
            {prompt.kind === 'select'
              ? (
                <select name="answer" className={styles['select']} aria-label={prompt.message} disabled={busy}>
                  {prompt.options.map(option => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              )
              : (
                <Input
                  name="answer"
                  type={prompt.kind === 'secret' ? 'password' : 'text'}
                  autoComplete="off"
                  aria-label={prompt.message}
                  {...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }}
                  disabled={busy}
                />
              )}
            <Button variant="outline" type="submit" disabled={busy}>
              {busy ? t('sending') : t('submit')}
            </Button>
          </form>
        )}
      {outcome === null ? null : <p className={styles['error']}>{outcome.error ?? outcome.status}</p>}
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
    </div>
  )
}
