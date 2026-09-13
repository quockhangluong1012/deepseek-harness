import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationMethod,
  AuthorizationSession,
} from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import AuthorizationRemoteService from '../src/index.ts'
import type { AuthorizationAttemptView } from '../src/index.ts'

const KEY = credentialKey('web-test', 'oauth-widget')
const METHODS: [AuthorizationMethod, ...AuthorizationMethod[]] = [
  { id: 'oauth', label: 'Sign in' },
  { id: 'api-key', label: 'Paste a key' },
]

/** The script a scripted flow runs once its attempt starts. */
type FlowScript = (session: AuthorizationSession, ctx: Context) => Promise<void>

/** Register one scripted flow. */
function scriptedFlow(ctx: Context, key: CredentialKey, label: string, script: FlowScript): void {
  ctx.authorization.registerFlow({
    key,
    label,
    methods: METHODS,
    run: session => script(session, ctx),
  })
}

/** Commit a grant record for a key through the credential seam. */
async function commit(ctx: Context, key: CredentialKey, payload: unknown = {}): Promise<void> {
  await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload }))
}

async function boot(): Promise<{ ctx: Context; remote: AuthorizationRemoteService }> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(AuthorizationRemoteService)
  return { ctx, remote: ctx.authorizationRemote }
}

/**
 * Run a synchronous Remote call, capturing a sync throw as a rejection value.
 * @param call - the call to run.
 * @returns the refusal it threw.
 */
async function refuse(call: () => AuthorizationAttemptView): Promise<unknown> {
  return Promise.resolve().then(call).catch((error: unknown) => error)
}

/**
 * Poll until a predicate holds.
 * @param ready - whether the awaited state arrived.
 * @returns once it holds.
 * @throws when it never arrives within the bound.
 */
async function waitFor(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !ready(); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  if (!ready()) throw new Error('timed out waiting for the authorization attempt')
}

