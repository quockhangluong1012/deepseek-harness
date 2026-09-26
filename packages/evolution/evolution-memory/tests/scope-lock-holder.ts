/**
 * Child-process lock holder for the scope-lock spec: claims one scope's
 * cross-process write lock, reports the claim on stdout, and holds it until
 * its stdin closes. Spawned by `tests/scope-lock.spec.ts` through tsx; the
 * spec uses it to prove exclusion and release across two real processes.
 *
 * Usage: node --import tsx/esm tests/scope-lock-holder.ts <lockDirectory> <key>
 * @module @deepseek-ai/dsh-evolution-memory/tests/scope-lock-holder
 */

import { ScopeWriteLock } from '../src/scope-lock.ts'

const [directory, key] = process.argv.slice(2)
if (directory === undefined || key === undefined) {
  throw new Error('scope-lock-holder: <lockDirectory> <key> required')
}

const lock = await ScopeWriteLock.acquire(key, { directory, waitMs: 0 })
process.stdout.write(`locked ${process.pid}\n`)
process.stdin.on('end', () => {
  void lock.release().then(() => {
    process.exit(0)
  })
})
process.stdin.resume()
