// @vitest-environment jsdom
/** Operation forwarding over the authorization Remote namespace. */
import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { createAuthorizationOperations } from '../src/client/operations.ts'

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function stubRemote(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    list: vi.fn(async () => ok([])),
    status: vi.fn(async () => ok({ configured: false })),
    signOut: vi.fn(async () => ok(undefined)),
    begin: vi.fn(async () => ok({ attemptId: 'a1' })),
    frames: vi.fn(async () => ok({ frames: [], next: 0, done: false })),
    answer: vi.fn(async () => ok(undefined)),
    cancel: vi.fn(async () => ok(undefined)),
  }
}

function boot(): { operations: ReturnType<typeof createAuthorizationOperations>; remote: Record<string, ReturnType<typeof vi.fn>> } {
  const remote = stubRemote()
  const ctx = { remote: { authorization: remote } } as unknown as ClientContext
  return { operations: createAuthorizationOperations(ctx), remote }
}

describe('the sign-in companion operations', () => {
  it('lists flows', async () => {
    const { operations, remote } = boot()
    await operations.list()
    expect(remote['list']).toHaveBeenCalledTimes(1)
  })

  it('reads and forgets stored grants', async () => {
    const { operations, remote } = boot()
    await operations.status('llm-pi-ai/anthropic')
    expect(remote['status']).toHaveBeenCalledWith('llm-pi-ai/anthropic')
    await operations.signOut('llm-pi-ai/anthropic')
    expect(remote['signOut']).toHaveBeenCalledWith('llm-pi-ai/anthropic')
  })

  it('begins an attempt with the picked method', async () => {
    const { operations, remote } = boot()
    await operations.begin('llm-pi-ai/anthropic', 'oauth')
    expect(remote['begin']).toHaveBeenCalledWith('llm-pi-ai/anthropic', 'oauth')
  })

  it('polls frames after a cursor', async () => {
    const { operations, remote } = boot()
    await operations.frames('attempt-1', 3)
    expect(remote['frames']).toHaveBeenCalledWith('attempt-1', 3)
  })

  it('answers one pending prompt', async () => {
    const { operations, remote } = boot()
    await operations.answer('attempt-1', 'p1', 'typed-code')
    expect(remote['answer']).toHaveBeenCalledWith('attempt-1', 'p1', 'typed-code')
  })

  it('withdraws the running attempt', async () => {
    const { operations, remote } = boot()
    await operations.cancel('llm-pi-ai/anthropic')
    expect(remote['cancel']).toHaveBeenCalledWith('llm-pi-ai/anthropic')
  })
})
