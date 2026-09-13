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
 * Run a synchronous Remote call, capturing a sync throw as a rejection.
 * @param call - the call to run.
 * @returns its value, or the error it threw.
 */
async function capture<T>(call: () => T): Promise<T | unknown> {
  try {
    return await call()
  } catch (error: unknown) {
    return error
  }
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
    const failure = await capture(() => remote.describe(credentialKey('web-test', 'missing')))
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/no-flow' })
  })

  it('rejects malformed record keys as bad-request', async () => {
    const { remote } = await boot()
    for (const key of ['', 'no-slash', 'HAS-CAPS/lower', 'a/b/c']) {
      expect(remoteErrorOf(await capture(() => remote.describe(key)))).toMatchObject({
        code: 'gateway/bad-request',
      })
      expect(remoteErrorOf(await remote.status(key).catch((error: unknown) => error))).toMatchObject({
        code: 'gateway/bad-request',
      })
      expect(remoteErrorOf(await remote.signOut(key).catch((error: unknown) => error))).toMatchObject({
        code: 'gateway/bad-request',
      })
      expect(remoteErrorOf(await capture(() => remote.begin(key, undefined)))).toMatchObject({
        code: 'gateway/bad-request',
      })
      expect(remoteErrorOf(await capture(() => remote.cancel(key)))).toMatchObject({
        code: 'gateway/bad-request',
      })
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
    expect(remoteErrorOf(await capture(() => remote.begin(credentialKey('web-test', 'missing'), undefined))))
      .toMatchObject({ code: 'authorization/no-flow' })
    scriptedFlow(ctx, KEY, 'Widget', async () => {})
    expect(remoteErrorOf(await capture(() => remote.begin(KEY, 'device'))))
      .toMatchObject({ code: 'authorization/unknown-method' })
    expect(remoteErrorOf(await capture(() => remote.begin(KEY, ''))))
      .toMatchObject({ code: 'authorization/unknown-method' })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const gated = credentialKey('web-test', 'gated')
    scriptedFlow(ctx, gated, 'Gated', async () => { await gate })
    await capture(() => remote.begin(gated, undefined))
    await waitFor(() => remote.list().some(flow => flow.key === gated && flow.inFlight))
    expect(remoteErrorOf(await capture(() => remote.begin(gated, undefined))))
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
    const started = await capture(() => remote.begin(KEY, undefined))
    if (!(typeof started === 'object' && started !== null && 'attemptId' in started)) throw started
    expect(started).toMatchObject({ key: KEY, label: 'Widget', method: 'oauth' })
    await waitFor(() => remote.frames(started.attemptId, 0).next >= 3)
    const polled = remote.frames(started.attemptId, 0)
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
    await remote.answer(started.attemptId, 'p1', 'typed-code')
    await waitFor(() => remote.frames(started.attemptId, 0).done)
    expect(remote.frames(started.attemptId, 3)).toMatchObject({
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
    const started = await capture(() => remote.begin(KEY, 'oauth'))
    if (!(typeof started === 'object' && started !== null && 'attemptId' in started)) throw started
    await waitFor(() => remote.frames(started.attemptId, 0).next >= 1)
    expect(remote.frames(started.attemptId, 0).frames).toEqual([{
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
    await remote.answer(started.attemptId, 'p1', 'home')
    await waitFor(() => remote.frames(started.attemptId, 0).done)
    expect(remote.frames(started.attemptId, 1).outcome).toBe('authorized')
  })

  it('settles a declined prompt as cancelled', async () => {
    const { ctx, remote } = await boot()
    scriptedFlow(ctx, KEY, 'Widget', async (session) => {
      session.notify({ message: 'Starting' })
      await session.prompt({ kind: 'secret', message: 'Paste a token', placeholder: 'sk-…' })
    })
    const started = await capture(() => remote.begin(KEY, undefined))
    if (!(typeof started === 'object' && started !== null && 'attemptId' in started)) throw started
    await waitFor(() => remote.frames(started.attemptId, 0).next >= 2)
    await remote.decline(started.attemptId, 'p1')
    await waitFor(() => remote.frames(started.attemptId, 0).done)
    expect(remote.frames(started.attemptId, 0)).toMatchObject({ done: true, outcome: 'cancelled' })
  })

  it('settles a withdrawn attempt as cancelled', async () => {
    const { ctx, remote } = await boot()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    scriptedFlow(ctx, KEY, 'Widget', async () => { await gate })
    const started = await capture(() => remote.begin(KEY, undefined))
    if (!(typeof started === 'object' && started !== null && 'attemptId' in started)) throw started
    await waitFor(() => remote.list().some(flow => flow.inFlight))
    await remote.cancel(KEY)
    release()
    await waitFor(() => remote.frames(started.attemptId, 0).done)
    expect(remote.frames(started.attemptId, 0).outcome).toBe('cancelled')
  })

  it('carries a flow failure as a failed outcome with its diagnostic', async () => {
    const { ctx, remote } = await boot()
    scriptedFlow(ctx, KEY, 'Widget', async () => {
      throw new Error('the issuer refused the code')
    })
    const started = await capture(() => remote.begin(KEY, undefined))
    if (!(typeof started === 'object' && started !== null && 'attemptId' in started)) throw started
    await waitFor(() => remote.frames(started.attemptId, 0).done)
    expect(remote.frames(started.attemptId, 0)).toMatchObject({
      done: true,
      outcome: 'failed',
      frames: [{ kind: 'outcome', status: 'failed', error: 'the issuer refused the code' }],
    })
    const thrown = credentialKey('web-test', 'string-thrower')
    scriptedFlow(ctx, thrown, 'Thrower', async () => {
      throw 'a bare refusal'
    })
    const second = await capture(() => remote.begin(thrown, undefined))
    if (!(typeof second === 'object' && second !== null && 'attemptId' in second)) throw second
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
    const started = await capture(() => remote.begin(KEY, undefined))
    if (!(typeof started === 'object' && started !== null && 'attemptId' in started)) throw started
    await waitFor(() => remote.frames(started.attemptId, 0).next >= 1)
    withdraw()
    await waitFor(() => remote.frames(started.attemptId, 0).next >= 4)
    expect(remote.frames(started.attemptId, 1)).toMatchObject({
      next: 4,
      frames: [
        { seq: 1, kind: 'prompt-withdrawn', promptId: 'p1' },
        { seq: 2, kind: 'notice', message: 'Trying another way' },
        { seq: 3, kind: 'prompt', prompt: { id: 'p2', kind: 'text', message: 'Second code?' } },
      ],
    })
    expect(remoteErrorOf(await remote.answer(started.attemptId, 'p1', 'too-late')
      .catch((error: unknown) => error))).toMatchObject({ code: 'authorization/inactive-prompt' })
    await remote.answer(started.attemptId, 'p2', 'second-code')
    await waitFor(() => remote.frames(started.attemptId, 0).done)
    expect(remote.frames(started.attemptId, 0).outcome).toBe('authorized')
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
    const started = await capture(() => remote.begin(KEY, undefined))
    if (!(typeof started === 'object' && started !== null && 'attemptId' in started)) throw started
    await waitFor(() => remote.frames(started.attemptId, 0).next >= 1)
    await remote.answer(started.attemptId, 'p1', 'in-time')
    withdraw()
    await waitFor(() => remote.frames(started.attemptId, 0).done)
    const polled = remote.frames(started.attemptId, 0)
    expect(polled.outcome).toBe('authorized')
    expect(polled.frames.some(frame => frame.kind === 'prompt-withdrawn')).toBe(false)
  })

  it('rejects answers it cannot route', async () => {
    const { ctx, remote } = await boot()
    scriptedFlow(ctx, KEY, 'Widget', async (session, flowCtx) => {
      const code = await session.prompt({ kind: 'text', message: 'Code?' })
      await flowCtx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { code } }))
    })
    const started = await capture(() => remote.begin(KEY, undefined))
    if (!(typeof started === 'object' && started !== null && 'attemptId' in started)) throw started
    expect(remoteErrorOf(await remote.answer('no-such-attempt', 'p1', 'x')
      .catch((error: unknown) => error))).toMatchObject({ code: 'authorization/unknown-attempt' })
    for (const bad of ['', 'x'.repeat(129)]) {
      expect(remoteErrorOf(await capture(() => remote.answer(bad, 'p1', 'x'))))
        .toMatchObject({ code: 'gateway/bad-request' })
    }
    expect(remoteErrorOf(await remote.answer(started.attemptId, 'p9', 'x')
      .catch((error: unknown) => error))).toMatchObject({ code: 'authorization/unknown-prompt' })
    expect(remoteErrorOf(await remote.answer(started.attemptId, '', 'x')
      .catch((error: unknown) => error))).toMatchObject({ code: 'gateway/bad-request' })
    expect(remoteErrorOf(await remote.answer(started.attemptId, 'p1', '')
      .catch((error: unknown) => error))).toMatchObject({ code: 'gateway/bad-request' })
    expect(remoteErrorOf(await remote.answer(started.attemptId, 'p1', 123 as unknown as string)
      .catch((error: unknown) => error))).toMatchObject({ code: 'gateway/bad-request' })
    expect(remoteErrorOf(await remote.decline('no-such-attempt', 'p1')
      .catch((error: unknown) => error))).toMatchObject({ code: 'authorization/unknown-attempt' })
    await waitFor(() => remote.frames(started.attemptId, 0).next >= 1)
    await remote.answer(started.attemptId, 'p1', 'settles-it')
    expect(remoteErrorOf(await remote.decline(started.attemptId, 'p1')
      .catch((error: unknown) => error))).toMatchObject({ code: 'authorization/unknown-prompt' })
    await waitFor(() => remote.frames(started.attemptId, 0).done)
  })

  it('rejects cursors it cannot read from', async () => {
    const { ctx, remote } = await boot()
    scriptedFlow(ctx, KEY, 'Widget', async () => {})
    const started = await capture(() => remote.begin(KEY, undefined))
    if (!(typeof started === 'object' && started !== null && 'attemptId' in started)) throw started
    for (const cursor of [-1, 1.5, Number.NaN]) {
      expect(remoteErrorOf(await capture(() => remote.frames(started.attemptId, cursor))))
        .toMatchObject({ code: 'gateway/bad-request' })
    }
    expect(remoteErrorOf(await capture(() => remote.frames('no-such-attempt', 0))))
      .toMatchObject({ code: 'authorization/unknown-attempt' })
    await waitFor(() => remote.frames(started.attemptId, 0).done)
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
      const started = await capture(() => remote.begin(key, undefined))
      if (!(typeof started === 'object' && started !== null && 'attemptId' in started)) throw started
      ids.push(started.attemptId)
    }
    await waitFor(() => ids.every(id => remote.frames(id, 0).done))
    const last = credentialKey('web-test', 'route-50')
    scriptedFlow(ctx, last, 'Route 50', async (flowSession, flowCtx) => {
      await commit(flowCtx, last)
      void flowSession
    })
    const started = await capture(() => remote.begin(last, undefined))
    if (!(typeof started === 'object' && started !== null && 'attemptId' in started)) throw started
    await waitFor(() => remote.frames(started.attemptId, 0).done)
    expect(remoteErrorOf(await capture(() => remote.frames(ids[0] as string, 0))))
      .toMatchObject({ code: 'authorization/unknown-attempt' })
    expect(ids.slice(1).every(id => remote.frames(id, 0).done)).toBe(true)
  })

  it('evicts the oldest running attempt when nothing settled', async () => {
    const { ctx, remote } = await boot()
    const releases: Array<() => void> = []
    const ids: string[] = []
    for (let index = 0; index < 51; index += 1) {
      const key = credentialKey('web-test', `held-${String(index)}`)
      scriptedFlow(ctx, key, `Held ${String(index)}`, async () => {
        await new Promise<void>(resolve => { releases.push(resolve) })
      })
      const started = await capture(() => remote.begin(key, undefined))
      if (!(typeof started === 'object' && started !== null && 'attemptId' in started)) throw started
      ids.push(started.attemptId)
    }
    await waitFor(() => releases.length === 51)
    expect(remoteErrorOf(await capture(() => remote.frames(ids[0] as string, 0))))
      .toMatchObject({ code: 'authorization/unknown-attempt' })
    for (const release of releases) release()
  })
})
