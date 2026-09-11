// @vitest-environment jsdom
/**
 * The workspace-memory browser plugin provides the optional `workspacePage`
 * opener and registers the Workspace page into the frame's page seat.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotTestRuntime, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'

afterEach(cleanup)

async function bench() {
  const runtime = await SlotTestRuntime.create()
  const remote = new TestRemote(runtime.ctx, { workspaceMemory: {} })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.sessions.add({ id: 's1', session: {} })
  runtime.ctx.provide('uiWorkspace', { connectWorkspace: async () => 's1' })
  await runtime.root.declare(
    { 'shell.page': { kind: 'single', scope: 'root' } } as never,
    (() => null) as never,
  )
  const handle = await runtime.mount({ inject: [...inject], apply })
  return { runtime, handle, remote }
}

describe('workspace-memory browser plugin', () => {
  it('provides the opener and registers the page seat', async () => {
    const { runtime, handle } = await bench()
    const page = runtime.ctx.get('workspacePage')
    expect(page).toBeDefined()
    page?.open('ws-1')
    expect(runtime.slots.entries('shell.page')).toHaveLength(1)
    await handle.dispose()
    expect(runtime.slots.entries('shell.page')).toHaveLength(0)
    expect(runtime.ctx.get('workspacePage')).toBeUndefined()
    await runtime.dispose()
  })
})
