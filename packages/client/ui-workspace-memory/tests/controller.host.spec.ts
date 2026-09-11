import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
import WorkspaceMemoryStore from '@deepseek-ai/dsh-workspace-memory'
import WorkspaceMemoryController, { listWorkspaceFiles } from '../src/index.ts'
import type { WorkspaceMemoryFollowFrame } from '../src/types.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const roots: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function harness(options: { extractor?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-ctl-')))
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
  await ctx.plugin(WorkspaceMemoryStore, { capacityBytes: 65536 })
  const rebuild = vi.fn(async () => {})
  if (options.extractor !== false) {
    ctx.provide('workspaceMemoryExtractor', { rebuild } as never)
  }
  ctx.provide('typert', {
    lookups: { configure: () => () => {} },
    contexts: { configureHost: () => () => {} },
  } as never)
  const controller = new WorkspaceMemoryController(ctx)
  const projectDir = join(root, 'project')
  await mkdir(projectDir, { recursive: true })
  const workspace = await ctx.workspaceRegistry.create(projectDir)
  return { controller, ctx, root, workspace, rebuild }
}

async function nextFrame(
  iterator: AsyncIterator<WorkspaceMemoryFollowFrame>,
): Promise<WorkspaceMemoryFollowFrame> {
  const next = await iterator.next()
  if (next.done === true) throw new Error('Memory stream ended before the expected frame')
  return next.value
}

