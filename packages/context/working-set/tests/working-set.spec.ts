/** The working-set plugin over a real index: injection, stability, and configuration. */
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import RepoIndex from '@deepseek-ai/dsh-repo-index'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import * as WorkingSet from '../src/index.ts'
import type { Config } from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

const FILES = {
  'package.json': '{\n  "name": "fixture"\n}\n',
  'auth/auth-controller.ts': [
    "import { AuthService } from './auth-service.ts'",
    '',
    'export class AuthController {',
    '  constructor(private readonly service: AuthService) {}',
    '}',
  ].join('\n'),
  'auth/auth-service.ts': 'export class AuthService {}\n',
  'auth/auth-controller.spec.ts': "import { AuthController } from './auth-controller.ts'\n",
  'auth/README.md': '# auth\n',
  'auth/cache.ts': 'export class CacheStore {}\n',
  'store/store-cache.ts': 'export class StoreCache {}\n',
}

/** Drive one pre-step through the composed listeners with one user task. */
async function preStep(agent: Agent, task = 'auth controller guard'): Promise<PreStepDecision> {
  const message = createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } })
  return await agentEvents(agent.ctx, agent).waterfall('agent/pre-step', {
    messages: [message],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [message] }))
}

/** The injected selection text one pre-step decision carries, when it carries one. */
function setTextOf(decision: PreStepDecision): string | undefined {
  if (decision.kind !== 'enter') return undefined
  const injected = decision.messages.at(-1)
  if (injected === undefined || injected.source.kind !== 'working-set') return undefined
  return injected.content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** One mounted composition over a freshly written workspace. */
async function fixture(
  files: Readonly<Record<string, string>> = FILES,
  config: Config = {},
  options: { readonly agentCwd?: boolean } = {},
): Promise<{ ctx: Context; agent: Agent; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-working-set-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(SessionStore)
  await ctx.plugin(RepoIndex)
  await ctx.plugin(WorkingSet, config)
  const session = ctx.sessions.create(SessionId('working-set-fixture'), options.agentCwd === false ? {} : { meta: { cwd: root } })
  return { ctx, agent: { id: session.id, ctx, session } as Agent, root }
}

describe('working-set', () => {
  it('injects one selection for the session objective and stays quiet while it holds', async () => {
    const { agent } = await fixture()
    const first = await preStep(agent)
    const text = setTextOf(first)
    expect(text).toBeDefined()
    expect(text).toContain('Working set (')
    expect(text).toContain('- auth/auth-controller.ts')
    expect(text).toContain('tests (1):')
    expect(text).toContain('- auth/auth-controller.spec.ts')
    expect(text).toContain('- auth/README.md')
    const injected = (first as Extract<PreStepDecision, { kind: 'enter' }>).messages.at(-1)
    expect(injected?.source).toMatchObject({
      kind: 'working-set',
      form: 'snapshot',
      supersedes: true,
      sections: [{ name: 'working-set', text }],
    })
    expect((first as Extract<PreStepDecision, { kind: 'enter' }>).messages).toHaveLength(2)

    const unchanged = await preStep(agent)
    expect((unchanged as Extract<PreStepDecision, { kind: 'enter' }>).messages).toHaveLength(1)
  }, 30_000)

  it('reads the objective from the newest user text on the surface and ignores entries that are not user-authored', async () => {
    const { agent } = await fixture()
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'store cache work' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const previous = createUserMessage({
      content: [{ type: 'text', text: 'previous selection' }],
      source: { kind: 'working-set', form: 'snapshot', sections: [{ name: 'working-set', text: 'previous selection' }] },
    })
    agent.session.append('user/message', previous, { surfaceOp: 'append' })
    const claimed = createUserMessage({
      content: [{ type: 'reasoning', text: 'ignored reasoning' }, { type: 'text', text: 'auth controller guard' }],
      source: { kind: 'user' },
    })
    const decision = await agentEvents(agent.ctx, agent).waterfall('agent/pre-step', {
      messages: [previous, claimed],
      turn: 2,
      step: 1,
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [claimed] }))
    const text = setTextOf(decision) as string
    expect(text).toContain('- auth/auth-controller.ts')
    expect(text).not.toContain('store/store-cache.ts')
  }, 30_000)

  it('injects nothing for a task no indexed symbol names', async () => {
    const { agent } = await fixture()
    const decision = await preStep(agent, 'zebra widget fencing')
    expect(setTextOf(decision)).toBeUndefined()
    expect((decision as Extract<PreStepDecision, { kind: 'enter' }>).messages).toHaveLength(1)
  }, 30_000)

  it('adopts the snapshot a step already claims instead of emitting it again', async () => {
    const first = await fixture()
    const injected = ((await preStep(first.agent)) as Extract<PreStepDecision, { kind: 'enter' }>).messages.at(-1) as UserMessage
    // A restarted process keeps no rendered memory, so the claimed snapshot is
    // what stops the identical selection from being emitted a second time.
    const restarted = await fixture()
    const task = createUserMessage({ content: [{ type: 'text', text: 'auth controller guard' }], source: { kind: 'user' } })
    const decision = await agentEvents(restarted.agent.ctx, restarted.agent).waterfall('agent/pre-step', {
      messages: [task, injected],
      turn: 2,
      step: 1,
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [task, injected] }))
    expect((decision as Extract<PreStepDecision, { kind: 'enter' }>).messages).toHaveLength(2)
  }, 30_000)

  it('re-injects only when the tree change alters the selection', async () => {
    const { agent, root } = await fixture()
    expect(setTextOf(await preStep(agent))).toBeDefined()

    // A new file the objective does not name changes the index fingerprint but
    // not one selected path, so the session's live snapshot still holds.
    await writeFile(join(root, 'zzz.ts'), 'export class Zzz {}\n')
    expect(setTextOf(await preStep(agent))).toBeUndefined()

    await writeFile(join(root, 'auth/auth-controller-guard.ts'), 'export class AuthControllerGuard {}\n')
    expect(setTextOf(await preStep(agent))).toContain('- auth/auth-controller-guard.ts')
  }, 30_000)

  it('injects nothing without a session workspace or an indexed symbol', async () => {
    const noCwd = await fixture(FILES, {}, { agentCwd: false })
    expect(setTextOf(await preStep(noCwd.agent))).toBeUndefined()

    const empty = await fixture({ 'notes.md': '# notes\n' })
    expect(setTextOf(await preStep(empty.agent))).toBeUndefined()
  }, 30_000)

  it('stops injecting after the workspace loses every symbol the objective names', async () => {
    const { agent, root } = await fixture()
    expect(setTextOf(await preStep(agent))).toBeDefined()
    await unlink(join(root, 'auth/auth-controller.ts'))
    await unlink(join(root, 'auth/auth-service.ts'))
    await unlink(join(root, 'auth/cache.ts'))
    expect(setTextOf(await preStep(agent))).toBeUndefined()
  }, 30_000)

  it('passes a rejected or aborted pre-step through unchanged', async () => {
    const { agent } = await fixture()
    const rejected = await agentEvents(agent.ctx, agent).waterfall('agent/pre-step', {
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'reject' as const, reason: 'no' }))
    expect(rejected).toEqual({ kind: 'reject', reason: 'no' })

    const controller = new AbortController()
    controller.abort()
    const message = createUserMessage({ content: [{ type: 'text', text: 'auth controller' }], source: { kind: 'user' } })
    const aborted = await agentEvents(agent.ctx, agent).waterfall('agent/pre-step', {
      messages: [message],
      turn: 1,
      step: 1,
      signal: controller.signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [message] }))
    expect(aborted.kind).toBe('enter')
    expect((aborted as Extract<PreStepDecision, { kind: 'enter' }>).messages).toHaveLength(1)
  }, 30_000)

  it('rejects unusable bounds', async () => {
    for (const config of [{ maxBytes: 0 }, { maxPrimaryFiles: -1 }, { maxTestFiles: 1.5 }] satisfies Config[]) {
      const ctx = new Context()
      await ctx.plugin(LocalFileSystem, { cwd: tmpdir() })
      await ctx.plugin(RepoIndex)
      await expect(ctx.plugin(WorkingSet, config)).rejects.toThrow(/working-set: /u)
      await ctx.fiber.dispose()
    }
  }, 30_000)
})
