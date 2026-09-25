import { afterEach, expect, it, vi } from 'vitest'
import { DesktopNotifications } from '../src/desktop-notifications.ts'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const notices: Notice[] = []
  class Notice extends EventEmitter {
    static isSupported = vi.fn(() => true)
    show = vi.fn()
    close = vi.fn()
    constructor(readonly options: unknown) { super(); notices.push(this) }
  }
  return { notices, Notice }
})
vi.mock('electron', () => ({ Notification: native.Notice }))

afterEach(() => { native.notices.length = 0; vi.clearAllMocks(); native.Notice.isSupported.mockReturnValue(true) })

it('shows a notification and reports its click by id', () => {
  const broker = new DesktopNotifications()
  const onClick = vi.fn()
  broker.show('turn:s1', 'Turn finished', 'Refactor auth', onClick)
  expect(native.notices).toHaveLength(1)
  expect(native.notices[0]!.options).toEqual({ title: 'Turn finished', body: 'Refactor auth' })
  native.notices[0]!.emit('click')
  expect(onClick).toHaveBeenCalledWith('turn:s1')
  expect(native.notices[0]!.close).not.toHaveBeenCalled()
})

it('replaces a live notification for the same id without invoking the stale click callback', () => {
  const broker = new DesktopNotifications()
  const first = vi.fn()
  const second = vi.fn()
  broker.show('pending:s1', 'Approval needed', 'a', first)
  const original = native.notices[0]!
  broker.show('pending:s1', 'Approval needed', 'b', second)
  expect(native.notices).toHaveLength(2)
  expect(original.close).toHaveBeenCalledOnce()
  original.emit('click')
  expect(first).not.toHaveBeenCalled()
  native.notices[1]!.emit('click')
  expect(second).toHaveBeenCalledWith('pending:s1')
})

it('withdraws a notification without invoking its click callback; withdraw is idempotent', () => {
  const broker = new DesktopNotifications()
  const onClick = vi.fn()
  broker.show('job:s1:j1', 'Background job finished', 'pnpm test', onClick)
  broker.withdraw('job:s1:j1')
  expect(native.notices[0]!.close).toHaveBeenCalledOnce()
  native.notices[0]!.emit('click')
  expect(onClick).not.toHaveBeenCalled()
  broker.withdraw('job:s1:j1')
  broker.withdraw('missing')
  expect(native.notices[0]!.close).toHaveBeenCalledOnce()
})

it('disposes every live notification', () => {
  const broker = new DesktopNotifications()
  broker.show('a', 't', 'b', vi.fn())
  broker.show('b', 't', 'b', vi.fn())
  broker.disposeAll()
  expect(native.notices[0]!.close).toHaveBeenCalledOnce()
  expect(native.notices[1]!.close).toHaveBeenCalledOnce()
})

it('does not construct a notification when the platform lacks support', () => {
  native.Notice.isSupported.mockReturnValue(false)
  const broker = new DesktopNotifications()
  broker.show('a', 't', 'b', vi.fn())
  expect(native.notices).toHaveLength(0)
})

it('forgets a notification the system reports as failed', () => {
  const broker = new DesktopNotifications()
  const onClick = vi.fn()
  broker.show('a', 't', 'b', onClick)
  native.notices[0]!.emit('failed')
  broker.withdraw('a')
  expect(native.notices[0]!.close).not.toHaveBeenCalled()
})