describe('the authorization Remote namespace a sign-in surface calls', () => {
  it('publishes the authorization namespace from its own service key', async () => {
    const { remote } = await boot()
    expect(remote.typertRemote.serviceKey).toBe('authorizationRemote')
    expect(remote.typertRemote.namespace).toBe('authorization')
    expect(remoteMethods(remote)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'describe', invocation: { kind: 'direct' } },
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'signOut', invocation: { kind: 'direct' } },
      { method: 'begin', invocation: { kind: 'direct' } },
      { method: 'frames', invocation: { kind: 'direct' } },
      { method: 'answer', invocation: { kind: 'direct' } },
      { method: 'decline', invocation: { kind: 'direct' } },
      { method: 'cancel', invocation: { kind: 'direct' } },
    ])
  })

  it('lists registered flows as wire views', async () => {
    const { ctx, remote } = await boot()
    expect(remote.list()).toEqual([])
    scriptedFlow(ctx, KEY, 'Widget', async () => {})
    expect(remote.list()).toEqual([{
      key: KEY,
      scope: 'web-test',
      id: 'oauth-widget',
      label: 'Widget',
      methods: [
        { id: 'oauth', label: 'Sign in' },
        { id: 'api-key', label: 'Paste a key' },
      ],
      inFlight: false,
    }])
  })

  it('describes one flow and reports an unknown record as no-flow', async () => {
    const { ctx, remote } = await boot()
    scriptedFlow(ctx, KEY, 'Widget', async () => {})
    expect(remote.describe(KEY).label).toBe('Widget')
    const failure = await Promise.resolve()
      .then(() => remote.describe(credentialKey('web-test', 'missing')))
      .catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/no-flow' })
  })

  it('rejects malformed record keys as bad-request', async () => {
    const { remote } = await boot()
    for (const key of ['', 'no-slash', 'HAS-CAPS/lower', 'a/b/c']) {
      const described = await Promise.resolve().then(() => remote.describe(key)).catch((error: unknown) => error)
      expect(remoteErrorOf(described)).toMatchObject({ code: 'gateway/bad-request' })
      const stated = await remote.status(key).catch((error: unknown) => error)
      expect(remoteErrorOf(stated)).toMatchObject({ code: 'gateway/bad-request' })
      const signedOut = await remote.signOut(key).catch((error: unknown) => error)
      expect(remoteErrorOf(signedOut)).toMatchObject({ code: 'gateway/bad-request' })
      expect(remoteErrorOf(await refuse(() => remote.begin(key, undefined))))
        .toMatchObject({ code: 'gateway/bad-request' })
      const cancelled = await Promise.resolve().then(() => { remote.cancel(key) }).catch((error: unknown) => error)
      expect(remoteErrorOf(cancelled)).toMatchObject({ code: 'gateway/bad-request' })
    }
  })

  it('reports stored-grant state and forgets it on sign-out', async () => {
    const { ctx, remote } = await boot()
    scriptedFlow(ctx, KEY, 'Widget', async () => {})
    expect(await remote.status(KEY)).toEqual({ configured: false })
    await commit(ctx, KEY)
    expect(await remote.status(KEY)).toEqual({ configured: true })
    await remote.signOut(KEY)
    expect(await remote.status(KEY)).toEqual({ configured: false })
  })

  it('refuses to begin an unknown flow, an unoffered method, or a busy key', async () => {
    const { ctx, remote } = await boot()
    expect(remoteErrorOf(await refuse(() => remote.begin(credentialKey('web-test', 'missing'), undefined))))
      .toMatchObject({ code: 'authorization/no-flow' })
    scriptedFlow(ctx, KEY, 'Widget', async () => {})
    expect(remoteErrorOf(await refuse(() => remote.begin(KEY, 'device'))))
      .toMatchObject({ code: 'authorization/unknown-method' })
    expect(remoteErrorOf(await refuse(() => remote.begin(KEY, ''))))
      .toMatchObject({ code: 'authorization/unknown-method' })
    const hollow = credentialKey('web-test', 'hollow')
    ctx.authorization.registerFlow({
      key: hollow,
      label: 'Hollow',
      methods: [] as unknown as [AuthorizationMethod, ...AuthorizationMethod[]],
      run: async () => {},
    })
    expect(remote.list().find(flow => flow.key === hollow)?.methods).toEqual([])
    expect(remoteErrorOf(await refuse(() => remote.begin(hollow, undefined))))
      .toMatchObject({ code: 'authorization/unknown-method' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const gated = credentialKey('web-test', 'gated')
    scriptedFlow(ctx, gated, 'Gated', async () => { await gate })
    remote.begin(gated, undefined)
    await waitFor(() => remote.list().some(flow => flow.key === gated && flow.inFlight))
    expect(remoteErrorOf(await refuse(() => remote.begin(gated, undefined))))
      .toMatchObject({ code: 'authorization/in-flight' })
    release()
  })

  it('drives a notice plus code prompt to an authorized outcome', async () => {
    const { ctx, remote } = await boot()
    scriptedFlow(ctx, KEY, 'Widget', async (session, flowCtx) => {
      session.notify({ message: 'Open this page', url: 'https://auth.example/start', code: 'A1' })
      session.notify({ message: 'Waiting' })
      const code = await session.prompt({ kind: 'text', message: 'Paste the code' })
      await flowCtx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { code } }))
    })
    const attempt = remote.begin(KEY, undefined)
    expect(attempt).toMatchObject({ key: KEY, label: 'Widget', method: 'oauth' })
    await waitFor(() => remote.frames(attempt.attemptId, 0).next >= 3)
    const polled = remote.frames(attempt.attemptId, 0)
    expect(polled).toMatchObject({
      next: 3,
      done: false,
      frames: [
        { seq: 0, kind: 'notice', message: 'Open this page', url: 'https://auth.example/start', code: 'A1' },
        { seq: 1, kind: 'notice', message: 'Waiting' },
        { seq: 2, kind: 'prompt', prompt: { id: 'p1', kind: 'text', message: 'Paste the code' } },
      ],
    })
    expect(polled.outcome).toBeUndefined()
    remote.answer(attempt.attemptId, 'p1', 'typed-code')
    await waitFor(() => remote.frames(attempt.attemptId, 0).done)
    expect(remote.frames(attempt.attemptId, 3)).toMatchObject({
      next: 4,
      done: true,
      outcome: 'authorized',
      frames: [{ seq: 3, kind: 'outcome', status: 'authorized' }],
    })
    expect(await remote.status(KEY)).toEqual({ configured: true })
  })

  it('answers a select prompt with the chosen option', async () => {
    const { ctx, remote } = await boot()
    scriptedFlow(ctx, KEY, 'Widget', async (session, flowCtx) => {
      const picked = await session.prompt({
        kind: 'select',
        message: 'Pick an account',
        options: [
          { id: 'work', label: 'Work', description: 'The shared one' },
          { id: 'home', label: 'Home' },
        ],
      })
      await flowCtx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { picked } }))
    })
    const attempt = remote.begin(KEY, 'oauth')
    await waitFor(() => remote.frames(attempt.attemptId, 0).next >= 1)
    expect(remote.frames(attempt.attemptId, 0).frames).toEqual([{
      seq: 0,
      kind: 'prompt',
      prompt: {
        id: 'p1',
        kind: 'select',
        message: 'Pick an account',
        options: [
          { id: 'work', label: 'Work', description: 'The shared one' },
          { id: 'home', label: 'Home' },
        ],
      },
    }])
    remote.answer(attempt.attemptId, 'p1', 'home')
    await waitFor(() => remote.frames(attempt.attemptId, 0).done)
    expect(remote.frames(attempt.attemptId, 1).outcome).toBe('authorized')
  })

  it('settles a declined prompt as cancelled', async () => {
    const { ctx, remote } = await boot()
    scriptedFlow(ctx, KEY, 'Widget', async (session) => {
      session.notify({ message: 'Starting' })
      await session.prompt({ kind: 'secret', message: 'Paste a token', placeholder: 'sk-â€¦' })
    })
    const attempt = remote.begin(KEY, undefined)
    await waitFor(() => remote.frames(attempt.attemptId, 0).next >= 2)
    remote.decline(attempt.attemptId, 'p1')
    await waitFor(() => remote.frames(attempt.attemptId, 0).done)
    expect(remote.frames(attempt.attemptId, 0)).toMatchObject({ done: true, outcome: 'cancelled' })
  })

  it('settles a withdrawn attempt as cancelled', async () => {
    const { ctx, remote } = await boot()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    scriptedFlow(ctx, KEY, 'Widget', async () => { await gate })
    const attempt = remote.begin(KEY, undefined)
    await waitFor(() => remote.list().some(flow => flow.inFlight))
    remote.cancel(KEY)
    release()
    await waitFor(() => remote.frames(attempt.attemptId, 0).done)
    expect(remote.frames(attempt.attemptId, 0).outcome).toBe('cancelled')
  })

  it('carries a flow failure as a failed outcome with its diagnostic', async () => {
    const { ctx, remote } = await boot()
    scriptedFlow(ctx, KEY, 'Widget', async () => {
      throw new Error('the issuer refused the code')
    })
    const attempt = remote.begin(KEY, undefined)
    await waitFor(() => remote.frames(attempt.attemptId, 0).done)
    expect(remote.frames(attempt.attemptId, 0)).toMatchObject({
      done: true,
      outcome: 'failed',
      frames: [{ kind: 'outcome', status: 'failed', error: 'the issuer refused the code' }],
    })
    const thrown = credentialKey('web-test', 'string-thrower')
    scriptedFlow(ctx, thrown, 'Thrower', async () => {
      throw 'a bare refusal'
    })
    const second = remote.begin(thrown, undefined)
    await waitFor(() => remote.frames(second.attemptId, 0).done)
    expect(remote.frames(second.attemptId, 0).frames[0]).toMatchObject({
      kind: 'outcome',
      status: 'failed',
      error: 'a bare refusal',
    })
  })

  it('reports a prompt the flow withdrew while the attempt continues', async () => {
    const { ctx, remote } = await boot()
    let withdraw!: () => void
    scriptedFlow(ctx, KEY, 'Widget', async (session, flowCtx) => {
      const controller = new AbortController()
      withdraw = () => { controller.abort() }
      try {
        await session.prompt({ kind: 'text', message: 'First code?', signal: controller.signal })
      } catch {
        session.notify({ message: 'Trying another way' })
        const second = await session.prompt({ kind: 'text', message: 'Second code?' })
        await flowCtx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { second } }))
      }
    })
    const attempt = remote.begin(KEY, undefined)
    await waitFor(() => remote.frames(attempt.attemptId, 0).next >= 1)
    withdraw()
    await waitFor(() => remote.frames(attempt.attemptId, 0).next >= 4)
    expect(remote.frames(attempt.attemptId, 1)).toMatchObject({
      next: 4,
      frames: [
        { seq: 1, kind: 'prompt-withdrawn', promptId: 'p1' },
        { seq: 2, kind: 'notice', message: 'Trying another way' },
        { seq: 3, kind: 'prompt', prompt: { id: 'p2', kind: 'text', message: 'Second code?' } },
      ],
    })
    const late = await Promise.resolve()
      .then(() => { remote.answer(attempt.attemptId, 'p1', 'too-late') })
      .catch((error: unknown) => error)
    expect(remoteErrorOf(late)).toMatchObject({ code: 'authorization/inactive-prompt' })
    remote.answer(attempt.attemptId, 'p2', 'second-code')
    await waitFor(() => remote.frames(attempt.attemptId, 0).done)
    expect(remote.frames(attempt.attemptId, 0).outcome).toBe('authorized')
  })

  it('ignores a withdrawal after its prompt was already answered', async () => {
    const { ctx, remote } = await boot()
    let withdraw!: () => void
    scriptedFlow(ctx, KEY, 'Widget', async (session, flowCtx) => {
      const controller = new AbortController()
      withdraw = () => { controller.abort() }
      const code = await session.prompt({ kind: 'text', message: 'Code?', signal: controller.signal })
      await flowCtx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { code } }))
    })
    const attempt = remote.begin(KEY, undefined)
    await waitFor(() => remote.frames(attempt.attemptId, 0).next >= 1)
    remote.answer(attempt.attemptId, 'p1', 'in-time')
    withdraw()
    await waitFor(() => remote.frames(attempt.attemptId, 0).done)
    const polled = remote.frames(attempt.attemptId, 0)
    expect(polled.outcome).toBe('authorized')
    expect(polled.frames.some(frame => frame.kind === 'prompt-withdrawn')).toBe(false)
  })

  it('rejects answers it cannot route', async () => {
    const { ctx, remote } = await boot()
    scriptedFlow(ctx, KEY, 'Widget', async (session, flowCtx) => {
      const code = await session.prompt({ kind: 'text', message: 'Code?' })
      await flowCtx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { code } }))
    })
    const attempt = remote.begin(KEY, undefined)
    const unknownAttempt = await Promise.resolve()
      .then(() => { remote.answer('no-such-attempt', 'p1', 'x') })
      .catch((error: unknown) => error)
    expect(remoteErrorOf(unknownAttempt)).toMatchObject({ code: 'authorization/unknown-attempt' })
    for (const bad of ['', 'x'.repeat(129)]) {
      const malformed = await Promise.resolve()
        .then(() => { remote.answer(bad, 'p1', 'x') })
        .catch((error: unknown) => error)
      expect(remoteErrorOf(malformed)).toMatchObject({ code: 'gateway/bad-request' })
    }
    const unknownPrompt = await Promise.resolve()
      .then(() => { remote.answer(attempt.attemptId, 'p9', 'x') })
      .catch((error: unknown) => error)
    expect(remoteErrorOf(unknownPrompt)).toMatchObject({ code: 'authorization/unknown-prompt' })
    const malformedPrompt = await Promise.resolve()
      .then(() => { remote.answer(attempt.attemptId, '', 'x') })
      .catch((error: unknown) => error)
    expect(remoteErrorOf(malformedPrompt)).toMatchObject({ code: 'gateway/bad-request' })
    const empty = await Promise.resolve()
      .then(() => { remote.answer(attempt.attemptId, 'p1', '') })
      .catch((error: unknown) => error)
    expect(remoteErrorOf(empty)).toMatchObject({ code: 'gateway/bad-request' })
    const nonString = await Promise.resolve()
      .then(() => { remote.answer(attempt.attemptId, 'p1', 123 as unknown as string) })
      .catch((error: unknown) => error)
    expect(remoteErrorOf(nonString)).toMatchObject({ code: 'gateway/bad-request' })
    const declined = await Promise.resolve()
      .then(() => { remote.decline('no-such-attempt', 'p1') })
      .catch((error: unknown) => error)
    expect(remoteErrorOf(declined)).toMatchObject({ code: 'authorization/unknown-attempt' })
    await waitFor(() => remote.frames(attempt.attemptId, 0).next >= 1)
    remote.answer(attempt.attemptId, 'p1', 'settles-it')
    const answered = await Promise.resolve()
      .then(() => { remote.decline(attempt.attemptId, 'p1') })
      .catch((error: unknown) => error)
    expect(remoteErrorOf(answered)).toMatchObject({ code: 'authorization/unknown-prompt' })
    await waitFor(() => remote.frames(attempt.attemptId, 0).done)
  })

  it('rejects cursors it cannot read from', async () => {
    const { ctx, remote } = await boot()
    scriptedFlow(ctx, KEY, 'Widget', async () => {})
    const attempt = remote.begin(KEY, undefined)
    for (const cursor of [-1, 1.5, Number.NaN]) {
      const failure = await Promise.resolve()
        .then(() => remote.frames(attempt.attemptId, cursor))
        .catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
    }
    const missing = await Promise.resolve()
      .then(() => remote.frames('no-such-attempt', 0))
      .catch((error: unknown) => error)
    expect(remoteErrorOf(missing)).toMatchObject({ code: 'authorization/unknown-attempt' })
    await waitFor(() => remote.frames(attempt.attemptId, 0).done)
  })

  it('evicts the oldest settled attempts past the retention bound', async () => {
    const { ctx, remote } = await boot()
    const ids: string[] = []
    for (let index = 0; index < 50; index += 1) {
      const key = credentialKey('web-test', `route-${String(index)}`)
      scriptedFlow(ctx, key, `Route ${String(index)}`, async (flowSession, flowCtx) => {
        await commit(flowCtx, key)
        void flowSession
      })
      ids.push(remote.begin(key, undefined).attemptId)
    }
    await waitFor(() => ids.every(id => remote.frames(id, 0).done))
    const last = credentialKey('web-test', 'route-50')
    scriptedFlow(ctx, last, 'Route 50', async (flowSession, flowCtx) => {
      await commit(flowCtx, last)
      void flowSession
    })
    const fiftyFirst = remote.begin(last, undefined)
    await waitFor(() => remote.frames(fiftyFirst.attemptId, 0).done)
    const evicted = await Promise.resolve()
      .then(() => remote.frames(ids[0] as string, 0))
      .catch((error: unknown) => error)
    expect(remoteErrorOf(evicted)).toMatchObject({ code: 'authorization/unknown-attempt' })
    expect(ids.slice(1).every(id => remote.frames(id, 0).done)).toBe(true)
  })

  it('evicts the oldest running attempt when nothing settled', async () => {
    const { ctx, remote } = await boot()
    const releases: Array<() => void> = []
    const ids: string[] = []
    for (let index = 0; index < 51; index += 1) {
      const key = credentialKey('web-test', `held-${String(index)}`)
      scriptedFlow(ctx, key, `Held ${String(index)}`, async () => {
        await new Promise<void>((resolve) => { releases.push(resolve) })
      })
      ids.push(remote.begin(key, undefined).attemptId)
    }
    await waitFor(() => releases.length === 51)
    const evicted = await Promise.resolve()
      .then(() => remote.frames(ids[0] as string, 0))
      .catch((error: unknown) => error)
    expect(remoteErrorOf(evicted)).toMatchObject({ code: 'authorization/unknown-attempt' })
    for (const release of releases) release()
  })
})
