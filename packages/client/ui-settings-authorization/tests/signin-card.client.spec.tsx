// @vitest-environment jsdom
/** Sign-in companion behavior over a scripted authorization Remote face. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AuthorizationAttemptView,
  AuthorizationFlowView,
  AuthorizationFramesView,
  RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import { actionablePrompt, DialogBody, SignInCard } from '../src/client/SignInCard.tsx'
import type { SignInCardProps } from '../src/client/SignInCard.tsx'
import type { AuthorizationOperations } from '../src/client/operations.ts'
import type { ProviderCardExtrasOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

const ENTRY: ProviderCardExtrasOwnerProps['provider'] = {
  provider: 'anthropic',
  displayName: 'Anthropic',
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'anthropic'],
  active: false,
}

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function fail(code: string, message: string): RemoteResult<never> {
  return { ok: false, error: { code, message } as never }
}

function oauthFlow(methods: Array<{ id: string; label: string }> = [{ id: 'oauth', label: 'Sign in' }]): AuthorizationFlowView {
  return {
    key: 'llm-pi-ai/anthropic',
    scope: 'llm-pi-ai',
    id: 'anthropic',
    label: 'Anthropic',
    methods,
    inFlight: false,
  }
}

const NOTICE = { seq: 0, kind: 'notice', message: 'Open this page', url: 'https://auth.example/start', code: 'A1' }
const NOTICE_PLAIN = { seq: 1, kind: 'notice', message: 'Waiting' }
const PROMPT = { seq: 2, kind: 'prompt', prompt: { id: 'p1', kind: 'text', message: 'Paste the code' } }
/** The attempt id every scripted dialog follows. */
const ATTEMPT: AuthorizationAttemptView = {
  attemptId: 'attempt-1',
  key: 'llm-pi-ai/anthropic',
  label: 'Anthropic',
  method: 'oauth',
}

/** The first poll of a scripted attempt: nothing has arrived yet. */
const EMPTY: AuthorizationFramesView = { frames: [], next: 0, done: false }
/** The conversation poll: notices and the actionable prompt, still running. */
const CONVERSATION: AuthorizationFramesView = {
  frames: [NOTICE, NOTICE_PLAIN, PROMPT] as never,
  next: 3,
  done: false,
}
/** The settling poll: the authorized outcome frame. */
const SETTLED: AuthorizationFramesView = {
  frames: [{ seq: 3, kind: 'outcome', status: 'authorized' }] as never,
  next: 4,
  done: true,
  outcome: 'authorized',
}

/** The dialog's poll interval, mirrored from the component. */
const POLL_MS = 1200

/** The spy shape the helpers read: a vi.fn with its call log. */
type Spy = { mock: { calls: unknown[][] } }

/**
 * A frames stub that answers like the Host: the attempt's first poll is empty,
 * and each scripted answer lands once, in order.
 * @param polls - the scripted non-empty answers, in order.
 * @returns the spy-backed operation.
 */
function scriptedFrames(polls: readonly AuthorizationFramesView[]): AuthorizationOperations['frames'] {
  let index = 0
  return vi.fn(async () => {
    if (index === 0) {
      index += 1
      return ok(EMPTY)
    }
    const delivered = polls[index - 1] ?? EMPTY
    index += 1
    return ok(delivered)
  })
}

/**
 * Wait for a Remote call, past the dialog's poll interval.
 * @param spy - the operation to watch.
 * @returns once it ran.
 */
async function called(spy: Spy): Promise<void> {
  await vi.waitFor(() => {
    expect(spy).toHaveBeenCalled()
  }, { timeout: 5000 })
}

/**
 * Let the self-rescheduling poll chain run until `count` polls have landed,
 * flushing every state update inside act so no React work escapes the batch.
 * @param spy - the frames operation to count calls on.
 * @param count - how many polls should have landed.
 * @returns once the count holds.
 */
async function advanceToPoll(spy: Spy, count: number): Promise<void> {
  for (let step = spy.mock.calls.length; step < count; step += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS + 300)
    })
  }
}

