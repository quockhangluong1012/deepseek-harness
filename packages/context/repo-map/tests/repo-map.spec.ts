/** The map plugin over a real index: injection, stability, bounds, and configuration. */
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import RepoIndex from '@deepseek-ai/dsh-repo-index'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as RepoMap from '../src/index.ts'
import { mapTextOf, preStep } from './fixtures/driving.ts'
import type { Config } from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

const CONTROLLER = [
  'export class AuthController {',
  '  constructor(private readonly service: AuthService) {}',
  '}',
  'export class AuthService {}',
].join('\n')

/** One mounted composition over a freshly written workspace. */
async function fixture(
  files: Readonly<Record<string, string>>,
  config: Config = {},
  options: { readonly agentCwd?: boolean } = {},
): Promise<{ ctx: Context; agent: Agent; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repo-map-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(SessionStore)
  await ctx.plugin(RepoIndex)
  await ctx.plugin(RepoMap, config)
  const session = ctx.sessions.create(SessionId('repo-map-fixture'), options.agentCwd === false ? {} : { meta: { cwd: root } })
  return { ctx, agent: { id: session.id, ctx, session } as Agent, root }
}

describe('repo-map', () => {
  it('injects one ranked map for the session objective and stays quiet while it holds', async () => {
    const { agent, root } = await fixture({ 'auth.ts': CONTROLLER })
    const first = await preStep(agent)
    const text = mapTextOf(first)
    expect(text).toBeDefined()
    expect(text).toContain('Repository map (ranked by relevance to the current task; 2 indexed symbols from 1 files, most relevant first):')
    expect(text).toContain('- AuthController [class] auth.ts:1')
    expect(text).toContain('  -> AuthService [class] auth.ts:4')
    const injected = (first as Extract<PreStepDecision, { kind: 'enter' }>).messages.at(-1)
    expect(injected?.source).toMatchObject({
      kind: 'repo-map',
      form: 'snapshot',
      supersedes: true,
      sections: [{ name: 'repo-map', text }],
    })
    expect((first as Extract<PreStepDecision, { kind: 'enter' }>).messages).toHaveLength(2)

    const unchanged = await preStep(agent)
    expect((unchanged as Extract<PreStepDecision, { kind: 'enter' }>).messages).toHaveLength(1)

    await writeFile(join(root, 'gate.ts'), 'export class AuthGate {}\n')
    const changed = await preStep(agent)
    expect(mapTextOf(changed)).toContain('AuthGate')
  }, 30_000)

  it('prefers the claimed task over the session surface', async () => {
    const { agent } = await fixture({
      'auth.ts': 'export class AuthController {}\n',
      'table.ts': 'export class TableRenderer {}\n',
    }, { maxNodes: 1 })
    const snapshotMessage = createUserMessage({
      content: [{ type: 'text', text: 'map text' }],
      source: { kind: 'repo-map', form: 'snapshot', sections: [{ name: 'repo-map', text: 'map text' }] },
    })
    const earlier = createUserMessage({ content: [{ type: 'text', text: 'table rendering work' }], source: { kind: 'user' } })
    agent.session.append('user/message', snapshotMessage, { surfaceOp: 'append' })
    agent.session.append('user/message', earlier, { surfaceOp: 'append' })
    const claimed = createUserMessage({ content: [{ type: 'text', text: 'auth controller guard' }], source: { kind: 'user' } })
    const decision = await agentEvents(agent.ctx, agent).waterfall('agent/pre-step', {
      messages: [snapshotMessage, claimed],
      turn: 2,
      step: 1,
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [claimed] }))
    const text = mapTextOf(decision) as string
    expect(text).toContain('- AuthController [class] auth.ts:1')
    expect(text).not.toContain('TableRenderer')
  }, 30_000)

  it('reads the objective from text blocks only', async () => {
    const { agent } = await fixture({ 'auth.ts': CONTROLLER })
    const reasoning = createUserMessage({
      content: [{ type: 'reasoning', text: 'ignored reasoning' }, { type: 'text', text: 'auth controller' }],
      source: { kind: 'user' },
    })
    const decision = await agentEvents(agent.ctx, agent).waterfall('agent/pre-step', {
      messages: [reasoning],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [reasoning] }))
    expect(mapTextOf(decision)).toContain('- AuthController [class] auth.ts:1')
  }, 30_000)

  it('bounds the listed nodes while keeping the references of each listed node', async () => {
    const { agent } = await fixture({ 'auth.ts': CONTROLLER }, { maxNodes: 1 })
    const text = mapTextOf(await preStep(agent)) as string
    expect(text.split('\n').filter(line => line.startsWith('- '))).toEqual(['- AuthController [class] auth.ts:1'])
    expect(text).toContain('  -> AuthService [class] auth.ts:4')
  }, 30_000)

  it('injects nothing without a session workspace or an indexed symbol', async () => {
    const noCwd = await fixture({ 'auth.ts': CONTROLLER }, {}, { agentCwd: false })
    expect(mapTextOf(await preStep(noCwd.agent))).toBeUndefined()

    const empty = await fixture({ 'notes.md': '# notes\n' })
    expect(mapTextOf(await preStep(empty.agent))).toBeUndefined()

    const tiny = await fixture({ 'auth.ts': CONTROLLER }, { maxBytes: 8 })
    expect(mapTextOf(await preStep(tiny.agent))).toBeUndefined()
  }, 30_000)

  it('stops injecting after the workspace loses every symbol', async () => {
    const { agent, root } = await fixture({ 'auth.ts': CONTROLLER })
    expect(mapTextOf(await preStep(agent))).toBeDefined()
    await unlink(join(root, 'auth.ts'))
    await writeFile(join(root, 'notes.md'), '# notes\n')
    expect(mapTextOf(await preStep(agent))).toBeUndefined()
  }, 30_000)

  it('passes a rejected or aborted pre-step through unchanged', async () => {
    const { agent } = await fixture({ 'auth.ts': CONTROLLER })
    const rejected = await agentEvents(agent.ctx, agent).waterfall('agent/pre-step', {
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'reject' as const, reason: 'no' }))
    expect(rejected).toEqual({ kind: 'reject', reason: 'no' })

    const controller = new AbortController()
    controller.abort()
    const message = createUserMessage({ content: [{ type: 'text', text: 'auth' }], source: { kind: 'user' } })
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
    for (const config of [{ maxBytes: 0 }, { maxNodes: -1 }, { maxEdgesPerNode: 1.5 }] satisfies Config[]) {
      const ctx = new Context()
      await ctx.plugin(LocalFileSystem, { cwd: tmpdir() })
      await ctx.plugin(RepoIndex)
      await expect(ctx.plugin(RepoMap, config)).rejects.toThrow(/repo-map: /u)
      await ctx.fiber.dispose()
    }
  }, 30_000)
})