describe('WorkspaceMemoryController', () => {
  it('reads empty projections and rejects unknown workspaces', async () => {
    const { controller, workspace } = await harness()
    const value = await controller.read({ workspaceId: workspace.id })
    expect(value).toMatchObject({
      workspaceId: workspace.id,
      description: '',
      instructions: '',
      memory: '',
      memoryUpdatedAt: null,
      contextItems: [],
      outputs: [],
      lastExtraction: null,
    })
    expect(value.usage).toMatchObject({ usedBytes: 0, capacityBytes: 65536 })
    await expect(controller.read({ workspaceId: 'missing' as WorkspaceId })).rejects.toMatchObject({
      code: 'workspace/not-found',
    })
  })

  it('writes description, instructions, and memory with usage', async () => {
    const { controller, ctx, workspace } = await harness()
    await controller.setDescription({ workspaceId: workspace.id, description: 'blurb' })
    await controller.setInstructions({ workspaceId: workspace.id, instructions: 'rules' })
    const value = await controller.setMemory({ workspaceId: workspace.id, memory: 'doc' })
    expect(value).toMatchObject({ description: 'blurb', instructions: 'rules', memory: 'doc' })
    expect(typeof value.memoryUpdatedAt).toBe('string')
    expect(value.usage.usedBytes).toBeGreaterThan(0)
    await expect(
      controller.setInstructions({ workspaceId: workspace.id, instructions: 'x'.repeat(70000) }),
    ).rejects.toMatchObject({ code: 'workspace-memory/too-large' })

    // Model-written documents project their extraction provenance.
    await ctx.workspaceMemory.setMemory(workspace.id, 'derived', {
      at: '2026-01-01T00:00:00.000Z',
      sessionId: 's1',
      provider: 'p',
      model: 'm',
      inputBytes: 7,
      truncated: false,
    })
    const projected = await controller.read({ workspaceId: workspace.id })
    expect(projected.lastExtraction).toMatchObject({ provider: 'p', model: 'm', truncated: false })
  })

  it('attaches and detaches context items', async () => {
    const { controller, ctx, workspace } = await harness()
    const text = await controller.addContextItem({
      workspaceId: workspace.id,
      kind: 'text',
      label: 'note',
      text: 'hello',
    })
    expect(text.contextItems).toHaveLength(1)

    const filePath = join(workspace.path, 'notes.md')
    await writeFile(filePath, '# notes')
    const file = await controller.addContextItem({
      workspaceId: workspace.id,
      kind: 'file',
      label: 'notes',
      path: 'notes.md',
    })
    expect(file.contextItems).toHaveLength(2)
    expect(file.contextItems[1]).toMatchObject({ kind: 'file', label: 'notes', path: filePath })

    const itemId = (file.contextItems[0] as { id: string }).id
    const after = await controller.removeContextItem({ workspaceId: workspace.id, itemId })
    expect(after.contextItems).toHaveLength(1)
    expect(ctx.workspaceMemory.read(workspace.id)?.contextItems).toHaveLength(1)
    await expect(
      controller.removeContextItem({ workspaceId: workspace.id, itemId: 'missing' }),
    ).rejects.toMatchObject({ code: 'workspace-memory/item-not-found' })
  })

  it('rejects unreadable context paths and malformed requests', async () => {
    const { controller, workspace, root } = await harness()
    await expect(controller.addContextItem({
      workspaceId: workspace.id, kind: 'text', label: 'note',
    })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(controller.addContextItem({
      workspaceId: workspace.id, kind: 'file', label: 'note',
    })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(controller.addContextItem({
      workspaceId: workspace.id, kind: 'file', label: 'missing', path: 'missing.md',
    })).rejects.toMatchObject({ code: 'workspace-memory/context-unreadable' })
    await expect(controller.addContextItem({
      workspaceId: workspace.id, kind: 'file', label: 'dir', path: '.',
    })).rejects.toMatchObject({ code: 'workspace-memory/context-unreadable' })
    await expect(controller.addContextItem({
      workspaceId: workspace.id, kind: 'file', label: 'root', path: workspace.path,
    })).rejects.toMatchObject({ code: 'workspace-memory/context-unreadable' })
    await expect(controller.addContextItem({
      workspaceId: workspace.id, kind: 'file', label: 'outside', path: join(root, 'outside.md'),
    })).rejects.toMatchObject({ code: 'workspace-memory/context-unreadable' })
  })

  it('resolves files after the workspace directory disappears', async () => {
    const { controller, workspace, root } = await harness()
    const outside = join(root, 'outside.md')
    await writeFile(outside, 'outside')
    await rm(workspace.path, { recursive: true, force: true })
    await expect(controller.addContextItem({
      workspaceId: workspace.id, kind: 'file', label: 'outside', path: outside,
    })).rejects.toMatchObject({ code: 'workspace-memory/context-unreadable' })
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
      get: (id: WorkspaceId) => ({
        id, title: 'Ghost', path: ghostPath, sessionIds: [],
      }),
    } as never)
    const controller = new WorkspaceMemoryController(ctx)
    await expect(controller.addContextItem({
      workspaceId: 'ghost' as WorkspaceId, kind: 'file', label: 'outside', path: outside,
    })).rejects.toMatchObject({ code: 'workspace-memory/context-unreadable' })
  })

  it('skips directory junctions when listing candidate files', async () => {
    const { workspace } = await harness()
    await mkdir(join(workspace.path, 'sub'), { recursive: true })
    await writeFile(join(workspace.path, 'sub', 'real.md'), 'r')
    await symlink(join(workspace.path, 'sub'), join(workspace.path, 'link'), 'junction')
    expect(await listWorkspaceFiles(workspace.path, '')).toEqual([join('sub', 'real.md')])
  })

  it('lists candidate files with filtering, sorting, skips, and caps', async () => {
    const { controller, workspace } = await harness()
    const root = workspace.path
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(join(root, '.hidden'), { recursive: true })
    await mkdir(join(root, 'sub', 'deep', 'deeper', 'deepest'), { recursive: true })
    await writeFile(join(root, 'zebra.md'), 'z')
    await writeFile(join(root, 'alpha.MD'), 'a')
    await writeFile(join(root, 'notes.txt'), 'n')
    await writeFile(join(root, 'data.json'), 'j')
    await writeFile(join(root, 'slides.mdx'), 'x')
    await writeFile(join(root, 'README'), 'r')
    await writeFile(join(root, 'node_modules', 'lib.md'), 'l')
    await writeFile(join(root, '.git', 'config.md'), 'g')
    await writeFile(join(root, '.hidden', 'secret.md'), 's')
    await writeFile(join(root, 'sub', 'beta.md'), 'b')
    await writeFile(join(root, 'sub', 'deep', 'gamma.md'), 'g')
    await writeFile(join(root, 'sub', 'deep', 'deeper', 'delta.md'), 'd')
    await writeFile(join(root, 'sub', 'deep', 'deeper', 'deepest', 'dropped.md'), 'e')

    // Direct helper and Remote agree; the query filters case-insensitively.
    expect(await listWorkspaceFiles(root, '')).toEqual([
      'alpha.MD',
      'data.json',
      'notes.txt',
      join('sub', 'beta.md'),
      join('sub', 'deep', 'deeper', 'delta.md'),
      join('sub', 'deep', 'gamma.md'),
      'zebra.md',
    ])
    expect(await controller.listContextFiles({ workspaceId: workspace.id, query: 'ALP' }, new AbortController().signal)).toEqual({
      paths: ['alpha.MD'],
    })
    expect(await controller.listContextFiles({ workspaceId: workspace.id, query: 'zzz' }, new AbortController().signal)).toEqual({ paths: [] })
    await expect(
      controller.listContextFiles({ workspaceId: 'missing' as WorkspaceId, query: '' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'workspace/not-found' })
  })

  it('caps the file listing at 200 entries', async () => {
    const { controller, workspace } = await harness()
    const root = workspace.path
    await Promise.all(Array.from({ length: 205 }, (_, index) =>
      writeFile(join(root, `file-${String(index).padStart(3, '0')}.md`), 'x')))
    const { paths } = await controller.listContextFiles({ workspaceId: workspace.id, query: '' }, new AbortController().signal)
    expect(paths).toHaveLength(200)
    expect(paths).toEqual([...paths].sort())
  })

  it('returns an empty listing when the directory disappears', async () => {
    const { workspace } = await harness()
    await rm(workspace.path, { recursive: true, force: true })
    await expect(listWorkspaceFiles(workspace.path, '')).resolves.toEqual([])
  })

  it('aborts the file listing when the caller cancels', async () => {
    const { controller, workspace } = await harness()
    await expect(
      controller.listContextFiles({ workspaceId: workspace.id, query: '' }, AbortSignal.abort()),
    ).rejects.toThrow()
  })

  it('rebuilds through the extractor and maps its failures', async () => {
    const { controller, workspace, rebuild } = await harness()
    const signal = new AbortController().signal
    const value = await controller.rebuildMemory({ workspaceId: workspace.id }, signal)
    expect(value.workspaceId).toBe(workspace.id)
    expect(rebuild).toHaveBeenCalledWith(workspace.id, signal)
    await expect(
      controller.rebuildMemory({ workspaceId: 'missing' as WorkspaceId }, signal),
    ).rejects.toMatchObject({ code: 'workspace/not-found' })
  })

  it('rejects rebuilds without an extractor', async () => {
    const { controller, workspace } = await harness({ extractor: false })
    await expect(
      controller.rebuildMemory({ workspaceId: workspace.id }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'workspace-memory/extraction-failed' })
  })

  it('passes extractor RemoteErrors through and wraps plain failures', async () => {
    const { controller, workspace, rebuild } = await harness()
    const signal = new AbortController().signal
    rebuild.mockRejectedValueOnce(
      new RemoteError('workspace-memory/extraction-failed', 'no route', { workspaceId: String(workspace.id) }),
    )
    await expect(controller.rebuildMemory({ workspaceId: workspace.id }, signal)).rejects.toMatchObject({
      code: 'workspace-memory/extraction-failed',
      message: 'no route',
    })
    rebuild.mockRejectedValueOnce(new Error('lost model'))
    await expect(controller.rebuildMemory({ workspaceId: workspace.id }, signal)).rejects.toMatchObject({
      code: 'workspace-memory/extraction-failed',
    })
    rebuild.mockRejectedValueOnce('string failure')
    const failure = await controller.rebuildMemory({ workspaceId: workspace.id }, signal).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'workspace-memory/extraction-failed' })
    const message = failure instanceof Error ? failure.message : String(failure)
    expect(message).toContain('string failure')
  })

  it('streams baselines and upserts while ignoring foreign changes', async () => {
    const { controller, ctx, workspace } = await harness()
    const abort = new AbortController()
    const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
    const baseline = await nextFrame(iterator)
    expect(baseline).toMatchObject({ type: 'baseline' })
    if (baseline.type !== 'baseline') throw new Error('expected a baseline frame')
    expect(baseline.values.map(value => value.workspaceId)).toContain(workspace.id)

    // Foreign changes produce no frame: the next frame read is the real upsert.
    ctx.emit('domain/changed', { domain: 'other', table: 'records', key: 'x', operation: 'put', value: {} } as never)
    ctx.emit('domain/changed', {
      domain: 'workspace_memory', table: 'other', key: String(workspace.id), operation: 'put', value: {},
    } as DomainChanged)
    ctx.emit('domain/changed', {
      domain: 'workspace_memory', table: 'records', key: String(workspace.id), operation: 'deleted',
    } as DomainChanged)
    ctx.emit('domain/changed', {
      domain: 'workspace_memory', table: 'records', key: 'unknown', operation: 'put', value: {},
    } as DomainChanged)
    await controller.setInstructions({ workspaceId: workspace.id, instructions: 'rules' })
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