/** Every operation paired with the spy call log the helpers read. */
type Ops = { [K in keyof AuthorizationOperations]: AuthorizationOperations[K] & Spy }

function stub(overrides: Partial<AuthorizationOperations> = {}): Ops {
  let stored = false
  const ops: AuthorizationOperations = {
    list: async () => ok([oauthFlow()]),
    status: async () => ok({ configured: stored }),
    signOut: async () => {
      stored = false
      return ok(undefined)
    },
    begin: async () => ok({
      attemptId: 'attempt-1',
      key: 'llm-pi-ai/anthropic',
      label: 'Anthropic',
      method: 'oauth',
    }),
    frames: async () => ok({ frames: [], next: 0, done: false }),
    answer: async () => ok(undefined),
    cancel: async () => ok(undefined),
  }
  const spied = Object.fromEntries(
    Object.entries(ops).map(([name, fn]) => [name, vi.fn(fn)]),
  ) as Record<string, ReturnType<typeof vi.fn>>
  return { ...spied, ...overrides } as unknown as Ops
}

function props(operations: AuthorizationOperations): SignInCardProps {
  return { provider: ENTRY, configured: false, keyConfigured: false, operations, t }
}

describe('the sign-in companion card', () => {
  it('renders nothing without its injected shares', () => {
    const { container } = render(<SignInCard />)
    expect(container.textContent).toBe('')
  })

  it('renders nothing when the route offers no flow', async () => {
    const operations = stub({
      list: vi.fn(async () => ok([{
        key: 'llm-pi-ai/openai',
        scope: 'llm-pi-ai',
        id: 'openai',
        label: 'OpenAI',
        methods: [{ id: 'oauth', label: 'Sign in' }],
        inFlight: false,
      }])),
    })
    const { container } = render(<SignInCard {...props(operations)} />)
    await called(operations.list)
    expect(container.textContent).toBe('')
  })

  it('renders nothing when the flow offers only its API key', async () => {
    const operations = stub({
      list: vi.fn(async () => ok([oauthFlow([{ id: 'api-key', label: 'Key' }])])),
    })
    const { container } = render(<SignInCard {...props(operations)} />)
    await called(operations.list)
    expect(container.textContent).toBe('')
  })

  it('reports a refused directory read with a retry', async () => {
    const operations = stub()
    operations.list = vi.fn(async () => fail('settings/rejected', 'nope'))
    render(<SignInCard {...props(operations)} />)
    await screen.findByText(/Loading sign-in state failed: nope/, undefined, { timeout: 3000 })
    operations.list = vi.fn(async () => ok([oauthFlow()]))
    fireEvent.click(screen.getByText(en.retry))
    await screen.findByText(en.signIn, undefined, { timeout: 3000 })
  })

  it('reports a refused grant read', async () => {
    const operations = stub({ status: async () => fail('gateway/internal', 'store away') })
    render(<SignInCard {...props(operations)} />)
    await screen.findByText(/Loading sign-in state failed: store away/, undefined, { timeout: 3000 })
  })

  it('drives a code prompt to a signed-in card', async () => {
    vi.useFakeTimers()
    try {
      let stored = false
      const operations = stub({
        status: vi.fn(async () => ok({ configured: stored })),
        frames: scriptedFrames([CONVERSATION, SETTLED]),
      })
      const settled = vi.fn()
      render(<DialogBody attempt={ATTEMPT} operations={operations} onClose={settled} t={t} />)
      await advanceToPoll(operations.frames, 2)
      expect(screen.getByText('Open this page')).toBeDefined()
      const link = screen.getByText(en.openPage).closest('a')
      expect(link?.getAttribute('href')).toBe('https://auth.example/start')
      expect(screen.getByText('A1').tagName).toBe('CODE')
      expect(screen.getByText('Waiting')).toBeDefined()
      const input = screen.getByLabelText<HTMLInputElement>('Paste the code')
      expect(input.type).toBe('text')
      fireEvent.change(input, { target: { value: 'typed-code' } })
      fireEvent.click(screen.getByText(en.submit))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50)
      })
      expect(operations.answer).toHaveBeenCalledWith('attempt-1', 'p1', 'typed-code')
      await advanceToPoll(operations.frames, 3)
      expect(screen.getByText(en.signedIn)).toBeDefined()
      expect(settled).not.toHaveBeenCalled()
      stored = true
      fireEvent.click(screen.getByText(en.close))
      expect(settled).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  }, 20000)

  it('opens an attempt from the card and follows its dialog to the signed-in state', async () => {
    vi.useFakeTimers()
    try {
      let stored = false
      const operations = stub({
        status: vi.fn(async () => ok({ configured: stored })),
        frames: scriptedFrames([CONVERSATION, SETTLED]),
      })
      render(<SignInCard {...props(operations)} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50)
      })
      fireEvent.click(screen.getByText(en.signIn))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50)
      })
      expect(operations.begin).toHaveBeenCalledWith('llm-pi-ai/anthropic', 'oauth')
      await advanceToPoll(operations.frames, 2)
      expect(screen.getByText('Open this page')).toBeDefined()
      const input = screen.getByLabelText<HTMLInputElement>('Paste the code')
      fireEvent.change(input, { target: { value: 'typed-code' } })
      fireEvent.click(screen.getByText(en.submit))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50)
      })
      expect(operations.answer).toHaveBeenCalledWith('attempt-1', 'p1', 'typed-code')
      await advanceToPoll(operations.frames, 3)
      expect(screen.getByText(en.signedIn)).toBeDefined()
      stored = true
      fireEvent.click(screen.getByText(en.close))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50)
      })
      expect(screen.getByText(en.signOut)).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  }, 30000)

  it('shows a busy label while the attempt opens', async () => {
    let release!: (attempt: RemoteResult<AuthorizationAttemptView>) => void
    const gate = new Promise<RemoteResult<AuthorizationAttemptView>>((resolve) => { release = resolve })
    const operations = stub({ begin: vi.fn(async () => gate) })
    render(<SignInCard {...props(operations)} />)
    fireEvent.click(await screen.findByText(en.signIn, undefined, { timeout: 3000 }))
    await screen.findByText(en.signingIn, undefined, { timeout: 3000 })
    await act(async () => {
      release(ok({
        attemptId: 'attempt-1',
        key: 'llm-pi-ai/anthropic',
        label: 'Anthropic',
        method: 'oauth',
      }))
    })
  })

  it('reports a refused begin on the card', async () => {
    const operations = stub({ begin: async () => fail('authorization/in-flight', 'busy elsewhere') })
    render(<SignInCard {...props(operations)} />)
    fireEvent.click(await screen.findByText(en.signIn, undefined, { timeout: 3000 }))
    await screen.findByText('busy elsewhere', undefined, { timeout: 3000 })
  })

  it('offers a method picker when the flow offers several', async () => {
    const operations = stub({
      list: async () => ok([oauthFlow([
        { id: 'oauth', label: 'Subscription' },
        { id: 'sso', label: 'SSO' },
        { id: 'api-key', label: 'Key' },
      ])]),
    })
    render(<SignInCard {...props(operations)} />)
    const picker = await screen.findByLabelText(en.method, undefined, { timeout: 3000 })
    expect(picker instanceof HTMLSelectElement ? [...picker.options].map(option => option.value) : []).toEqual([
      'oauth',
      'sso',
    ])
    fireEvent.change(picker, { target: { value: 'sso' } })
    fireEvent.click(screen.getByText(en.signIn))
    await vi.waitFor(() => {
      expect(operations.begin).toHaveBeenCalledWith('llm-pi-ai/anthropic', 'sso')
    }, { timeout: 5000 })
  })

  it('masks a secret prompt and shows its placeholder', async () => {
    const operations = stub({
      frames: vi.fn(async () => ok({
        frames: [{
          seq: 0,
          kind: 'prompt',
          prompt: { id: 'p1', kind: 'secret', message: 'Paste a token', placeholder: 'sk-…' },
        }] as never,
        next: 1,
        done: false,
      })),
    })
    render(<SignInCard {...props(operations)} />)
    fireEvent.click(await screen.findByText(en.signIn, undefined, { timeout: 3000 }))
    const input = await screen.findByLabelText<HTMLInputElement>('Paste a token', undefined, { timeout: 5000 })
    expect(input.type).toBe('password')
    expect(input.placeholder).toBe('sk-…')
  })

  it('answers a select prompt with the chosen option', async () => {
    const operations = stub({
      frames: vi.fn(async () => ok({
        frames: [{
          seq: 0,
          kind: 'prompt',
          prompt: {
            id: 'p1',
            kind: 'select',
            message: 'Pick an account',
            options: [{ id: 'work', label: 'Work' }, { id: 'home', label: 'Home' }],
          },
        }] as never,
        next: 1,
        done: false,
      })),
    })
    render(<SignInCard {...props(operations)} />)
    fireEvent.click(await screen.findByText(en.signIn, undefined, { timeout: 3000 }))
    const picker = await screen.findByLabelText('Pick an account', undefined, { timeout: 5000 })
    fireEvent.change(picker, { target: { value: 'home' } })
    fireEvent.click(screen.getByText(en.submit))
    await vi.waitFor(() => {
      expect(operations.answer).toHaveBeenCalledWith('attempt-1', 'p1', 'home')
    }, { timeout: 5000 })
  })

  it('reports a refused answer in its dialog', async () => {
    const operations = stub({
      frames: vi.fn(async () => ok({
        frames: [PROMPT] as never,
        next: 1,
        done: false,
      })),
      answer: vi.fn(async () => fail('gateway/bad-request', 'empty answers never land')),
    })
    render(<SignInCard {...props(operations)} />)
    fireEvent.click(await screen.findByText(en.signIn, undefined, { timeout: 3000 }))
    await screen.findByLabelText('Paste the code', undefined, { timeout: 5000 })
    fireEvent.click(screen.getByText(en.submit))
    await screen.findByText('empty answers never land', undefined, { timeout: 5000 })
  }, 15000)

  it('carries a failed attempt with its diagnostic', async () => {
    const operations = stub({
      frames: vi.fn(async () => ok<AuthorizationFramesView>({
        frames: [{ seq: 0, kind: 'outcome', status: 'failed', error: 'the issuer refused' }] as never,
        next: 1,
        done: true,
        outcome: 'failed',
      })),
    })
    render(<SignInCard {...props(operations)} />)
    fireEvent.click(await screen.findByText(en.signIn, undefined, { timeout: 3000 }))
    await screen.findByText('the issuer refused', undefined, { timeout: 5000 })
    expect(screen.queryByText(en.submit)).toBeNull()
  }, 10000)

  it('settles a done poll without an outcome frame from its outcome', async () => {
    const operations = stub({
      frames: vi.fn(async () => ok<AuthorizationFramesView>({ frames: [], next: 0, done: true, outcome: 'cancelled' })),
    })
    render(<SignInCard {...props(operations)} />)
    fireEvent.click(await screen.findByText(en.signIn, undefined, { timeout: 3000 }))
    await screen.findByText(en.close, undefined, { timeout: 5000 })
    fireEvent.click(screen.getByText(en.close))
    await vi.waitFor(() => {
      expect(operations.cancel).toHaveBeenCalledWith('llm-pi-ai/anthropic')
    }, { timeout: 5000 })
  }, 10000)

  it('settles a done poll without any outcome as failed', async () => {
    const operations = stub({
      frames: vi.fn(async () => ok({ frames: [], next: 0, done: true })),
    })
    render(<SignInCard {...props(operations)} />)
    fireEvent.click(await screen.findByText(en.signIn, undefined, { timeout: 3000 }))
    await screen.findByText('failed', undefined, { timeout: 5000 })
  }, 10000)

  it('reports a refused poll', async () => {
    const operations = stub({
      frames: vi.fn(async () => fail('gateway/internal', 'carrier lost')),
    })
    render(<SignInCard {...props(operations)} />)
    fireEvent.click(await screen.findByText(en.signIn, undefined, { timeout: 3000 }))
    await screen.findByText('carrier lost', undefined, { timeout: 5000 })
  }, 10000)

  it('withdraws the attempt from its cancel control', async () => {
    const operations = stub({
      status: vi.fn(async () => ok({ configured: false })),
      frames: vi.fn(async () => ok<AuthorizationFramesView>({
        frames: [PROMPT] as never,
        next: 1,
        done: false,
      })),
    })
    render(<SignInCard {...props(operations)} />)
    fireEvent.click(await screen.findByText(en.signIn, undefined, { timeout: 3000 }))
    await screen.findByLabelText('Paste the code', undefined, { timeout: 5000 })
    fireEvent.click(screen.getByText(en.cancel))
    await vi.waitFor(() => {
      expect(operations.cancel).toHaveBeenCalledWith('llm-pi-ai/anthropic')
    }, { timeout: 5000 })
    await vi.waitFor(() => {
      expect(screen.queryByLabelText('Paste the code')).toBeNull()
    }, { timeout: 5000 })
  }, 15000)

  it('keeps the card when a closing grant read is refused', async () => {
    let calls = 0
    const operations = stub({
      status: vi.fn(async () => {
        calls += 1
        return calls === 1 ? ok({ configured: false }) : fail('gateway/internal', 'store away')
      }),
      frames: vi.fn(async () => ok({ frames: [], next: 0, done: false })),
    })
    render(<SignInCard {...props(operations)} />)
    fireEvent.click(await screen.findByText(en.signIn, undefined, { timeout: 3000 }))
    await screen.findByText(en.cancel, undefined, { timeout: 5000 })
    fireEvent.click(screen.getByText(en.cancel))
    await vi.waitFor(() => {
      expect(operations.cancel).toHaveBeenCalledTimes(1)
    }, { timeout: 5000 })
    await screen.findByText(en.signIn, undefined, { timeout: 5000 })
  }, 15000)

  it('signs out of a stored grant', async () => {
    const operations = stub({ status: async () => ok({ configured: true }) })
    render(<SignInCard {...props(operations)} />)
    await screen.findByText(en.signedIn, undefined, { timeout: 3000 })
    fireEvent.click(screen.getByText(en.signOut))
    await vi.waitFor(() => {
      expect(operations.signOut).toHaveBeenCalledWith('llm-pi-ai/anthropic')
    }, { timeout: 5000 })
    await screen.findByText(en.signIn, undefined, { timeout: 3000 })
  })

  it('reports a refused sign-out on the card', async () => {
    const operations = stub({
      status: async () => ok({ configured: true }),
      signOut: async () => fail('credential/rejected', 'read-only source'),
    })
    render(<SignInCard {...props(operations)} />)
    fireEvent.click(await screen.findByText(en.signOut, undefined, { timeout: 3000 }))
    await screen.findByText('read-only source', undefined, { timeout: 3000 })
  })
})

describe('actionablePrompt', () => {
  it('returns undefined when the conversation asks nothing', () => {
    expect(actionablePrompt([], new Set())).toBeUndefined()
    expect(actionablePrompt([NOTICE, NOTICE_PLAIN] as never, new Set())).toBeUndefined()
  })

  it('prefers the latest unanswered prompt', () => {
    const second = { seq: 3, kind: 'prompt', prompt: { id: 'p2', kind: 'text', message: 'Second?' } }
    expect(actionablePrompt([NOTICE, PROMPT, second] as never, new Set(['p1'])))
      .toMatchObject({ id: 'p2' })
  })

  it('skips prompts the flow withdrew', () => {
    const frames = [
      PROMPT,
      { seq: 3, kind: 'prompt-withdrawn', promptId: 'p1' },
    ] as never
    expect(actionablePrompt(frames, new Set())).toBeUndefined()
  })
})
