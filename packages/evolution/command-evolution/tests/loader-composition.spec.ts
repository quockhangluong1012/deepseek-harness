import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import * as EvolutionMemory from '@deepseek-ai/dsh-evolution-memory'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as CommandEvolution from '@deepseek-ai/dsh-command-evolution'

const pool = new MemoryMediaPool()

const memoryBackendPlugin = {
  name: 'test-memory-backend',
  inject: ['storage'],
  apply(ctx: Context) {
    const backend = new MemoryStorageBackend(pool)
    ctx.effect(() => {
      const unregister = ctx.storage.backend.register('memory', backend)
      return async () => {
        unregister()
        await backend.close()
      }
    })
    ctx.provide(storageBackendServiceKey('memory'), backend)
  },
}

interface StubWorkspace {
  id: WorkspaceId
  title: string
  path: string
  sessionIds: SessionId[]
}

function registryPlugin(workspaces: Map<string, StubWorkspace>) {
  return {
    name: 'test-workspace-registry',
    apply(ctx: Context) {
      ctx.provide('workspaceRegistry', {
        list: () => [...workspaces.values()],
        get: (id: WorkspaceId) => workspaces.get(String(id)),
      } as never)
    },
  }
}

function reviewerPlugin(calls: { scope: unknown }[]) {
  return {
    name: 'test-evolution-reviewer',
    inject: ['evolutionMemory'],
    apply(ctx: Context) {
      ctx.provide('evolutionReviewer', {
        rebuild: async (scopeId: unknown) => {
          calls.push({ scope: scopeId })
          await ctx.evolutionMemory.setLessons(
            scopeId as Parameters<typeof ctx.evolutionMemory.setLessons>[0],
            'rebuilt lessons',
          )
        },
      } as never)
    },
  }
}

function fakeAgent(session: { id: unknown }): Agent {
  return {
    session,
    status: 'idle',
    options: {},
    reserveTurnAdmission: () => () => undefined,
  } as unknown as Agent
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('command-evolution real Loader composition', () => {
  it('discovers and executes /memory and /refine through the assembled command plane', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-command-evolution-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@deepseek-ai/dsh-storage'",
      "- name: '@test/memory-backend'",
      "- name: '@deepseek-ai/dsh-storage-domain'",
      "  config: { backend: 'memory' }",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@test/workspace-registry'",
      "- name: '@deepseek-ai/dsh-evolution-memory'",
      '  config: { capacityBytes: 65536 }',
      "- name: '@test/stub-reviewer'",
      "- name: '@deepseek-ai/dsh-command-evolution'",
      "  config: { profile: 'test' }",
      '',
    ].join('\n'))

    const workspaces = new Map<string, StubWorkspace>()
    const rebuilds: { scope: unknown }[] = []
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@deepseek-ai/dsh-storage', Storage],
      ['@test/memory-backend', memoryBackendPlugin],
      ['@deepseek-ai/dsh-storage-domain', StorageDomain],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@test/workspace-registry', registryPlugin(workspaces)],
      ['@deepseek-ai/dsh-evolution-memory', EvolutionMemory],
      ['@test/stub-reviewer', reviewerPlugin(rebuilds)],
      ['@deepseek-ai/dsh-command-evolution', CommandEvolution],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const session = context.sessions.create(SessionId('loader-command-evolution'))
    const agent = fakeAgent(session)
    workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: root, sessionIds: [session.id] })
    const scope = EvolutionScopeId('test', 'ws-1')
    const signal = new AbortController().signal

    expect(context.commands.list(agent).map(command => command.name)).toEqual(
      expect.arrayContaining(['memory', 'refine']),
    )

    const pending = await context.commands.execute(agent, '/memory pending', [], signal)
    expect(pending?.result).toEqual({ kind: 'success', text: 'No pending writes.' })

    const staged = await context.evolutionMemory.stageWrite({
      scopeId: scope, kind: 'memory', op: 'setLessons',
      payload: { text: 'loader lessons' }, originSessionId: 's1', gist: 'loader proposal',
    })
    const listed = await context.commands.execute(agent, '/memory pending', [], signal)
    expect(listed?.result).toEqual({
      kind: 'success',
      text: `1 pending write:\n- ${staged.id} [memory:setLessons] loader proposal (session 's1', ${staged.createdAt})`,
    })

    const approved = await context.commands.execute(agent, `/memory approve ${staged.id}`, [], signal)
    expect(approved?.result).toEqual({
      kind: 'success',
      text: 'Approved staged setLessons (loader proposal).',
    })
    expect(context.evolutionMemory.read(scope)?.agentLessons).toBe('loader lessons')

    const refined = await context.commands.execute(agent, '/refine', [], signal)
    expect(refined?.result).toEqual({ kind: 'success', text: 'Memory rebuild complete.' })
    expect(rebuilds).toEqual([{ scope }])
    expect(context.evolutionMemory.read(scope)?.agentLessons).toBe('rebuilt lessons')

    expect(session.snapshotEvents().map(event => event.type).filter(type => type === 'command/run' || type === 'command/done'))
      .toEqual(['command/run', 'command/done', 'command/run', 'command/done', 'command/run', 'command/done', 'command/run', 'command/done'])
    expect(session.deriveMessages()).toEqual([])
  })
})
