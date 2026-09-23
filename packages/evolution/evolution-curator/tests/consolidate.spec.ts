import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import EvolutionSkillTelemetry from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionCurator, { resolveConfig } from '../src/index.ts'
import { applyConsolidation, frameConsolidationInput } from '../src/consolidate.ts'
import { appendLedger, curatorHome, pathExists, readLedger, readTextBlob, textSha } from '../src/safety.ts'
import type { LedgerEntry } from '../src/safety.ts'

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

/** One scripted tool call. */
function call(name: string, args: unknown): { name: string; arguments: string } {
  return { name, arguments: JSON.stringify(args) }
}

/** A tool-call turn: one assembled block per call, then a stop. */
function toolTurn(calls: readonly { name: string; arguments: string }[]): StreamChunk[] {
  return [
    ...calls.map((_, index) => ({ type: 'block-start', index, blockType: 'tool-call' })),
    ...calls.map((entry, index) => ({
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: `call-${index}`, name: entry.name, arguments: entry.arguments },
    })),
    { type: 'finish', reason: { kind: 'stop' } },
  ] as StreamChunk[]
}

/** A text-only turn, which ends the loop. */
function textTurn(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** The tool results one request carried, in order. */
function toolResults(request: GenerateOptions | undefined): string[] {
  const texts: string[] = []
  for (const message of request?.messages ?? []) {
    if (message.role !== 'tool') continue
    const first = message.content[0]
    texts.push(first?.type === 'text' ? first.text : '')
  }
  return texts
}

interface FakeSkill {
  name: string
  source: string
  description?: string
  path?: string
}

async function harness(options: {
  skills?: FakeSkill[]
  curatorConfig?: Record<string, unknown>
  telemetry?: boolean
  llm?: boolean
  respond?: (request: GenerateOptions, index: number) => Promise<StreamChunk[]>
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'curator-consolidate-'))
  homeDirs.push(home)
  process.env['DSH_HOME'] = home
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const skills: FakeSkill[] = [...(options.skills ?? [])]
  const state = { failList: false }
  ctx.provide('skills', {
    list: async () => {
      if (state.failList) throw new Error('catalog unavailable')
      return skills.map(skill => ({ ...skill }))
    },
  } as never)
  if (options.telemetry !== false) {
    await ctx.plugin(EvolutionSkillTelemetry)
  }
  const calls: GenerateOptions[] = []
  if (options.llm !== false) {
    ctx.provide('llm', {
      stream: (request: GenerateOptions) => {
        const index = calls.length
        calls.push(request)
        return (async function* () {
          yield* await (options.respond?.(request, index) ?? Promise.resolve(textTurn('done')))
        })()
      },
    } as never)
  }
  const fiber = await ctx.plugin(EvolutionCurator, options.curatorConfig ?? {})
  return { ctx, fiber, curator: ctx.evolutionCurator, telemetry: ctx.get('evolutionSkillTelemetry'), home, skills, calls, state }
}

