/**
 * Cross-process write lock for one memory scope. Two dsh processes whose
 * memory scopes share a storage medium must not rewrite one scope's record at
 * the same time: the medium holds one document per scope, and a write replaces
 * that whole document, so an interleaved pair of read-modify-write passes
 * leaves only the later process's view of the earlier one's changes.
 *
 * The arbiter is an exclusively created lock file (`open(..., 'wx')`, atomic
 * on every platform) in the configured directory, named after the scope's
 * path-safe storage key. The holder records its pid and instant in the file
 * for diagnostics. A held lock is polled for up to the configured wait and
 * then reported as `evolution/scope-locked`, so a contended write fails loud
 * instead of hanging. Release removes the lock file and runs on both the
 * success and the failure path of the write it guards.
 *
 * Nothing supervises a lock file's lifetime: a process that dies between
 * create and release leaves it behind, and a later writer for that scope then
 * fails after the wait with a message naming the file. Deleting that file is
 * the recovery. There is deliberately no staleness expiry, because breaking a
 * live holder's claim would admit exactly the second writer this lock exists
 * to exclude.
 * @module @deepseek-ai/dsh-evolution-memory/scope-lock
 */

import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** File-name suffix of one scope's lock file. */
const LOCK_SUFFIX = '.lock'

/** Owner-only lock file permissions, ignored by Windows. */
const LOCK_FILE_MODE = 0o600

/** Owner-only lock directory permissions, ignored by Windows. */
const LOCK_DIRECTORY_MODE = 0o700

/** Whether an open failure means the lock file already exists (EEXIST, or EPERM on some Windows setups). */
function isHeld(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EEXIST' || code === 'EPERM'
}

/**
 * Remove a lock file we created, tolerating one already gone. A link-shaped
 * path is unlinked, never followed: unlink removes the link itself.
 * @param path - lock file path.
 * @returns resolution once the path holds no file.
 */
async function discard(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
  }
}

/**
 * Describe the holder a lock file records, for the timeout message.
 * @param path - lock file path.
 * @returns `pid <pid> since <instant>`, or undefined when the file is missing
 * or carries no readable holder record.
 */
async function holderOf(path: string): Promise<string | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return undefined
    const { pid, at } = raw as { pid?: unknown; at?: unknown }
    if (typeof pid !== 'number' || typeof at !== 'string') return undefined
    return `pid ${pid} since ${at}`
  } catch {
    // Missing, unreadable, or foreign content: the message reports the path alone.
    return undefined
  }
}

/** How one scope's lock is acquired. */
export interface ScopeLockOptions {
  /** Directory holding one lock file per scope; created when missing. */
  readonly directory: string
  /** Longest an acquisition waits for a held lock before it fails. */
  readonly waitMs: number
}

/**
 * One held scope lock. Constructed only by {@link ScopeWriteLock.acquire};
 * the lock file's existence is the claim, so `release` removes it.
 */
export class ScopeWriteLock {
  private released = false

  private constructor(
    private readonly handle: FileHandle,
    private readonly path: string,
  ) {}

  /**
   * Claim one scope's write lock, retrying while another holder's file stands.
   * @param key - the scope's path-safe storage key.
   * @param options - lock directory and the longest wait before failing.
   * @returns the held lock.
   * @throws {RemoteError} `evolution/scope-locked` once the wait elapsed with
   * the lock still held.
   */
  static async acquire(key: string, options: ScopeLockOptions): Promise<ScopeWriteLock> {
    const path = join(options.directory, `${key}${LOCK_SUFFIX}`)
    await mkdir(options.directory, { recursive: true, mode: LOCK_DIRECTORY_MODE })
    // A cross-process lock is a durability guard, so its wait is measured in
    // real elapsed time through the real timer module, never through a clock
    // or timer a test may have replaced: a suite that fakes `Date` or
    // `setTimeout` must not be able to freeze a held lock forever. The wait is
    // therefore an attempt budget derived from the configured milliseconds.
    const poll = Math.max(1, Math.floor(options.waitMs / 64))
    let attemptsLeft = Math.max(0, Math.ceil(options.waitMs / poll))
    for (;;) {
      let handle: FileHandle
      try {
        handle = await open(path, 'wx', LOCK_FILE_MODE)
      } catch (error) {
        if (!isHeld(error)) throw error
        if (attemptsLeft <= 0) {
          const holder = await holderOf(path)
          const held = holder === undefined ? '' : `, held by ${holder}`
          throw new RemoteError(
            'evolution/scope-locked',
            `evolution memory scope '${key}' is locked by another process (${path}${held}); `
            + `waited ${options.waitMs}ms. Remove that file when no such process is running.`,
            { scope: key, path, waitedMs: options.waitMs },
          )
        }
        attemptsLeft -= 1
        await delay(poll)
        continue
      }
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8')
      } catch (error) {
        // The claim file exists but no holder record describes it: drop it
        // rather than leave a lock nobody can attribute.
        await handle.close()
        await discard(path)
        throw error
      }
      return new ScopeWriteLock(handle, path)
    }
  }

  /**
   * Drop the claim: remove the lock file and close its descriptor. Idempotent.
   * @returns resolution once the file is gone.
   */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    await discard(this.path)
    await this.handle.close()
  }
}
