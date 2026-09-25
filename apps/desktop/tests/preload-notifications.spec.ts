import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))
vi.mock('electron', () => electron)

afterEach(() => { vi.clearAllMocks() })

async function bridge() {
  const { createDesktopNotificationBridge } = await import('../src/preload-notifications.ts')
  return createDesktopNotificationBridge()
}

it('forwards show and withdraw to the main process by channel and payload', async () => {
  const b = await bridge()
  b.show({ id: 'turn:s1', title: 'Turn finished', body: 'Refactor auth' })
  b.withdraw('turn:s1')
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC.notificationsShow, 'turn:s1', 'Turn finished', 'Refactor auth')
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC.notificationsWithdraw, 'turn:s1')
})

it('dispatches a click to every registered listener and honors unsubscribe', async () => {
  const b = await bridge()
  const handler = electron.ipcRenderer.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.notificationsClicked)?.[1] as
    (event: unknown, id: unknown) => void
  const first = vi.fn()
  const second = vi.fn()
  const stopFirst = b.onClick(first)
  b.onClick(second)
  handler({}, 'turn:s1')
  expect(first).toHaveBeenCalledWith('turn:s1')
  expect(second).toHaveBeenCalledWith('turn:s1')
  stopFirst()
  handler({}, 'pending:s2')
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledTimes(2)
})

it('ignores a malformed click payload', async () => {
  const b = await bridge()
  const handler = electron.ipcRenderer.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.notificationsClicked)?.[1] as
    (event: unknown, id: unknown) => void
  const listener = vi.fn()
  b.onClick(listener)
  handler({}, 42)
  expect(listener).not.toHaveBeenCalled()
})

it('reports a listener failure without breaking the remaining listeners', async () => {
  const b = await bridge()
  const handler = electron.ipcRenderer.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.notificationsClicked)?.[1] as
    (event: unknown, id: unknown) => void
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const throwing = vi.fn(() => { throw new Error('boom') })
  const ok = vi.fn()
  b.onClick(throwing)
  b.onClick(ok)
  handler({}, 'turn:s1')
  expect(ok).toHaveBeenCalledWith('turn:s1')
  expect(errorSpy).toHaveBeenCalled()
  errorSpy.mockRestore()
})
