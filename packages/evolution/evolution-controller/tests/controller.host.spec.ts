import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import EvolutionMemoryStore, { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import type { EvolutionMemoryRecord, LessonArtifactInput } from '@deepseek-ai/dsh-evolution-memory'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { dayKeyUTC7 } from '@deepseek-ai/dsh-usage-ledger'
import EvolutionController, { evolutionMemoryValue } from '../src/index.ts'
import type { EvolutionFollowFrame, EvolutionMemoryValue } from '../src/types.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const roots: Context[] = []
const tempDirs: string[] = []

/** One caller-supplied lesson artifact, the shape the Remote verb carries. */
function candidate(statement: string): LessonArtifactInput {
  return {
    statement,
    source: 's1',
    conditions: '',
    evidence: 'inference',
    confidence: 0.5,
    scope: 'project',
  }
}

/**
 * A staged payload carrying artifact candidates. `LessonArtifactInput` is a
 * mapped type whose optional `ttlDays` admits `undefined`, so it is not
 * assignable to the store's `JsonValue` payload type even though the value
 * stored is JSON; the store validates the candidate when the entry is
 * approved, so the bridge cast is test-side only.
 * @param value - the payload object to hand the store.
 * @returns the same object typed as a JSON value.
 */
function artifactPayload(value: object): JsonValue {
  return value as unknown as JsonValue
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function harness(options: { reviewer?: boolean; profile?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-evolution-controller-')))
  tempDirs.push(root)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(EvolutionMemoryStore, { capacityBytes: 65536 })
  const rebuild = vi.fn(async () => {})
  if (options.reviewer !== false) {
    ctx.provide('evolutionReviewer', { rebuild } as never)
  }
  ctx.provide('typert', {
    lookups: { configure: () => () => {} },
    contexts: { configureHost: () => () => {} },
  } as never)
  const controller = new EvolutionController(ctx, { profile: options.profile ?? 'test' })
  const projectDir = join(root, 'project')
  await mkdir(projectDir, { recursive: true })
  const workspace = await ctx.workspaceRegistry.create(projectDir)
  return { controller, ctx, root, workspace, rebuild }
}

async function nextFrame(
  iterator: AsyncIterator<EvolutionFollowFrame>,
): Promise<EvolutionFollowFrame> {
  const next = await iterator.next()
  if (next.done === true) throw new Error('Evolution stream ended before the expected frame')
  return next.value
}

describe('EvolutionController', () => {
  it('reads empty projections and rejects unknown workspaces', async () => {
    const { controller, workspace } = await harness()
    const value = await controller.read({ scopeId: workspace.id })
    expect(value).toMatchObject({
      workspaceId: workspace.id,
      instructions: '',
      lessons: [],
      profile: '',
      memoryUpdatedAt: null,
      instructionsUpdatedAt: null,
      lessonsUpdatedAt: null,
      profileUpdatedAt: null,
      contextItems: [],
      outputs: [],
      episodic: [],
      lastExtraction: null,
      staged: [],
      resolutions: [],
    })
    expect(value.usage).toMatchObject({ usedBytes: 0, capacityBytes: 65536 })
    await expect(controller.read({ scopeId: 'missing' as WorkspaceId })).rejects.toMatchObject({
      code: 'workspace/not-found',
    })
  })

  it('rejects a malformed scope namespace loudly at load', async () => {
    const loadMessage = async (profile: string): Promise<string> => {
      const ctx = new Context()
      ctx.provide('typert', {
        lookups: { configure: () => () => {} },
        contexts: { configureHost: () => () => {} },
      } as never)
      ctx.provide('workspaceRegistry', { list: () => [], get: () => undefined } as never)
      ctx.provide('evolutionMemory', {} as never)
      try {
        new EvolutionController(ctx, { profile })
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      return 'loaded'
    }
    expect(await loadMessage('')).toContain('profile must be non-empty')
    expect(await loadMessage('a:b')).toContain("must not contain ':'")
    expect(await loadMessage('ok')).toBe('loaded')
  })

  it('writes instructions, lessons, and the profile with usage', async () => {
    const { controller, ctx, workspace } = await harness()
    await controller.setInstructions({ scopeId: workspace.id, instructions: 'prefer tabs' })
    const lessons = await controller.setLessons({
      scopeId: workspace.id,
      artifacts: [candidate('lessons')],
    })
    const profile = await controller.setProfile({ scopeId: workspace.id, profile: 'profile' })
    expect(lessons).toMatchObject({ instructions: 'prefer tabs', profile: '' })
    expect(lessons.lessons.map(artifact => artifact.statement)).toEqual(['lessons'])
    expect(profile.lessons.map(artifact => artifact.statement)).toEqual(['lessons'])
    expect(profile).toMatchObject({ profile: 'profile' })
    expect(typeof profile.memoryUpdatedAt).toBe('string')
    expect(profile.usage.usedBytes).toBeGreaterThan(0)
    expect(ctx.evolutionMemory.read(EvolutionScopeId('test', String(workspace.id)))?.userProfile).toBe('profile')

    // The verb replaces the whole document: an omitted artifact is dropped.
    const replaced = await controller.setLessons({
      scopeId: workspace.id,
      artifacts: [candidate('replacement')],
    })
    expect(replaced.lessons.map(artifact => artifact.statement)).toEqual(['replacement'])

    // Model provenance from a store-level write projects onto the Remote face.
    await ctx.evolutionMemory.replaceArtifacts(
      EvolutionScopeId('test', String(workspace.id)),
      [candidate('derived')],
      {
        at: '2026-01-01T00:00:00.000Z',
        sessionId: 's1',
        provider: 'p',
        model: 'm',
        origin: 'background_review',
        inputBytes: 7,
        truncated: false,
      },
    )
    expect((await controller.read({ scopeId: workspace.id })).lastExtraction).toMatchObject({ provider: 'p', model: 'm' })

    await expect(
      controller.setInstructions({ scopeId: workspace.id, instructions: 'x'.repeat(70000) }),
    ).rejects.toMatchObject({ code: 'evolution/capacity-exceeded' })
    for (const call of [
      () => controller.setLessons({ scopeId: 'missing' as WorkspaceId, artifacts: [] }),
      () => controller.setProfile({ scopeId: 'missing' as WorkspaceId, profile: 'x' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'workspace/not-found' })
    }
  })

  it('projects the decided entries and per-family stamps the record carries', () => {
    const record: EvolutionMemoryRecord = {
      instructions: 'rules',
      agentLessons: [{
        ...candidate('lessons'),
        id: 'lessons',
        validationCount: 0,
        refutationCount: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      userProfile: 'profile',
      memoryUpdatedAt: '2026-01-02T00:00:00.000Z',
      instructionsUpdatedAt: '2026-01-01T00:00:00.000Z',
      lessonsUpdatedAt: '2026-01-02T00:00:00.000Z',
      profileUpdatedAt: '2026-01-03T00:00:00.000Z',
      contextItems: [{ kind: 'text', id: 'i1', label: 'note', text: 'x', sizeBytes: 1, addedAt: '2026-01-01T00:00:00.000Z' }],
      outputs: [{ path: 'a.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' }],
      recalls: [],
      episodic: [{ day: '2026-01-01', text: 'note', addedAt: '2026-01-01T00:00:00.000Z' }],
      lastExtraction: null,
      staged: [{ id: 'st1', kind: 'memory', op: 'replaceArtifacts', payload: {}, originSessionId: 's1', createdAt: '2026-01-01T00:00:00.000Z', gist: 'g', mergeKey: null, recurrence: 1, blockedReason: null, neededEvidence: [] }],
      resolutions: [{ id: 'st0', kind: 'memory', op: 'replaceArtifacts', gist: 'g', decision: 'approved', at: '2026-01-01T00:00:00.000Z', originSessionId: 's1', mergeKey: null, recurrence: 1 }],
      updatedAt: '2026-01-03T00:00:00.000Z',
    }
    const value = evolutionMemoryValue('ws-1' as WorkspaceId, record, { usedBytes: 5, capacityBytes: 10 })
    expect(value).toMatchObject({
      workspaceId: 'ws-1',
      instructionsUpdatedAt: '2026-01-01T00:00:00.000Z',
      lessonsUpdatedAt: '2026-01-02T00:00:00.000Z',
      profileUpdatedAt: '2026-01-03T00:00:00.000Z',
      resolutions: [{ id: 'st0', decision: 'approved' }],
      staged: [{ id: 'st1' }],
      episodic: [{ day: '2026-01-01', text: 'note' }],
      usage: { usedBytes: 5, capacityBytes: 10 },
    })
    // The projection is detached from the stored objects.
    expect(value.contextItems[0]).not.toBe(record.contextItems[0])
  })

  it('attaches and detaches context items', async () => {
    const { controller, ctx, workspace } = await harness()
    const text = await controller.addContextItem({
      scopeId: workspace.id,
      kind: 'text',
      label: 'note',
      text: 'hello',
    })
    expect(text.contextItems).toHaveLength(1)

    const filePath = join(workspace.path, 'notes.md')
    await writeFile(filePath, '# notes')
    const file = await controller.addContextItem({
      scopeId: workspace.id,
      kind: 'file',
      label: 'notes',
      path: 'notes.md',
    })
    expect(file.contextItems).toHaveLength(2)
    expect(file.contextItems[1]).toMatchObject({ kind: 'file', label: 'notes', path: filePath })

    const itemId = (file.contextItems[0] as { id: string }).id
    const after = await controller.removeContextItem({ scopeId: workspace.id, itemId })
    expect(after.contextItems).toHaveLength(1)
    expect(ctx.evolutionMemory.read(EvolutionScopeId('test', String(workspace.id)))?.contextItems).toHaveLength(1)
    await expect(
      controller.removeContextItem({ scopeId: workspace.id, itemId: 'missing' }),
    ).rejects.toMatchObject({ code: 'evolution/item-not-found' })
  })

  it('rejects unreadable context paths and malformed requests', async () => {
    const { controller, workspace, root } = await harness()
    await expect(controller.addContextItem({
      scopeId: workspace.id, kind: 'text', label: 'note',
    })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(controller.addContextItem({
      scopeId: workspace.id, kind: 'file', label: 'note',
    })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(controller.addContextItem({
      scopeId: workspace.id, kind: 'file', label: 'missing', path: 'missing.md',
    })).rejects.toMatchObject({ code: 'evolution/context-unreadable' })
    await expect(controller.addContextItem({
      scopeId: workspace.id, kind: 'file', label: 'dir', path: '.',
    })).rejects.toMatchObject({ code: 'evolution/context-unreadable' })
    await expect(controller.addContextItem({
      scopeId: workspace.id, kind: 'file', label: 'root', path: workspace.path,
    })).rejects.toMatchObject({ code: 'evolution/context-unreadable' })
    await expect(controller.addContextItem({
      scopeId: workspace.id, kind: 'file', label: 'outside', path: join(root, 'outside.md'),
    })).rejects.toMatchObject({ code: 'evolution/context-unreadable' })
    await expect(controller.addContextItem({
      scopeId: 'missing' as WorkspaceId, kind: 'text', label: 'note', text: 'x',
    })).rejects.toMatchObject({ code: 'workspace/not-found' })
  })

  it('resolves files after the workspace directory disappears', async () => {
    const { controller, workspace, root } = await harness()
    const outside = join(root, 'outside.md')
    await writeFile(outside, 'outside')
    await rm(workspace.path, { recursive: true, force: true })
    await expect(controller.addContextItem({
      scopeId: workspace.id, kind: 'file', label: 'outside', path: outside,
    })).rejects.toMatchObject({ code: 'evolution/context-unreadable' })
  })

  it('rejects files against a vanished separator-suffixed workspace root', async () => {
    const { root } = await harness()
    const outside = join(root, 'outside.md')
    await writeFile(outside, 'outside')
    // A stored root that no longer resolves keeps its separator, so the
    // containment check must not double it before comparing.
    const ghostPath = `${join(root, 'gone')}${sep}`
    const ctx = new Context()
    roots.push(ctx)
    ctx.provide('typert', {
      lookups: { configure: () => () => {} },
      contexts: { configureHost: () => () => {} },
    } as never)
    ctx.provide('workspaceRegistry', {
      list: () => [],
      get: (id: WorkspaceId) => ({ id, title: 'Ghost', path: ghostPath, sessionIds: [] }),
    } as never)
    const controller = new EvolutionController(ctx, { profile: 'test' })
    await expect(controller.addContextItem({
      scopeId: 'ghost' as WorkspaceId, kind: 'file', label: 'outside', path: outside,
    })).rejects.toMatchObject({ code: 'evolution/context-unreadable' })
  })

  it('accepts an absolute file path inside the workspace', async () => {
    const { controller, workspace } = await harness()
    const filePath = join(workspace.path, 'absolute.md')
    await writeFile(filePath, 'absolute')
    const value = await controller.addContextItem({
      scopeId: workspace.id, kind: 'file', label: 'absolute', path: filePath,
    })
    expect(value.contextItems[0]).toMatchObject({ kind: 'file', path: filePath })
  })

  it('rejects a directory junction as a context file', async () => {
    const { controller, workspace } = await harness()
    await mkdir(join(workspace.path, 'sub'), { recursive: true })
    await writeFile(join(workspace.path, 'sub', 'real.md'), 'r')
    await symlink(join(workspace.path, 'sub'), join(workspace.path, 'link'), 'junction')
    // A junction resolves inside the Workspace but is not a regular file.
    await expect(controller.addContextItem({
      scopeId: workspace.id, kind: 'file', label: 'link', path: join(workspace.path, 'link'),
    })).rejects.toMatchObject({ code: 'evolution/context-unreadable' })
  })

  it('rebuilds through the reviewer and maps its failures', async () => {
    const { controller, workspace, rebuild } = await harness()
    const signal = new AbortController().signal
    const value = await controller.rebuildMemory({ scopeId: workspace.id }, signal)
    expect(value.workspaceId).toBe(workspace.id)
    expect(rebuild).toHaveBeenCalledWith(EvolutionScopeId('test', String(workspace.id)), signal)
    await expect(
      controller.rebuildMemory({ scopeId: 'missing' as WorkspaceId }, signal),
    ).rejects.toMatchObject({ code: 'workspace/not-found' })
  })

  it('rejects rebuilds without a reviewer', async () => {
    const { controller, workspace } = await harness({ reviewer: false })
    await expect(
      controller.rebuildMemory({ scopeId: workspace.id }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'evolution/extraction-failed' })
  })

  it('passes reviewer RemoteErrors through and wraps plain failures', async () => {
    const { controller, workspace, rebuild } = await harness()
    const signal = new AbortController().signal
    rebuild.mockRejectedValueOnce(
      new RemoteError('evolution/extraction-failed', 'no route', { scopeId: String(workspace.id) }),
    )
    await expect(controller.rebuildMemory({ scopeId: workspace.id }, signal)).rejects.toMatchObject({
      code: 'evolution/extraction-failed',
      message: 'no route',
    })
    rebuild.mockRejectedValueOnce(new Error('lost model'))
    await expect(controller.rebuildMemory({ scopeId: workspace.id }, signal)).rejects.toMatchObject({
      code: 'evolution/extraction-failed',
      message: expect.stringContaining('lost model') as unknown,
    })
    rebuild.mockRejectedValueOnce('string failure')
    const failure = await controller.rebuildMemory({ scopeId: workspace.id }, signal).catch((error: unknown) => error)
    const message = failure instanceof Error ? failure.message : String(failure)
    expect(message).toContain('string failure')
  })

  it('lists, approves, and rejects staged writes inside the resolved scope', async () => {
    const { controller, ctx, root, workspace } = await harness()
    const scope = EvolutionScopeId('test', String(workspace.id))
    await expect(controller.listStaged({ scopeId: 'missing' as WorkspaceId })).rejects.toMatchObject({
      code: 'workspace/not-found',
    })
    expect(await controller.listStaged({ scopeId: workspace.id })).toEqual({ staged: [] })

    const entry = await ctx.evolutionMemory.stageWrite({
      scopeId: scope, kind: 'memory', op: 'replaceArtifacts',
      payload: artifactPayload({ candidates: [candidate('staged lessons')] }),
      originSessionId: 's1', gist: 'staged proposal',
    })
    expect(await controller.listStaged({ scopeId: workspace.id })).toEqual({ staged: [entry] })

    // The entry belongs to this scope, so the decision lands.
    const approved = await controller.approveStaged({ scopeId: workspace.id, stagedId: entry.id })
    expect(approved.lessons.map(artifact => artifact.statement)).toEqual(['staged lessons'])
    expect(approved.staged).toEqual([])

    // A staged id from another scope is reported as absent, never decided.
    const otherDir = join(root, 'other')
    await mkdir(otherDir, { recursive: true })
    const otherWorkspace = await ctx.workspaceRegistry.create(otherDir)
    const otherScope = EvolutionScopeId('test', String(otherWorkspace.id))
    const other = await ctx.evolutionMemory.stageWrite({
      scopeId: otherScope, kind: 'memory', op: 'replaceArtifacts',
      payload: artifactPayload({ candidates: [candidate('other lessons')] }),
      originSessionId: 's2', gist: 'other proposal',
    })
    await expect(
      controller.rejectStaged({ scopeId: workspace.id, stagedId: other.id }),
    ).rejects.toMatchObject({ code: 'evolution/staged-not-found' })
    await expect(
      controller.approveStaged({ scopeId: workspace.id, stagedId: 'missing' }),
    ).rejects.toMatchObject({ code: 'evolution/staged-not-found' })
    await expect(
      controller.approveStaged({ scopeId: 'missing' as WorkspaceId, stagedId: other.id }),
    ).rejects.toMatchObject({ code: 'workspace/not-found' })

    // A registered scope that has never written has no entry to decide either.
    const bareDir = join(root, 'bare')
    await mkdir(bareDir, { recursive: true })
    const bareWorkspace = await ctx.workspaceRegistry.create(bareDir)
    await expect(
      controller.approveStaged({ scopeId: bareWorkspace.id, stagedId: other.id }),
    ).rejects.toMatchObject({ code: 'evolution/staged-not-found' })

    expect(await controller.rejectStaged({ scopeId: otherWorkspace.id, stagedId: other.id })).toMatchObject({
      staged: [],
    })
    expect(ctx.evolutionMemory.read(otherScope)?.agentLessons).toEqual([])
  })

  it('timelines the resolved scope and rejects unknown ranges', async () => {
    const { controller, ctx, workspace } = await harness()
    const scope = EvolutionScopeId('test', String(workspace.id))
    await ctx.evolutionMemory.recordOutputs(scope, [
      { path: 'src/a.ts', tool: 'write', sessionId: 's1', at: new Date().toISOString() },
    ])
    const today = dayKeyUTC7(Date.now())
    const timeline = await controller.timeline({ scopeId: workspace.id, range: '7d' })
    expect(timeline.days.map(day => day.day)).toHaveLength(7)
    expect(timeline.days.at(-1)?.day).toBe(today)
    expect(timeline.days.at(-1)?.outputsIndexed).toBe(1)
    expect(timeline.cumulative).toEqual({
      usedBytes: 0,
      capacityBytes: 65536,
      digest: ctx.evolutionMemory.digest(scope),
      lessonsBytes: 0,
      profileBytes: 0,
    })
    expect(timeline.pending).toEqual([])

    await expect(
      controller.timeline({ scopeId: workspace.id, range: 'nope' as never }),
    ).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(
      controller.timeline({ scopeId: 'missing' as WorkspaceId, range: '7d' }),
    ).rejects.toMatchObject({ code: 'workspace/not-found' })
  })

  it('streams one baseline per scope and upserts only this domain', async () => {
    const { controller, ctx, workspace } = await harness()
    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    const baseline = await nextFrame(iterator)
    expect(baseline).toMatchObject({ type: 'baseline' })
    if (baseline.type !== 'baseline') throw new Error('expected a baseline frame')
    expect(baseline.values.map((value: EvolutionMemoryValue) => value.workspaceId)).toEqual([workspace.id])

    // Foreign changes produce no frame: the next frame read is the real upsert.
    ctx.emit('domain/changed', { domain: 'other', table: 'records', key: 'x', operation: 'put', value: {} } as never)
    ctx.emit('domain/changed', {
      domain: 'evolution_memory', table: 'other', key: String(workspace.id), operation: 'put', value: {},
    } as DomainChanged)
    ctx.emit('domain/changed', {
      domain: 'evolution_memory', table: 'records', key: 'test--x', operation: 'deleted',
    } as DomainChanged)
    ctx.emit('domain/changed', {
      domain: 'evolution_memory', table: 'records', key: 'other--x', operation: 'put', value: {},
    } as DomainChanged)
    await controller.setInstructions({ scopeId: workspace.id, instructions: 'rules' })
    const upsert = await nextFrame(iterator)
    expect(upsert).toMatchObject({ type: 'upsert', value: { workspaceId: workspace.id, instructions: 'rules' } })
    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('rejects follow generations that start aborted', async () => {
    const { controller } = await harness()
    await expect(async () => {
      const iterator = controller.follow(AbortSignal.abort())[Symbol.asyncIterator]()
      await iterator.next()
    }).rejects.toThrow()
  })

  it('closes active followers on context teardown', async () => {
    const { controller, ctx } = await harness()
    const iterator = controller.follow(new AbortController().signal)[Symbol.asyncIterator]()
    await nextFrame(iterator)
    const pending = iterator.next()
    await ctx.fiber.dispose()
    await expect(pending).resolves.toMatchObject({ done: true })
  })
})