/** Create one skill package on disk and return its catalog summary. */
async function packageSkill(
  home: string,
  name: string,
  options: { full?: boolean } = {},
): Promise<{ name: string; source: string; path: string }> {
  const dir = join(home, 'skills', name)
  await mkdir(join(dir, 'references'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nbody of ${name}\n`)
  await writeFile(join(dir, 'references', 'note.md'), `See \${DSH_SKILL_DIR}/references/note.md for ${name}.\n`)
  if (options.full === true) {
    await mkdir(join(dir, 'scripts'), { recursive: true })
    await writeFile(join(dir, 'scripts', 'run.sh'), 'echo ${DSH_SKILL_DIR}/scripts/run.sh\n')
    await writeFile(join(dir, 'references', 'image.png'), 'binary ${DSH_SKILL_DIR}/references/image.png\n')
  }
  return { name, source: 'user-dsh', path: join(dir, 'SKILL.md') }
}

const CONSOLIDATING = { consolidate: true, provider: 'aux', model: 'cheap' }

describe('evolution curator consolidation', () => {
  it('requires a complete route when consolidation is opted in', () => {
    expect(() => resolveConfig({ consolidate: true })).toThrow('requires both provider and model')
    expect(() => resolveConfig({ provider: 'aux' })).toThrow('provider and model must be set together')
    expect(() => resolveConfig({ model: 'cheap' })).toThrow('provider and model must be set together')
    expect(resolveConfig(CONSOLIDATING)).toMatchObject({ consolidate: true, provider: 'aux', model: 'cheap' })
  })

  it('frames the survey within its byte budget', () => {
    const candidate = {
      name: 'leaf',
      description: 'leaf skill',
      source: 'user-dsh',
      state: 'active' as const,
      idleDays: 0,
      useCount: 0,
      viewCount: 0,
      patchCount: 0,
      lastUsedAt: null,
      failures: [],
      trust: 'provisional' as const,
      revision: 2,
      contentSha: 'sha-2',
      lastTrustFailure: null,
    }
    const roomy = frameConsolidationInput([candidate], 65536)
    expect(roomy.truncated).toBe(false)
    expect(roomy.text).toContain('"leaf"')
    expect(roomy.inputBytes).toBe(Buffer.byteLength(roomy.text))
    // The frame carries how strong the skill's evidence is, so the verdict is
    // driven by graded signals rather than a raw error string.
    expect(roomy.text).toContain('"trust":"provisional"')
    expect(roomy.text).toContain('"revision":2')
    // Recorded failures ride in the survey, so the verdict reflects what broke
    // in the sessions that used the skill rather than its author's intent.
    const evidenced = frameConsolidationInput([{
      ...candidate,
      failures: [{
        tool: 'bash',
        message: 'command not found',
        count: 3,
        sessions: 2,
        firstAt: 't0',
        lastAt: 't1',
        actionability: 'trigger_review' as const,
        evidenceStatus: 'complete' as const,
        mergeKey: 'bash\u0000command not found',
      }],
    }], 65536)
    expect(evidenced.text).toContain('command not found')
    expect(evidenced.text).toContain('"sessions":2')
    expect(evidenced.text).toContain('"actionability":"trigger_review"')
    const tight = frameConsolidationInput([candidate, { ...candidate, name: 'other' }], 100)
    expect(tight.truncated).toBe(true)
    expect(tight.text).not.toContain('"leaf"')
  })

  it('consolidates nothing while the option is off', async () => {
    const h = await harness()
    try {
      await h.telemetry?.markAgentCreated('leaf')
      expect(await h.curator.consolidate()).toBeUndefined()
      expect(h.calls).toHaveLength(0)
      expect(await readLedger(curatorHome())).toEqual([])
      expect((await h.curator.run()).consolidation).toBeUndefined()
    } finally {
      await h.fiber.dispose()
    }
  })

  it('refuses consolidation without the llm seam or the telemetry store', async () => {
    const noLlm = await harness({ curatorConfig: CONSOLIDATING, llm: false })
    try {
      await noLlm.telemetry?.markAgentCreated('leaf')
      await expect(noLlm.curator.consolidate()).rejects.toThrow('requires the llm seam, the telemetry store, and a provider/model route')
    } finally {
      await noLlm.fiber.dispose()
    }
    const noTelemetry = await harness({ curatorConfig: CONSOLIDATING, telemetry: false })
    try {
      await expect(noTelemetry.curator.consolidate()).rejects.toThrow('requires the llm seam, the telemetry store, and a provider/model route')
    } finally {
      await noTelemetry.fiber.dispose()
    }
  })

  it('returns undefined when no candidate awaits a verdict', async () => {
    const h = await harness({ curatorConfig: CONSOLIDATING })
    try {
      await h.telemetry?.markUsed('foreground')
      expect(await h.curator.consolidate()).toBeUndefined()
      expect(h.calls).toHaveLength(0)
      expect(await readLedger(curatorHome())).toEqual([])
      expect((await h.curator.run()).consolidation).toBeUndefined()
      expect(h.calls).toHaveLength(0)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('writes the cost row before the fork and applies a keep verdict', async () => {
    const atFork: { ledger: LedgerEntry[]; input: string }[] = []
    const h = await harness({
      curatorConfig: CONSOLIDATING,
      respond: async (request, index) => {
        atFork.push({ ledger: await readLedger(curatorHome()), input: request.messages[0]?.content[0]?.type === 'text' ? request.messages[0].content[0].text : '' })
        return index === 0 ? toolTurn([call('skill_apply', { name: 'leaf', action: 'keep' })]) : textTurn('done')
      },
    })
    try {
      const leaf = await packageSkill(h.home, 'leaf')
      h.skills.push(leaf)
      await h.telemetry?.markAgentCreated('leaf')
      const report = await h.curator.consolidate({ now: Date.parse('2026-06-02T00:00:00.000Z') })
      expect(report).toMatchObject({
        at: '2026-06-02T00:00:00.000Z',
        passId: null,
        snapshot: null,
        steps: 2,
        skipped: 0,
        verdicts: [{ name: 'leaf', action: 'keep' }],
        cost: { maxOutputTokens: 2048, provider: 'aux', model: 'cheap', truncated: false },
      })
      expect(report?.cost.inputBytes).toBeGreaterThanOrEqual(1)
      const forked = atFork[0]
      expect(forked?.ledger.map(entry => entry.action)).toEqual(['cost'])
      expect(forked?.ledger[0]?.evidence).toMatchObject({
        inputBytes: String(report?.cost.inputBytes),
        maxOutputTokens: '2048',
        provider: 'aux',
        model: 'cheap',
        truncated: 'false',
      })
      expect(forked?.ledger[0]?.evidence['passId']).toBeTypeOf('string')
      expect(forked?.input).toContain('"leaf"')
      expect(h.calls[0]?.provider).toBe('aux')
      expect(h.calls[0]?.model).toBe('cheap')
      expect(h.calls[0]?.maxTokens).toBe(2048)
      expect(h.calls[0]?.temperature).toBe(0)
      expect(h.calls[0]?.purpose).toBe('evolution-review')
      expect(h.calls[0]?.tools?.map(tool => tool.name)).toEqual(['skill_view', 'skill_apply'])
      expect(await readFile(join(h.home, 'skills', 'leaf', 'SKILL.md'), 'utf8')).toContain('body of leaf')
      expect(await readLedger(curatorHome())).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rewrites a body on a patch verdict and skips patches that would break the skill', async () => {
    const rewritten = '---\nname: leaf\ndescription: leaf skill\n---\nrewritten by the umbrella pass\n'
    const h = await harness({
      curatorConfig: CONSOLIDATING,
      respond: async (_request, index) => (index === 0
        ? toolTurn([
          call('skill_apply', { name: 'leaf', action: 'patch', body: rewritten }),
          call('skill_apply', { name: 'leaf', action: 'patch', body: 'rewritten without its frontmatter\n' }),
          call('skill_apply', { name: 'bare', action: 'patch' }),
        ])
        : textTurn('done')),
    })
    try {
      h.skills.push(await packageSkill(h.home, 'leaf'))
      h.skills.push(await packageSkill(h.home, 'bare'))
      await h.telemetry?.markAgentCreated('leaf')
      await h.telemetry?.markAgentCreated('bare')
      const report = await h.curator.consolidate()
      // The body-less verdict and the body that drops frontmatter are both refused.
      expect(report?.skipped).toBe(2)
      expect(report?.refusals).toEqual([
        { name: 'leaf', level: 0, reason: 'schema: body has no frontmatter' },
      ])
      expect(await readFile(join(h.home, 'skills', 'leaf', 'SKILL.md'), 'utf8')).toBe(rewritten)
      const entries = await readLedger(curatorHome())
      const patches = entries.filter(entry => entry.action === 'patch')
      expect(patches).toHaveLength(1)
      expect(patches[0]?.evidence).toMatchObject({ name: 'leaf', dir: join(h.home, 'skills', 'leaf') })
      expect(h.telemetry?.read('leaf')).toMatchObject({ state: 'active' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('re-homes a full package under its umbrella and rewrites its references', async () => {
    const h = await harness({
      curatorConfig: CONSOLIDATING,
      respond: async (_request, index) => (index === 0
        ? toolTurn([call('skill_apply', { name: 'leaf', action: 'consolidate', into: 'root' })])
        : textTurn('done')),
    })
    try {
      const leaf = await packageSkill(h.home, 'leaf', { full: true })
      const root = await packageSkill(h.home, 'root')
      h.skills.push(leaf, root)
      await h.telemetry?.markAgentCreated('leaf')
      const report = await h.curator.consolidate()
      const rootDir = dirname(root.path)
      expect(report?.passId).toBeTypeOf('string')
      expect(report?.snapshot?.endsWith('.tar.gz')).toBe(true)
      expect(await pathExists(join(h.home, 'skills', 'leaf'))).toBe(false)
      expect(await readFile(join(rootDir, 'leaf', 'references', 'note.md'), 'utf8'))
        .toBe('See ${DSH_SKILL_DIR}/leaf/references/note.md for leaf.\n')
      expect(await readFile(join(rootDir, 'leaf', 'scripts', 'run.sh'), 'utf8'))
        .toBe('echo ${DSH_SKILL_DIR}/leaf/scripts/run.sh\n')
      expect(await readFile(join(rootDir, 'leaf', 'references', 'image.png'), 'utf8'))
        .toBe('binary ${DSH_SKILL_DIR}/references/image.png\n')
      expect(await readFile(root.path, 'utf8')).toContain('## Merged: leaf')
      expect(h.telemetry?.read('leaf')).toMatchObject({ state: 'archived', absorbedInto: 'root' })
      const moves = (await readLedger(curatorHome())).filter(entry => entry.action === 'move')
      expect(moves).toHaveLength(1)
      expect(moves[0]?.evidence).toMatchObject({ name: 'leaf', from: join(h.home, 'skills', 'leaf'), to: join(rootDir, 'leaf') })
      const passes = await h.curator.passes()
      expect(passes).toHaveLength(1)
      expect(passes[0]).toMatchObject({ passId: report?.passId, transitions: 1 })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('keeps a full package standalone when no umbrella can receive it', async () => {
    const h = await harness({
      curatorConfig: CONSOLIDATING,
      respond: async (_request, index) => (index === 0
        ? toolTurn([
          call('skill_apply', { name: 'leaf', action: 'consolidate', into: 'ghost' }),
          call('skill_apply', { name: 'bare', action: 'consolidate', into: 'headless' }),
          call('skill_apply', { name: 'taken', action: 'consolidate', into: 'root' }),
          call('skill_apply', { name: 'loose', action: 'consolidate' }),
        ])
        : textTurn('done')),
    })
    try {
      h.skills.push(await packageSkill(h.home, 'leaf', { full: true }))
      h.skills.push(await packageSkill(h.home, 'bare'))
      const root = await packageSkill(h.home, 'root')
      h.skills.push(root)
      h.skills.push(await packageSkill(h.home, 'taken', { full: true }))
      h.skills.push(await packageSkill(h.home, 'loose'))
      // An umbrella directory without a SKILL.md cannot receive a merge.
      await mkdir(join(h.home, 'skills', 'headless'), { recursive: true })
      h.skills.push({ name: 'headless', source: 'user-dsh', path: join(h.home, 'skills', 'headless', 'SKILL.md') })
      // An umbrella that already owns a directory of that name cannot receive it either.
      await mkdir(join(dirname(root.path), 'taken'), { recursive: true })
      await h.telemetry?.markAgentCreated('leaf')
      await h.telemetry?.markAgentCreated('bare')
      await h.telemetry?.markAgentCreated('taken')
      await h.telemetry?.markAgentCreated('loose')
      const report = await h.curator.consolidate()
      expect(report?.skipped).toBe(4)
      expect(report?.passId).toBeNull()
      expect(await readFile(join(h.home, 'skills', 'leaf', 'references', 'note.md'), 'utf8'))
        .toBe('See ${DSH_SKILL_DIR}/references/note.md for leaf.\n')
      expect(h.telemetry?.read('leaf')).toMatchObject({ state: 'active', absorbedInto: null })
      expect(await readFile(join(h.home, 'skills', 'bare', 'SKILL.md'), 'utf8')).toContain('body of bare')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('archives a package whole into .archive and rolls the run back', async () => {
    const h = await harness({
      curatorConfig: CONSOLIDATING,
      respond: async (_request, index) => (index === 0
        ? toolTurn([call('skill_apply', { name: 'leaf', action: 'archive' })])
        : textTurn('done')),
    })
    try {
      h.skills.push(await packageSkill(h.home, 'leaf', { full: true }))
      await h.telemetry?.markAgentCreated('leaf')
      const report = await h.curator.consolidate()
      const archived = join(h.home, 'skills', '.archive', 'leaf')
      expect(await readFile(join(archived, 'references', 'note.md'), 'utf8')).toContain('note.md')
      expect(await pathExists(join(h.home, 'skills', 'leaf'))).toBe(false)
      expect(h.telemetry?.read('leaf')).toMatchObject({ state: 'archived' })
      const passId = report?.passId
      if (passId === null || passId === undefined) throw new Error('expected a consolidation pass')
      const rolled = await h.curator.rollbackPass(passId)
      expect(rolled.restoredDirs).toEqual(['leaf'])
      expect(await pathExists(join(h.home, 'skills', 'leaf', 'references', 'note.md'))).toBe(true)
      expect(await pathExists(archived)).toBe(false)
      expect(h.telemetry?.read('leaf')).toMatchObject({ state: 'active' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('records a consolidation move without a snapshot when backups are off', async () => {
    const h = await harness({
      curatorConfig: { ...CONSOLIDATING, backup: { enabled: false } },
      respond: async (_request, index) => (index === 0
        ? toolTurn([call('skill_apply', { name: 'leaf', action: 'archive' })])
        : textTurn('done')),
    })
    try {
      h.skills.push(await packageSkill(h.home, 'leaf'))
      await h.telemetry?.markAgentCreated('leaf')
      const report = await h.curator.consolidate()
      expect(report?.passId).toBeNull()
      expect(report?.snapshot).toBeNull()
      expect(await pathExists(join(h.home, 'skills', '.archive', 'leaf'))).toBe(true)
      const actions = (await readLedger(curatorHome())).map(entry => entry.action)
      expect(actions).toEqual(['cost', 'move'])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('fails a rollback closed when a package move cannot be reversed', async () => {
    const h = await harness({
      curatorConfig: CONSOLIDATING,
      respond: async (_request, index) => (index === 0
        ? toolTurn([call('skill_apply', { name: 'leaf', action: 'archive' })])
        : textTurn('done')),
    })
    try {
      h.skills.push(await packageSkill(h.home, 'leaf'))
      await h.telemetry?.markAgentCreated('leaf')
      const report = await h.curator.consolidate()
      const passId = report?.passId
      if (passId === null || passId === undefined) throw new Error('expected a consolidation pass')
      const archived = join(h.home, 'skills', '.archive', 'leaf')
      await mkdir(join(h.home, 'skills', 'leaf'), { recursive: true })
      await expect(h.curator.rollbackPass(passId)).rejects.toThrow('is occupied')
      await rm(join(h.home, 'skills', 'leaf'), { recursive: true, force: true })
      await rm(archived, { recursive: true, force: true })
      await expect(h.curator.rollbackPass(passId)).rejects.toThrow('is gone')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('skips verdicts outside the survey and for pinned skills', async () => {
    const h = await harness({
      curatorConfig: CONSOLIDATING,
      respond: async (_request, index) => (index === 0
        ? toolTurn([
          call('skill_apply', { name: 'ghost', action: 'archive' }),
          call('skill_apply', { name: 'pinned', action: 'archive' }),
        ])
        : textTurn('done')),
    })
    try {
      h.skills.push(await packageSkill(h.home, 'pinned', { full: true }))
      await h.telemetry?.markAgentCreated('pinned')
      await h.telemetry?.setPinned('pinned', true)
      const report = await h.curator.consolidate()
      expect(report?.skipped).toBe(1)
      expect(report?.verdicts).toEqual([{ name: 'pinned', action: 'archive' }])
      expect(await pathExists(join(h.home, 'skills', 'pinned'))).toBe(true)
      expect(await pathExists(join(h.home, 'skills', '.archive'))).toBe(false)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('commits only a body that keeps valid frontmatter, and stores its preimage', async () => {
    const h = await harness({ curatorConfig: CONSOLIDATING })
    try {
      h.skills.push(await packageSkill(h.home, 'leaf'))
      await h.telemetry?.markAgentCreated('leaf')
      const telemetry = h.telemetry
      if (telemetry === undefined) throw new Error('expected telemetry')
      const dir = join(h.home, 'skills', 'leaf')
      const original = await readFile(join(dir, 'SKILL.md'), 'utf8')
      const candidate = {
        name: 'leaf',
        description: 'leaf skill',
        source: 'user-dsh',
        state: 'active' as const,
        idleDays: 0,
        useCount: 0,
        viewCount: 0,
        patchCount: 0,
        lastUsedAt: null,
        failures: [],
        trust: 'provisional' as const,
        revision: 0,
        contentSha: null,
        lastTrustFailure: null,
      }
      const applied = await applyConsolidation({
        at: '2026-06-01T00:00:00.000Z',
        passId: 'pass-patch',
        home: curatorHome(),
        telemetry,
        candidates: new Map([['leaf', candidate]]),
        dirs: new Map([['leaf', dir]]),
      }, [
        { name: 'leaf', action: 'patch', body: 'no fenced head at all\n' },
        { name: 'leaf', action: 'patch', body: '---\nname: other\ndescription: d\n---\nbody\n' },
        { name: 'leaf', action: 'patch', body: '---\nname: leaf\ndescription: leaf skill\n---\n   \n' },
        { name: 'leaf', action: 'patch', body: '---\nname: leaf\ndescription: leaf skill\n---\nrewritten\n' },
      ])
      // Three bodies would break the skill; only the valid one landed, and each
      // refusal names the rung that decided it.
      expect(applied.skipped).toBe(3)
      expect(applied.refusals).toEqual([
        { name: 'leaf', level: 0, reason: 'schema: body has no frontmatter' },
        { name: 'leaf', level: 0, reason: 'schema: skill "leaf" frontmatter must keep name "leaf"' },
        { name: 'leaf', level: 1, reason: 'invariant: body carries no instructions after its frontmatter' },
      ])
      expect(applied.patched).toBe(1)
      expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toContain('rewritten')
      const rows = (await readLedger(curatorHome())).filter(entry => entry.action === 'patch')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.before).toBe(textSha(original))
      expect(rows[0]?.after).toBe(telemetry.read('leaf')?.contentSha)
      expect(rows[0]?.evidence['file']).toBe(join(dir, 'SKILL.md'))
      expect(await readTextBlob(curatorHome(), textSha(original))).toBe(original)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('restores a patched body on rollback and skips rows that predate preimages', async () => {
    const h = await harness({
      curatorConfig: CONSOLIDATING,
      respond: async (_request, index) => (index === 0
        ? toolTurn([call('skill_apply', {
          name: 'leaf',
          action: 'patch',
          body: '---\nname: leaf\ndescription: leaf skill\n---\nrewritten body\n',
        })])
        : textTurn('done')),
    })
    try {
      h.skills.push(await packageSkill(h.home, 'leaf'))
      await h.telemetry?.markAgentCreated('leaf')
      const file = join(h.home, 'skills', 'leaf', 'SKILL.md')
      const original = await readFile(file, 'utf8')
      const report = await h.curator.consolidate()
      const passId = report?.passId
      if (passId === null || passId === undefined) throw new Error('expected a consolidation pass')
      expect(await readFile(file, 'utf8')).toContain('rewritten body')
      // A patch row written before bodies were snapshotted has no preimage.
      await appendLedger(curatorHome(), {
        id: 'legacy',
        at: '2026-06-01T00:00:00.000Z',
        actor: 'curator',
        action: 'patch',
        evidence: { passId, name: 'leaf', dir: join(h.home, 'skills', 'leaf'), file },
        before: null,
        after: null,
      })
      const rolled = await h.curator.rollbackPass(passId)
      expect(rolled.restoredFiles).toEqual(['leaf'])
      expect(await readFile(file, 'utf8')).toBe(original)
      expect(h.telemetry?.read('leaf')?.contentSha).toBe(createHash('sha256').update(original).digest('hex'))
      const rows = (await readLedger(curatorHome())).filter(entry => entry.action === 'rollback')
      expect(rows.at(-1)).toMatchObject({ evidence: { rollbackOf: `pass '${passId}'`, name: 'leaf', file } })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('fails a body rollback closed when a preimage is gone', async () => {
    const h = await harness({
      curatorConfig: CONSOLIDATING,
      respond: async (_request, index) => (index === 0
        ? toolTurn([call('skill_apply', {
          name: 'leaf',
          action: 'patch',
          body: '---\nname: leaf\ndescription: leaf skill\n---\nrewritten body\n',
        })])
        : textTurn('done')),
    })
    try {
      h.skills.push(await packageSkill(h.home, 'leaf'))
      await h.telemetry?.markAgentCreated('leaf')
      const report = await h.curator.consolidate()
      const passId = report?.passId
      if (passId === null || passId === undefined) throw new Error('expected a consolidation pass')
      const rows = (await readLedger(curatorHome())).filter(entry => entry.action === 'patch')
      await rm(join(curatorHome(), 'blobs', `${rows[0]?.before as string}.md`))
      await expect(h.curator.rollbackPass(passId)).rejects.toThrow('is missing the body blob')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('applies every ineligible verdict as a skip', async () => {
    const h = await harness({ curatorConfig: CONSOLIDATING })
    try {
      const record = h.telemetry
      if (record === undefined) throw new Error('expected telemetry')
      const home = curatorHome()
      const before = { ...(record.read('leaf') as SkillUsageRecord) }
      const deps = {
        at: new Date().toISOString(),
        passId: 'pass-direct',
        home,
        telemetry: {
          read: () => undefined,
          setState: () => Promise.resolve(before),
        },
        candidates: new Map([
          ['leaf', { name: 'leaf', description: '', source: 'user-dsh', state: 'active' as const, idleDays: 0, useCount: 0, viewCount: 0, patchCount: 0, lastUsedAt: null }],
        ]),
        dirs: new Map([['leaf', join(h.home, 'skills', 'leaf')]]),
      }
      const applied = await applyConsolidation(deps as never, [
        { name: 'ghost', action: 'archive' },
        { name: 'leaf', action: 'patch' },
        { name: 'leaf', action: 'archive' },
      ])
      expect(applied.skipped).toBe(3)
      expect(applied.transitions).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rides the pass trigger when opted in and stays out of dry runs', async () => {
    const h = await harness({
      curatorConfig: CONSOLIDATING,
      respond: async (_request, index) => (index === 0
        ? toolTurn([call('skill_apply', { name: 'leaf', action: 'keep' })])
        : textTurn('done')),
    })
    try {
      h.skills.push(await packageSkill(h.home, 'leaf'))
      await h.telemetry?.markAgentCreated('leaf')
      const report = await h.curator.run()
      expect(report.consolidation?.verdicts).toHaveLength(1)
      expect(h.calls).toHaveLength(2)
      const dry = await h.curator.run({ dryRun: true })
      expect(dry.consolidation).toBeUndefined()
      expect(h.calls).toHaveLength(2)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('bounds the fork loop and refuses everything else with a recoverable result', async () => {
    const h = await harness({
      curatorConfig: { ...CONSOLIDATING, maxSteps: 2 },
      respond: async (_request, index) => (index === 0
        ? toolTurn([
          call('skill_view', { name: 'leaf' }),
          call('skill_view', { name: 'leaf', file: 'references/note.md' }),
          call('skill_view', { name: 'leaf', file: 'gone.md' }),
          call('skill_delete', { name: 'leaf' }),
          call('skill_apply', { name: 'leaf', action: 'explode' }),
          call('skill_apply', { name: 'ghost', action: 'keep' }),
          call('skill_apply', { name: 'remote', action: 'keep' }),
          { name: 'skill_apply', arguments: '{' },
        ])
        : toolTurn([call('skill_view', { name: 'leaf' })])),
    })
    try {
      h.skills.push(await packageSkill(h.home, 'leaf', { full: true }))
      h.skills.push({ name: 'remote', source: 'user-dsh' })
      await h.telemetry?.markAgentCreated('leaf')
      await h.telemetry?.markAgentCreated('remote')
      const report = await h.curator.consolidate()
      expect(report?.steps).toBe(2)
      expect(h.calls).toHaveLength(2)
      const results = toolResults(h.calls[1])
      expect(results[0]).toContain(`file ${join('references', 'note.md')}`)
      expect(results[0]).toContain('body of leaf')
      expect(results[1]).toContain('See ${DSH_SKILL_DIR}/references/note.md for leaf.')
      expect(results[2]).toContain('error:')
      expect(results[3]).toBe("error: unknown tool 'skill_delete'")
      expect(results[4]).toBe("error: unknown action 'explode'")
      expect(results[5]).toBe("error: 'ghost' is not a candidate")
      expect(results[6]).toBe("error: 'remote' has no writable directory")
      expect(results[7]).toBe("error: '' is not a candidate")
    } finally {
      await h.fiber.dispose()
    }
  })

  it('surfaces a failed fork request', async () => {
    const h = await harness({
      skills: [{ name: 'leaf', source: 'user-dsh' }],
      curatorConfig: CONSOLIDATING,
      respond: async () => [{ type: 'finish', reason: { kind: 'error', failure: { message: 'aux model refused', code: 'server' } } }] as StreamChunk[],
    })
    try {
      await h.telemetry?.markAgentCreated('leaf')
      await expect(h.curator.consolidate()).rejects.toThrow('aux model refused')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('aborts an in-flight consolidation at teardown', async () => {
    const started: PromiseWithResolvers<void> = Promise.withResolvers()
    const h = await harness({
      curatorConfig: CONSOLIDATING,
      respond: (request) => {
        started.resolve()
        const pending = Promise.withResolvers<StreamChunk[]>()
        request.signal?.addEventListener('abort', () =>{  pending.reject(new Error('aborted at teardown')) }, { once: true })
        return pending.promise
      },
    })
    await h.telemetry?.markAgentCreated('leaf')
    const settled = h.curator.consolidate().then(() => 'resolved', (error: unknown) => String(error))
    await started.promise
    await h.fiber.dispose()
    expect(await settled).toBe('Error: aborted at teardown')
  })
})
