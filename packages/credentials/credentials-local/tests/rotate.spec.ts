// The reference half's read-decide-replace: a rotation policy sees the value
// the reference currently resolves to — inside the write's exclusive window,
// and nowhere else — and what it returns is what the next resolve serves.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '../src/index.ts'

/** Credential documents are seeded owner-only, exactly as the provider creates them. */
function writeCredentials(file: string, text: string): Promise<void> {
  return writeFile(file, text, { mode: 0o600 })
}

const KEY = credentialRef('DSH_CRED_ROTATE')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credential-rotate-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: ConstructorParameters<typeof LocalCredentialProvider>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

function updates(ctx: Context): CredentialRef[] {
  const seen: CredentialRef[] = []
  ctx.on('credentials/reference-updated', (ref) => { seen.push(ref) })
  return seen
}

describe('reference rotation', () => {
  it('hands the decision the current value and serves its replacement on the next resolve', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.set(KEY, 'sk-old')
    const seen = updates(ctx)
    const decided: Array<string | undefined> = []

    await ctx.credentials.rotate(KEY, (current) => {
      decided.push(current)
      return 'sk-new'
    })

    expect(decided).toEqual(['sk-old'])
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'sk-new', source: 'file' })
    // One exactly-once notification for the one committed change.
    expect(seen).toEqual([KEY])
    expect(await readFile(path, 'utf8')).toBe('version: 1\nrefs:\n  DSH_CRED_ROTATE: sk-new\n')
  })

  it('stores a first value for an absent reference, whose decision sees undefined', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    const seen = updates(ctx)
    const decided: Array<string | undefined> = []

    await ctx.credentials.rotate(KEY, (current) => {
      decided.push(current)
      return 'sk-first'
    })

    expect(decided).toEqual([undefined])
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'sk-first', source: 'file' })
    expect(seen).toEqual([KEY])
  })

  it('rotates a reference a .env layer supplies, and the stored result outranks it afterwards', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = new Context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
      { source: 'process', values: {} },
      { source: 'project-env', path: '/work/.env', values: { DSH_CRED_ROTATE: 'from-project' } },
    ]))
    const fiber = ctx.plugin(LocalCredentialProvider, { path, watch: false })
    cleanups.push(async () => { await fiber.dispose() })
    await fiber

    // The effective value is what a rotation policy must see: storing its
    // replacement is what makes the store outrank the .env it replaced.
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'from-project', source: 'project-env' })
    const decided: Array<string | undefined> = []
    await ctx.credentials.rotate(KEY, (current) => {
      decided.push(current)
      return 'sk-rotated'
    })
    expect(decided).toEqual(['from-project'])
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'sk-rotated', source: 'file' })
  })

  it('refuses to rotate a reference the launching environment supplies', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_ROTATE: stored\n')
    const ctx = await boot({ path, watch: false })
    vi.stubEnv('DSH_CRED_ROTATE', 'from-shell')
    const seen = updates(ctx)

    // A rotation the read-only layer keeps ignoring is worse than a failed one,
    // so this fails on the same terms as set/unset rather than pretending.
    await expect(ctx.credentials.rotate(KEY, () => 'sk-new')).rejects.toThrow(/launching environment/)
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'from-shell', source: 'env' })
    expect(await readFile(path, 'utf8')).toBe('version: 1\nrefs:\n  DSH_CRED_ROTATE: stored\n')
    expect(seen).toEqual([])
  })

  it('rejects an empty decision result before anything is written', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    const seen = updates(ctx)

    await expect(ctx.credentials.rotate(KEY, () => '')).rejects.toThrow(/empty value/)
    expect(await ctx.credentials.resolve(KEY)).toBeUndefined()
    expect(seen).toEqual([])
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('commits nothing and notifies nobody when the decision throws', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.set(KEY, 'sk-old')
    const seen = updates(ctx)

    await expect(ctx.credentials.rotate(KEY, () => { throw new Error('key pool exhausted') }))
      .rejects.toThrow(/key pool exhausted/)
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'sk-old', source: 'file' })
    expect(seen).toEqual([])
    expect(await readFile(path, 'utf8')).toBe('version: 1\nrefs:\n  DSH_CRED_ROTATE: sk-old\n')
  })

  it('refuses a rotation after disposal', async () => {
    const dir = await tempDir()
    const ctx = new Context()
    const fiber = ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await fiber
    const service = ctx.credentials
    await fiber.dispose()

    await expect(service.rotate(KEY, () => 'late')).rejects.toThrow(/disposed/)
  })
})

describe('key-rotation hook composition', () => {
  // llm-fallback owns the hook contract — `KeyRotationHook` is route + failure
  // in, best-effort rotation out, and its recover() contains a throw with a
  // warning before the route switch proceeds. These specs pin the credential
  // side of that pair.
  type RotationHook = (route: { provider: string; model: string }, failure: { code: string }) => Promise<void> | void
  const route = { provider: 'other', model: 'other-model' }
  const failure = { code: 'AUTH' }

  it('rotates a reference through a registered hook, and the next resolve serves the new key', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.set(KEY, 'sk-old')
    const seen = updates(ctx)
    ctx.provide('llmFallbackKeyRotation', async () => {
      await ctx.credentials.rotate(KEY, current => `${String(current)}-rotated`)
    })

    await (ctx.get('llmFallbackKeyRotation') as RotationHook)(route, failure)

    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'sk-old-rotated', source: 'file' })
    expect(seen).toEqual([KEY])
  })

  it('leaves the store untouched when the policy throws, so the fallback can warn and switch', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.set(KEY, 'sk-old')
    const seen = updates(ctx)
    ctx.provide('llmFallbackKeyRotation', () => ctx.credentials.rotate(KEY, () => {
      throw new Error('key pool exhausted')
    }))

    // llm-fallback's recover() catches this rejection, warns, and still switches
    // route — the switch is only safe because the failed rotation left the
    // document and the update seam exactly as they were.
    await expect((ctx.get('llmFallbackKeyRotation') as RotationHook)(route, failure))
      .rejects.toThrow(/key pool exhausted/)
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'sk-old', source: 'file' })
    expect(seen).toEqual([])
  })
})
