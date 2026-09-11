import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEVELOPMENT_WATCH_ROW_ID,
  developmentWatchLayer,
  watchRendererArtifacts,
} from '../../desktop-host/src/development-reload.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A served shell directory whose index document the watcher can be pointed at. */
function shellDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-reload-'))
  roots.push(dir)
  const index = join(dir, 'index.html')
  writeFileSync(index, 'shell v1')
  return index
}

/** Wait longer than the watcher's shell poll interval, so a report that should not happen would have arrived. */
async function quietShellPolls(): Promise<void> {
  const settle = Promise.withResolvers<undefined>()
  setTimeout(settle.resolve, 1_200)
  await settle.promise
}

describe('desktop development renderer reload', () => {
  it('mounts the watch-only reload row into the desktop composition', () => {
    expect(developmentWatchLayer()).toEqual([{
      insert: [{ id: DEVELOPMENT_WATCH_ROW_ID, name: '@deepseek-ai/dsh-client-hmr/watch' }],
    }])
  })

  it('reports a rewritten shell document once, and stops polling on dispose', async () => {
    const index = shellDirectory()
    const rebuilt = vi.fn()
    const dispose = watchRendererArtifacts(
      { shellIndex: index, subscribeToRebuilds: () => () => {} },
      rebuilt,
    )

    writeFileSync(index, 'shell v2')
    await vi.waitFor(() => { expect(rebuilt).toHaveBeenCalledTimes(1) }, { timeout: 3_000 })

    dispose()
    writeFileSync(index, 'shell v3')
    await quietShellPolls()
    expect(rebuilt).toHaveBeenCalledTimes(1)
  })

  it('reports client bundle rebuilds through the subscription until dispose', () => {
    const index = shellDirectory()
    const listeners = new Set<() => void>()
    const rebuilt = vi.fn()
    const dispose = watchRendererArtifacts({
      shellIndex: index,
      subscribeToRebuilds: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }, rebuilt)

    expect(listeners.size).toBe(1)
    for (const listener of listeners) listener()
    expect(rebuilt).toHaveBeenCalledTimes(1)

    dispose()
    expect(listeners.size).toBe(0)
  })

  it('contains a reload observer that throws, so the poll keeps reporting', async () => {
    const index = shellDirectory()
    const rebuilt = vi.fn(() => { throw new Error('renderer is stopping') })
    const listeners = new Set<() => void>()
    const dispose = watchRendererArtifacts({
      shellIndex: index,
      subscribeToRebuilds: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }, rebuilt)

    for (const listener of listeners) listener()
    expect(rebuilt).toHaveBeenCalledTimes(1)

    writeFileSync(index, 'shell v2')
    await vi.waitFor(() => { expect(rebuilt).toHaveBeenCalledTimes(2) }, { timeout: 3_000 })
    dispose()
  })
})
