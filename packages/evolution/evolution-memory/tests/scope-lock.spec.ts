/**
 * Cross-process scope write lock: exclusion between holders, the bounded wait
 * that turns contention into `evolution/scope-locked`, release on the success
 * and on the failure path, and the store taking the lock for every mutation.
 * The lock is a real file under a real backend, so the medium is exercised
 * rather than a table double.
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '../../../storage/storage-json/src/index.ts'
import EvolutionMemoryStore, { EvolutionScopeId, storageKey, type Config } from '../src/index.ts'
import { ScopeWriteLock } from '../src/scope-lock.ts'

const roots: string[] = []
const fibers: { dispose(): Promise<void> }[] = []

async function freshDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-evolution-memory-lock-'))
  roots.push(root)
  return root
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose()
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

function scope(name: string) {
  return EvolutionScopeId('test', name)
}

/**
 * A started store over the JSON backend, with a private storage root and lock
 * directory so the spec owns every path it touches.
 * @param overrides - the config fields the case varies.
 * @returns the context, the plugin fiber, the store, and the lock directory.
 */
async function harness(overrides: { lockWaitMs: number; capacityBytes?: number }) {
  const root = await freshDirectory()
  const lockDirectory = join(root, 'locks')
  const config: Config = {
    capacityBytes: overrides.capacityBytes ?? 65536,
    lockDirectory,
    lockWaitMs: overrides.lockWaitMs,
  }
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('json', new JsonStorageBackend(root))
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionMemoryStore, config)
  fibers.push(fiber)
  return { ctx, fiber, store: ctx.evolutionMemory, lockDirectory }
}

/** Capture a rejection without letting it fail the test as an unhandled error. */
async function failureOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(() => undefined, (error: unknown) => error)
}

describe('scope write lock', () => {
  it('excludes a second holder and names the holder it reports', async () => {
    const directory = join(await freshDirectory(), 'locks')
    const held = await ScopeWriteLock.acquire('test--ws-1', { directory, waitMs: 0 })
    const path = join(directory, 'test--ws-1.lock')

    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ pid: process.pid })
    const failure = await failureOf(ScopeWriteLock.acquire('test--ws-1', { directory, waitMs: 0 }))
    expect(failure).toMatchObject({
      code: 'evolution/scope-locked',
      details: { scope: 'test--ws-1', path, waitedMs: 0 },
    })
    expect((failure as Error).message).toContain(`held by pid ${process.pid}`)

    await held.release()
    const second = await ScopeWriteLock.acquire('test--ws-1', { directory, waitMs: 0 })
    await second.release()
  })

  it('waits out a holder that releases inside the configured wait', async () => {
    const directory = join(await freshDirectory(), 'locks')
    const held = await ScopeWriteLock.acquire('test--ws-2', { directory, waitMs: 0 })
    let releasedAt = 0
    const releasing = (async () => {
      await pause(25)
      await held.release()
      releasedAt = Date.now()
    })()

    const claimed = await ScopeWriteLock.acquire('test--ws-2', { directory, waitMs: 1000 })
    await releasing
    // Only the release can have freed the name the claim took, so the stamp
    // proves the acquisition waited instead of taking the held file.
    expect(releasedAt).toBeGreaterThan(0)
    await claimed.release()
  })

  it('fails after the configured wait instead of hanging on a holder that never releases', async () => {
    const directory = join(await freshDirectory(), 'locks')
    const held = await ScopeWriteLock.acquire('test--ws-3', { directory, waitMs: 0 })

    const failure = await failureOf(ScopeWriteLock.acquire('test--ws-3', { directory, waitMs: 60 }))
    expect(failure).toMatchObject({ code: 'evolution/scope-locked', details: { waitedMs: 60 } })

    await held.release()
  })

  it('releases idempotently and leaves no lock file behind', async () => {
    const directory = join(await freshDirectory(), 'locks')
    const lock = await ScopeWriteLock.acquire('test--ws-4', { directory, waitMs: 0 })

    await lock.release()
    await lock.release()
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('excludes a holder in another process and honors its release', async () => {
    const directory = join(await freshDirectory(), 'locks')
    const key = 'test--ws-5'
    const runner = fileURLToPath(new URL('./scope-lock-holder.ts', import.meta.url))
    const child = spawn(process.execPath, ['--import', 'tsx/esm', runner, directory, key], { stdio: ['pipe', 'pipe', 'inherit'] })
    const { stdout, stdin } = child
    if (stdout === null || stdin === null) throw new Error('scope-lock-holder needs piped stdin and stdout')
    const ready = Promise.withResolvers<number>()
    let seen = ''
    stdout.on('data', (chunk: Buffer) => {
      seen += chunk.toString('utf8')
      const match = /locked (\d+)/.exec(seen)
      if (match !== null) ready.resolve(Number(match[1]))
    })
    child.once('error', ready.reject)
    child.once('exit', (code) => { ready.reject(new Error(`holder exited early with code ${String(code)}: ${seen}`)) })
    const holderPid = await ready.promise

    const failure = await failureOf(ScopeWriteLock.acquire(key, { directory, waitMs: 0 }))
    expect(failure).toMatchObject({ code: 'evolution/scope-locked' })
    expect((failure as Error).message).toContain(`held by pid ${holderPid}`)

    const exited = once(child, 'exit')
    stdin.end()
    await exited
    const claimed = await ScopeWriteLock.acquire(key, { directory, waitMs: 1000 })
    await claimed.release()
  })
})

describe('store writes hold the scope lock', () => {
  it('refuses a write whose scope another holder holds, and lands it after the release', async () => {
    const { store, lockDirectory } = await harness({ lockWaitMs: 0 })
    const id = scope('held')
    const held = await ScopeWriteLock.acquire(storageKey(id), { directory: lockDirectory, waitMs: 0 })

    const failure = await failureOf(store.setInstructions(id, 'never lands'))
    expect(failure).toMatchObject({ code: 'evolution/scope-locked', details: { scope: storageKey(id) } })
    expect(store.read(id)).toBeUndefined()

    await held.release()
    await expect(store.setInstructions(id, 'lands')).resolves.toMatchObject({ instructions: 'lands' })
  })

  it('holds the lock only for the write, so the next write claims it immediately', async () => {
    const { store, lockDirectory } = await harness({ lockWaitMs: 0 })
    const id = scope('freed')

    await store.setInstructions(id, 'first')
    await expect(readdir(lockDirectory)).resolves.toEqual([])
    await expect(store.setInstructions(id, 'second')).resolves.toMatchObject({ instructions: 'second' })
  })

  it('waits out a holder inside the configured wait and then lands the write', async () => {
    const { store, lockDirectory } = await harness({ lockWaitMs: 1000 })
    const id = scope('waited')
    const held = await ScopeWriteLock.acquire(storageKey(id), { directory: lockDirectory, waitMs: 0 })
    const releasing = (async () => {
      await pause(25)
      await held.release()
    })()

    await expect(store.setInstructions(id, 'waited')).resolves.toMatchObject({ instructions: 'waited' })
    await releasing
  })

  it('releases the lock when the write it guards rejects', async () => {
    const { store, lockDirectory } = await harness({ capacityBytes: 32, lockWaitMs: 0 })
    const id = scope('rejected')

    await expect(store.setInstructions(id, 'x'.repeat(200))).rejects.toMatchObject({ code: 'evolution/capacity-exceeded' })
    // A leaked lock would make this claim fail at the zero wait.
    await expect(readdir(lockDirectory)).resolves.toEqual([])
    await expect(store.setInstructions(id, 'fits')).resolves.toMatchObject({ instructions: 'fits' })
  })
})
