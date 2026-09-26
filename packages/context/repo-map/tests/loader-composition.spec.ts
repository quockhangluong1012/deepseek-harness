/**
 * Real Loader composition: the loaded tree indexes the session's workspace,
 * registers the map as a required compiler source, injects it as a durable
 * snapshot, and records the placement.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as agentContextPlugin from '@deepseek-ai/dsh-agent-context'
import * as fsPlugin from '@deepseek-ai/dsh-fs-local'
import * as repoIndexPlugin from '@deepseek-ai/dsh-repo-index'
import * as repoMapPlugin from '@deepseek-ai/dsh-repo-map'
import * as projectionPlugin from '@deepseek-ai/dsh-session-projection'
import * as sessionPlugin from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import { mapTextOf, preStep } from './fixtures/driving.ts'

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

/** Boot the fixture composition through the Loader over one written workspace. */
async function boot(workspace: string): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repo-map-loader-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const fixture = await readFile(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, fixture.replace('{{workspace}}', workspace.replaceAll('\\', '/')))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', sessionPlugin],
    ['@deepseek-ai/dsh-session-projection', projectionPlugin],
    ['@deepseek-ai/dsh-system-prompt', systemPromptPlugin],
    ['@deepseek-ai/dsh-agent-context', agentContextPlugin],
    ['@deepseek-ai/dsh-fs-local', fsPlugin],
    ['@deepseek-ai/dsh-repo-index', repoIndexPlugin],
    ['@deepseek-ai/dsh-repo-map', repoMapPlugin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('repo-map real Loader composition', () => {
  it('registers the map as a required source and injects it for the session objective', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-repo-map-workspace-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'auth.ts'), CONTROLLER)
    const ctx = await boot(workspace)
    const session = ctx.sessions.create(SessionId('repo-map-loaded'), { meta: { cwd: workspace } })
    const agent = { id: session.id, ctx, session } as Agent

    const placed = await ctx.agentContext.compile(agent, { sections: [], contexts: [], tools: [], variables: {} })
    const source = placed.included.find(entry => entry.source.id === 'repo-map:map')
    expect(source?.source).toMatchObject({ kind: 'artifact', trust: 'untrusted', retention: 'required' })
    expect(source?.source.content).toContain('- AuthController [class] auth.ts:1')
    expect(source?.source.content).toContain('  -> AuthService [class] auth.ts:4')

    const text = mapTextOf(await preStep(agent))
    expect(text).toBe(source?.source.content)

    const recorded = session.snapshotEvents().filter(event => event.type === 'context/compiled')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.data.included.map(entry => entry.id)).toEqual(['repo-map:map'])
    expect(recorded[0]?.data.included[0]?.retention).toBe('required')

    const reused = await ctx.agentContext.compile(agent, { sections: [], contexts: [], tools: [], variables: {} })
    expect(reused.included.find(entry => entry.source.id === 'repo-map:map')?.source.content).toBe(text)
    expect(session.snapshotEvents().filter(event => event.type === 'context/compiled')).toHaveLength(1)

    // A session that declares no workspace contributes no map source at all.
    const bare = ctx.sessions.create(SessionId('repo-map-loaded-bare'))
    const bareAgent = { id: bare.id, ctx, session: bare } as Agent
    const empty = await ctx.agentContext.compile(bareAgent, { sections: [], contexts: [], tools: [], variables: {} })
    expect(empty.included).toEqual([])
  }, 60_000)
})
