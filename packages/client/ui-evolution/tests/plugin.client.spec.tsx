// @vitest-environment jsdom
/**
 * The evolution browser plugin registers the `evolution` dictionaries, the
 * sidebar panel row, and the matching `main` keyed panel, and hands both back
 * on unload.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotTestRuntime, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import type { PageRemote } from '../src/client/rpc.ts'

afterEach(cleanup)

async function bench() {
  const runtime = await SlotTestRuntime.create()
  const remote = new TestRemote(runtime.ctx, {
    evolution: { follow: () => (async function* () {})() },
    evolutionCurator: {},
  })
  // The carrier's stream factory: the real assembly's job, stubbed here so the
  // injected face is callable without the generated Remote chain.
  const streamed: unknown[] = []
  Object.assign(remote, {
    $stream: (options: unknown) => {
      streamed.push(options)
      return {
        [Symbol.asyncIterator]: async function* () {},
        restart: () => {},
        dispose: async () => {},
        signal: new AbortController().signal,
      }
    },
  })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare(
    {
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      main: { kind: 'keyed', scope: 'root' },
    } as never,
    (() => null) as never,
  )
  const handle = await runtime.mount({ inject: [...inject], apply })
  return { runtime, handle, streamed }
}

describe('evolution browser plugin', () => {
  it('registers the panel row, its panel, and the dictionaries', async () => {
    const { runtime, handle, streamed } = await bench()
    const row = runtime.slots.entries('sidebar.panellist')
    expect(row).toHaveLength(1)
    expect(row[0]?.options.id).toBe('evolution-journey')
    // The row label is a locale-following thunk the sidebar re-resolves.
    expect(typeof row[0]?.options.label).toBe('function')
    expect((row[0]?.options.label as () => string)()).toEqual(expect.any(String))

    const panel = runtime.slots.entries('main')
    expect(panel.map(entry => entry.options.key)).toEqual(['evolution-journey'])

    // The panel's inject face is the page's whole Remote surface.
    const injected = (panel[0]?.inject as () => { remote: PageRemote })()
    const generation = injected.remote.follow(new AbortController().signal)
    expect(generation[Symbol.asyncIterator]()).toBeDefined()
    expect(injected.remote.openStream({
      name: 'spec stream',
      open: signal => injected.remote.follow(signal),
      ended: () => new Error('ended'),
    })).toBeDefined()
    expect(streamed).toHaveLength(1)

    await handle.dispose()
    expect(runtime.slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(runtime.slots.entries('main')).toHaveLength(0)
    await runtime.dispose()
  })

  it('mounts only when both Remote namespaces are present', async () => {
    const runtime = await SlotTestRuntime.create()
    const remote = new TestRemote(runtime.ctx, { evolution: {} })
    runtime.ctx.provide('locale', new LocaleRuntime(runtime.ctx))
    await expect(runtime.mount({ inject: [...inject], apply })).rejects.toThrow(/remote.evolutionCurator/)
    await runtime.dispose()
    void remote
  })
})
