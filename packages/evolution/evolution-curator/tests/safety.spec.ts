import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionCurator from '../src/index.ts'
import {
  appendLedger,
  curatorHome,
  listArchive,
  pathExists,
  pruneSnapshots,
  readBlob,
  readLedger,
  recordSha,
  resolveBackupDir,
  snapshotPass,
  textSha,
  writeBlob,
  writeTextBlob,
} from '../src/safety.ts'
import type { LedgerEntry } from '../src/safety.ts'
import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'

const DAY = 24 * 3600 * 1000

const savedHome = process.env['DSH_HOME']
const homeDirs: string[] = []

afterAll(async () => {
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  for (const dir of homeDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

afterEach(async () => {
  for (const dir of homeDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'curator-home-'))
  homeDirs.push(home)
  process.env['DSH_HOME'] = home
})

interface FakeSkill {
  name: string
  source: string
  path?: string
}

async function harness(options: {
  skills?: FakeSkill[]
  telemetry?: boolean
  curatorConfig?: Record<string, unknown>
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'curator-home-'))
  homeDirs.push(home)
  process.env['DSH_HOME'] = home
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const skills: FakeSkill[] = [...(options.skills ?? [])]
  ctx.provide('skills', {
    list: async () => skills.map(skill => ({ ...skill })),
  } as never)
  if (options.telemetry !== false) {
    const { default: EvolutionSkillTelemetry } = await import('@deepseek-ai/dsh-evolution-skill-telemetry')
    await ctx.plugin(EvolutionSkillTelemetry)
  }
  const fiber = await ctx.plugin(EvolutionCurator, options.curatorConfig ?? {})
  return { ctx, fiber, curator: ctx.evolutionCurator, telemetry: ctx.get('evolutionSkillTelemetry'), home, skills }
}

function fakeRecord(overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return {
    useCount: 1,
    viewCount: 0,
    patchCount: 0,
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: [],
    lastViewedAt: null,
    lastPatchedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    state: 'active',
    pinned: false,
    trust: 'trusted',
    trustFailures: 0,
    trustObservedSessions: [],
    trustAnchorSessionId: null,
    lastTrustFailure: null,
    revision: 0,
    contentSha: null,
    parentRevisionSha: null,
    createdBy: null,
    absorbedInto: null,
    archivedAt: null,
    ...overrides,
  }
}

async function skillDir(home: string, name: string, body = 'body words'): Promise<string> {
  const dir = join(home, 'skills', name)
  await mkdir(join(dir, 'references'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`)
  await writeFile(join(dir, 'references', 'note.md'), 'note\n')
  return dir
}

describe('evolution curator safety', () => {
  it('resolves backup directories only for eligible skills', () => {
    const summaries = [
      { name: 'local', source: 'user-dsh', path: join('skills', 'local', 'SKILL.md') },
      { name: 'boxed', source: 'bundled', path: join('skills', 'boxed', 'SKILL.md') },
      { name: 'virtual', source: 'custom' },
    ]
    expect(resolveBackupDir(summaries, 'local')).toBe(join('skills', 'local'))
    expect(resolveBackupDir(summaries, 'missing')).toBeUndefined()
    expect(resolveBackupDir(summaries, 'virtual')).toBeUndefined()
    expect(resolveBackupDir(summaries, 'boxed')).toBeUndefined()
  })

  it('hashes records and probes paths', async () => {
    const record = fakeRecord()
    expect(recordSha(record)).toBe(recordSha(fakeRecord()))
    expect(recordSha(record)).not.toBe(recordSha(fakeRecord({ useCount: 2 })))
    const dir = await mkdtemp(join(tmpdir(), 'curator-probe-'))
    homeDirs.push(dir)
    expect(await pathExists(dir)).toBe(true)
    expect(await pathExists(join(dir, 'absent'))).toBe(false)
  })

  it('snapshots records and directories with an unresolved list', async () => {
    const home = curatorHome()
    const dir = await skillDir(home, 'kept')
    const records = new Map([
      ['kept', { before: fakeRecord(), after: fakeRecord({ state: 'stale' }) }],
      ['gone', { before: fakeRecord(), after: fakeRecord({ state: 'stale' }) }],
    ])
    const { archive, unresolved } = await snapshotPass(home, 'pass-one', new Date().toISOString(), records, new Map([['kept', dir]]), 5)
    expect(archive.endsWith('.tar.gz')).toBe(true)
    expect(unresolved).toEqual(['gone'])
    const names = await listArchive(join(home, 'snapshots', archive))
    const text = names.join('\n')
    expect(text).toContain('manifest.json')
    expect(text).toContain('SKILL.md')
    expect(text).toContain('note.md')
    expect(await readBlob(home, recordSha(fakeRecord()))).toBe(JSON.stringify(fakeRecord()))
  })

  it('prunes snapshot tarballs to the newest keep', async () => {
    const home = curatorHome()
    await pruneSnapshots(join(home, 'no-such-home'), 2)
    await mkdir(join(home, 'snapshots'), { recursive: true })
    await writeBlob(home, recordSha(fakeRecord()), '{}')
    for (const name of ['pass-20200101000000-aaaaaaaa.tar.gz', 'pass-20210101000000-bbbbbbbb.tar.gz', 'pass-20220101000000-cccccccc.tar.gz', 'notes.txt']) {
      await writeFile(join(home, 'snapshots', name), 'x')
    }
    await pruneSnapshots(home, 2)
    const kept = await readdir(join(home, 'snapshots'))
    expect(kept.sort()).toEqual(['notes.txt', 'pass-20210101000000-bbbbbbbb.tar.gz', 'pass-20220101000000-cccccccc.tar.gz'])
    await pruneSnapshots(home, 5)
    expect(await readdir(join(home, 'snapshots'))).toHaveLength(3)
  })

  it('round-trips the ledger and fails loud on malformed lines', async () => {
    const home = curatorHome()
    expect(await readLedger(home)).toEqual([])
    const entry: LedgerEntry = {
      id: 'entry-one',
      at: new Date().toISOString(),
      actor: 'curator',
      action: 'pass',
      evidence: { passId: 'pass-one' },
      before: null,
      after: null,
    }
    await appendLedger(home, entry)
    await appendLedger(home, { ...entry, id: 'entry-two' })
    expect(await readLedger(home)).toHaveLength(2)
    await writeFile(join(home, 'ledger.jsonl'), 'not json\n', { flag: 'a' })
    await expect(readLedger(home)).rejects
      .toThrow(`evolution-curator: ledger "${join(home, 'ledger.jsonl')}" line 3 is not valid JSON`)
  })

  it('writes snapshots and ledger entries for real passes', async () => {
    const h = await harness()
    try {
      const dir = await skillDir(h.home, 'old')
      h.skills.push({ name: 'old', source: 'user-dsh', path: join(dir, 'SKILL.md') })
      await h.telemetry?.markUsed('old')
      const report = await h.curator.run({ now: Date.now() + 45 * DAY })
      expect(report.transitions).toHaveLength(1)
      if (report.passId === null || report.snapshot === null) throw new Error('expected a pass snapshot')
      expect(report.snapshot.endsWith('.tar.gz')).toBe(true)
      expect(await pathExists(join(h.home, 'evolution-curator', 'snapshots', report.snapshot))).toBe(true)
      const summaries = await h.curator.passes()
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toMatchObject({ passId: report.passId, snapshot: report.snapshot, transitions: 1 })
      const names = await listArchive(join(h.home, 'evolution-curator', 'snapshots', report.snapshot))
      expect(names.join('\n')).toContain('SKILL.md')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rolls back a whole pass and keeps the rollback reversible', async () => {
    const h = await harness()
    try {
      await h.telemetry?.markUsed('old')
      const now = Date.now()
      await h.curator.run({ now: now + 45 * DAY })
      const report = await h.curator.run({ now: now + 100 * DAY })
      if (report.passId === null) throw new Error('expected a pass snapshot')
      expect(h.telemetry?.read('old')).toMatchObject({ state: 'archived' })
      const rolled = await h.curator.rollbackPass(report.passId)
      expect(rolled.label).toContain(report.passId)
      expect(rolled.restored).toHaveLength(1)
      expect(rolled.restored[0]).toMatchObject({ name: 'old', from: 'archived', to: 'stale' })
      expect(rolled.preRollback.length).toBeGreaterThan(0)
      expect(h.telemetry?.read('old')).toMatchObject({ state: 'stale' })
      const entries = await readLedger(curatorHome())
      expect(entries.filter(entry => entry.action === 'rollback')).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rolls back one entry and restamps archive entries', async () => {
    const h = await harness()
    try {
      await h.telemetry?.markUsed('first')
      await h.telemetry?.markUsed('second')
      const now = Date.now()
      await h.curator.run({ now: now + 45 * DAY })
      await h.curator.run({ now: now + 100 * DAY })
      const entries = await readLedger(curatorHome())
      const targets = entries.filter(entry => entry.action === 'transition' && entry.evidence['name'] === 'first')
      const target = targets[targets.length - 1]
      if (target === undefined) throw new Error('expected a transition entry')
      const rolled = await h.curator.rollbackEntry(target.id)
      expect(rolled.restored).toHaveLength(1)
      expect(rolled.restored[0]).toMatchObject({ name: 'first', to: 'stale' })
      expect(h.telemetry?.read('first')).toMatchObject({ state: 'stale' })
      expect(h.telemetry?.read('second')).toMatchObject({ state: 'archived' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('fails closed on unknown ids, missing blobs, and untracked skills', async () => {
    const h = await harness()
    try {
      await expect(h.curator.rollbackPass('no-such-pass')).rejects.toThrow("unknown pass 'no-such-pass'")
      await expect(h.curator.rollbackEntry('no-such-entry')).rejects.toThrow("unknown ledger entry 'no-such-entry'")
      await h.telemetry?.markUsed('old')
      const now = Date.now()
      await h.curator.run({ now: now + 45 * DAY })
      const report = await h.curator.run({ now: now + 100 * DAY })
      if (report.passId === null || report.snapshot === null) throw new Error('expected a pass snapshot')
      const entries = await readLedger(curatorHome())
      const transition = entries.find(entry => entry.action === 'transition' && entry.evidence['passId'] === report.passId)
      if (transition === undefined || transition.before === null) throw new Error('expected a before blob')
      await rm(join(curatorHome(), 'blobs', `${transition.before}.json`))
      await expect(h.curator.rollbackPass(report.passId)).rejects.toThrow('missing the before blob')
      expect(h.telemetry?.read('old')).toMatchObject({ state: 'archived' })
      const raw: LedgerEntry = {
        id: 'ghost-entry',
        at: new Date().toISOString(),
        actor: 'curator',
        action: 'transition',
        evidence: { passId: report.passId, name: 'ghost', reason: 'stale', snapshot: report.snapshot },
        before: null,
        after: null,
      }
      const record = fakeRecord()
      await writeBlob(curatorHome(), recordSha(record), JSON.stringify(record))
      await appendLedger(curatorHome(), { ...raw, before: recordSha(record) })
      await expect(h.curator.rollbackEntry('ghost-entry')).rejects.toThrow("untracked skill 'ghost'")
      await appendLedger(curatorHome(), { ...raw, id: 'bare-entry', evidence: { passId: report.passId, name: 'old', reason: 'stale', snapshot: report.snapshot } })
      await expect(h.curator.rollbackEntry('bare-entry')).rejects.toThrow('holds no before state')
      await appendLedger(curatorHome(), { ...raw, id: 'nameless-entry', evidence: {} })
      await expect(h.curator.rollbackEntry('nameless-entry')).rejects.toThrow("missing evidence 'name'")
    } finally {
      await h.fiber.dispose()
    }
  })

  it('adopts agent-created skills through the ledger', async () => {
    const h = await harness()
    try {
      await h.telemetry?.markAgentCreated('writer')
      const adopted = await h.curator.adopt('writer')
      expect(adopted).toMatchObject({ createdBy: 'foreground' })
      const entries = await readLedger(curatorHome())
      const logged = entries.filter(entry => entry.action === 'adopt')
      expect(logged).toHaveLength(1)
      expect(logged[0]).toMatchObject({ actor: 'operator', evidence: { name: 'writer' } })
      await expect(h.curator.adopt('writer')).rejects.toThrow('without model authorship')
      await expect(h.curator.adopt('ghost')).rejects.toThrow("has no record for 'ghost'")
    } finally {
      await h.fiber.dispose()
    }
  })

  it('refuses adoption without the telemetry store', async () => {
    const h = await harness({ telemetry: false })
    try {
      await expect(h.curator.adopt('writer')).rejects.toThrow('requires the telemetry store')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('purges archived skills past their TTL and skips the rest', async () => {
    const h = await harness({ curatorConfig: { archiveTtlDays: 30 } })
    try {
      const oldDir = await skillDir(h.home, 'old')
      h.skills.push({ name: 'old', source: 'user-dsh', path: join(oldDir, 'SKILL.md') })
      const pinnedDir = await skillDir(h.home, 'pinned')
      h.skills.push({ name: 'pinned', source: 'user-dsh', path: join(pinnedDir, 'SKILL.md') })
      await h.telemetry?.markUsed('old')
      await h.telemetry?.setState('old', 'archived')
      await h.telemetry?.markUsed('pinned')
      await h.telemetry?.setState('pinned', 'archived')
      await h.telemetry?.setPinned('pinned', true)
      await h.telemetry?.markUsed('live')
      await h.telemetry?.markUsed('stray')
      await h.telemetry?.setState('stray', 'archived')
      const report = await h.curator.purge({ now: Date.now() + 45 * DAY })
      expect(report.dryRun).toBe(false)
      expect(report.purged).toHaveLength(2)
      const byName = new Map(report.purged.map(purged => [purged.name, purged]))
      expect(byName.get('old')).toMatchObject({ dir: oldDir })
      expect(byName.get('stray')).toMatchObject({ dir: null })
      expect(report.skippedPinned).toBe(1)
      expect(await pathExists(oldDir)).toBe(false)
      expect(await pathExists(pinnedDir)).toBe(true)
      expect(h.telemetry?.read('old')).toBeUndefined()
      expect(h.telemetry?.read('pinned')).toMatchObject({ state: 'archived' })
      expect(h.telemetry?.read('live')).toMatchObject({ state: 'active' })
      const entries = await readLedger(curatorHome())
      expect(entries.filter(entry => entry.action === 'purge')).toHaveLength(2)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('keeps young skills and previews purges without writing', async () => {
    const h = await harness({ curatorConfig: { archiveTtlDays: 30 } })
    try {
      await h.telemetry?.markUsed('young')
      await h.telemetry?.setState('young', 'archived')
      expect((await h.curator.purge()).purged).toEqual([])
      const preview = await h.curator.purge({ now: Date.now() + 45 * DAY, dryRun: true })
      expect(preview.dryRun).toBe(true)
      expect(preview.purged).toHaveLength(1)
      expect(preview.purged[0]).toMatchObject({ name: 'young', dir: null })
      expect(h.telemetry?.read('young')).toMatchObject({ state: 'archived' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('never purges on a zero TTL or without the telemetry store', async () => {
    const h = await harness()
    try {
      await h.telemetry?.markUsed('old')
      await h.telemetry?.setState('old', 'archived')
      expect((await h.curator.purge({ now: Date.now() + 365 * DAY })).purged).toEqual([])
      expect(h.telemetry?.read('old')).toMatchObject({ state: 'archived' })
    } finally {
      await h.fiber.dispose()
    }
    const bare = await harness({ telemetry: false })
    try {
      expect(await bare.curator.purge()).toMatchObject({ purged: [] })
    } finally {
      await bare.fiber.dispose()
    }
  })

  it('refuses rollback without the telemetry store', async () => {
    const h = await harness({ telemetry: false })
    try {
      const record = fakeRecord()
      const home = curatorHome()
      await writeBlob(home, recordSha(record), JSON.stringify(record))
      await appendLedger(home, {
        id: 'pass-entry',
        at: new Date().toISOString(),
        actor: 'curator',
        action: 'pass',
        evidence: { passId: 'pass-one', snapshot: 'pass-x.tar.gz', names: 'old', unresolved: '' },
        before: null,
        after: null,
      })
      await appendLedger(home, {
        id: 'transition-entry',
        at: new Date().toISOString(),
        actor: 'curator',
        action: 'transition',
        evidence: { passId: 'pass-one', name: 'old', reason: 'stale', snapshot: 'pass-x.tar.gz' },
        before: recordSha(record),
        after: recordSha(record),
      })
      await expect(h.curator.rollbackPass('pass-one')).rejects.toThrow('requires the telemetry store')
      expect(await h.curator.passes()).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('refuses to restore bodies without the telemetry store', async () => {
    const h = await harness({ telemetry: false })
    try {
      const home = curatorHome()
      await appendLedger(home, {
        id: 'pass-entry',
        at: new Date().toISOString(),
        actor: 'curator',
        action: 'pass',
        evidence: { passId: 'pass-patch', snapshot: 'pass-x.tar.gz', names: 'old', unresolved: '' },
        before: null,
        after: null,
      })
      await appendLedger(home, {
        id: 'patch-entry',
        at: new Date().toISOString(),
        actor: 'curator',
        action: 'patch',
        evidence: { passId: 'pass-patch', name: 'old', dir: '/skills/old', file: join('/skills/old', 'SKILL.md') },
        before: 'body-sha',
        after: 'body-sha',
      })
      await expect(h.curator.rollbackPass('pass-patch')).rejects.toThrow('requires the telemetry store')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('refuses to restore a body for a skill that is no longer tracked', async () => {
    const h = await harness()
    try {
      const home = curatorHome()
      const body = 'the body its patch replaced\n'
      await writeTextBlob(home, textSha(body), body)
      await h.telemetry?.markUsed('old')
      await appendLedger(home, {
        id: 'pass-entry',
        at: new Date().toISOString(),
        actor: 'curator',
        action: 'pass',
        evidence: { passId: 'pass-patch', snapshot: 'pass-x.tar.gz', names: 'old', unresolved: '' },
        before: null,
        after: null,
      })
      await appendLedger(home, {
        id: 'patch-entry',
        at: new Date().toISOString(),
        actor: 'curator',
        action: 'patch',
        evidence: { passId: 'pass-patch', name: 'old', dir: join(home, 'skills', 'old'), file: join(home, 'skills', 'old', 'SKILL.md') },
        before: textSha(body),
        after: 'ignored',
      })
      await h.telemetry?.drop('old')
      await expect(h.curator.rollbackPass('pass-patch')).rejects.toThrow('cannot restore untracked skill')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('reads stored blobs and lists no passes on a fresh home', async () => {
    const h = await harness()
    try {
      expect(await h.curator.passes()).toEqual([])
      const record = fakeRecord()
      await writeBlob(curatorHome(), recordSha(record), JSON.stringify(record))
      expect(await readBlob(curatorHome(), recordSha(record))).toBe(JSON.stringify(record))
    } finally {
      await h.fiber.dispose()
    }
  })
})
