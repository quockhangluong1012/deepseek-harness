/**
 * The reveal policy: once per Session, at the first progress of a Session the
 * agent ran in, and never for a Session that is not on screen.
 */
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { revealOnProgress, type ProgressFollow, type RevealWatch } from '../src/client/auto-open.ts'

const A = 'session-a' as SessionId
const B = 'session-b' as SessionId

/** One Session's stand-in: its running flag, its progress flag, and its subscriber list. */
class FakeFollow implements ProgressFollow {
  running = false
  progress = false
  readonly changes: Array<() => void> = []
  readonly dispose = vi.fn()

  isRunning(): boolean {
    return this.running
  }

  hasProgress(): boolean {
    return this.progress
  }

  /** Report the agent starting to run, the way the Session snapshot would. */
  start(): void {
    this.running = true
    this.notify()
  }

  /** Report progress, the way a projection or target frame would. */
  report(): void {
    this.progress = true
    this.notify()
  }

  /** Report the agent stopping, the way the Session snapshot would. */
  stop(): void {
    this.running = false
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.changes]) listener()
  }
}

function bench(): {
  watch: RevealWatch
  reveal: Mock
  follows: Map<string, FakeFollow>
  /** Every Session followed, in order: the reveal must not re-follow one it revealed. */
  created: string[]
  select: (id: SessionId | undefined) => void
  live: Set<string>
} {
  const follows = new Map<string, FakeFollow>()
  const created: string[] = []
  const live = new Set<string>([A, B])
  let current: SessionId | undefined
  const selection: Array<() => void> = []
  const reveal = vi.fn()
  const watch: RevealWatch = {
    current: () => current,
    onSelection: (listener) => {
      selection.push(listener)
      return () => { selection.splice(selection.indexOf(listener), 1) }
    },
    follow: (sessionId, onChange) => {
      if (!live.has(sessionId)) return undefined
      const follow = new FakeFollow()
      follow.changes.push(onChange)
      follows.set(sessionId, follow)
      created.push(sessionId)
      return follow
    },
    reveal,
  }
  return {
    watch,
    reveal,
    follows,
    created,
    live,
    select: (id) => {
      current = id
      for (const listener of [...selection]) listener()
    },
  }
}

describe('revealOnProgress', () => {
  it('reveals at the first progress of a running Session, once', () => {
    const b = bench()
    const stop = revealOnProgress(b.watch)
    expect(b.follows.size).toBe(0)
    b.select(A)
    expect(b.reveal).not.toHaveBeenCalled()
    b.follows.get(A)!.start()
    expect(b.reveal).not.toHaveBeenCalled()
    b.follows.get(A)!.report()
    expect(b.reveal).toHaveBeenCalledOnce()
    // Later progress cannot reopen a panel the reader may have collapsed again.
    b.follows.get(A)!.report()
    expect(b.reveal).toHaveBeenCalledOnce()
    expect(b.follows.get(A)!.dispose).toHaveBeenCalled()
    stop()
  })

  it('keeps progress a Session already carried from opening the panel', () => {
    const b = bench()
    const stop = revealOnProgress(b.watch)
    b.select(A)
    const follow = b.follows.get(A)!
    // History, not live work: the checklist is already there when the Session
    // comes on screen, and the agent never runs.
    follow.report()
    expect(b.reveal).not.toHaveBeenCalled()
    stop()
  })

  it('reveals for a produced file that lands under a running agent', () => {
    const b = bench()
    const stop = revealOnProgress(b.watch)
    b.select(B)
    b.follows.get(B)!.start()
    b.follows.get(B)!.report()
    expect(b.reveal).toHaveBeenCalledOnce()
    stop()
  })

  it('follows a newly selected Session and releases the one before it', () => {
    const b = bench()
    const stop = revealOnProgress(b.watch)
    b.select(A)
    const first = b.follows.get(A)!
    first.start()
    first.report()
    expect(b.reveal).toHaveBeenCalledOnce()
    b.select(B)
    expect(first.dispose).toHaveBeenCalledOnce()
    b.follows.get(B)!.start()
    b.follows.get(B)!.report()
    expect(b.reveal).toHaveBeenCalledTimes(2)
    // A Session already revealed is not followed again when it comes back.
    b.select(A)
    expect(b.created).toEqual([A, B])
    expect(b.reveal).toHaveBeenCalledTimes(2)
    stop()
  })

  it('clears the selection without revealing and releases everything on dispose', () => {
    const b = bench()
    const stop = revealOnProgress(b.watch)
    b.select(A)
    const follow = b.follows.get(A)!
    b.select(undefined)
    expect(follow.dispose).toHaveBeenCalledOnce()
    expect(b.reveal).not.toHaveBeenCalled()
    b.select(B)
    stop()
    expect(b.follows.get(B)!.dispose).toHaveBeenCalledOnce()
    // The selection subscription went with the disposer: later changes are inert.
    b.select(A)
    expect(b.reveal).not.toHaveBeenCalled()
  })

  it('reveals progress that lands after the agent stopped, having latched the run', () => {
    const b = bench()
    const stop = revealOnProgress(b.watch)
    b.select(A)
    const follow = b.follows.get(A)!
    follow.start()
    // A fast turn: the agent is done before the file it wrote reaches the client.
    follow.stop()
    follow.report()
    expect(b.reveal).toHaveBeenCalledOnce()
    stop()
  })

  it('drops the latch when the selection moves away and back', () => {
    const b = bench()
    const stop = revealOnProgress(b.watch)
    b.select(A)
    b.follows.get(A)!.start()
    b.select(B)
    b.select(A)
    // Replayed history is not live work: nothing reveals on the way back in.
    b.follows.get(A)!.report()
    expect(b.reveal).not.toHaveBeenCalled()
    stop()
  })

  it('retries a Session whose client binding is not live yet', () => {
    const b = bench()
    b.live.delete(A)
    const stop = revealOnProgress(b.watch)
    b.select(A)
    expect(b.follows.size).toBe(0)
    b.live.add(A)
    // Another selection change arrives before the Session reports anything.
    b.select(A)
    b.follows.get(A)!.start()
    b.follows.get(A)!.report()
    expect(b.reveal).toHaveBeenCalledOnce()
    stop()
  })
})
