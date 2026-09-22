/**
 * Optimizer orchestration over faked seams: the trigger gate skips quietly,
 * a missing seam throws loudly, an unbeaten baseline stages nothing, and a
 * winning variant stages exactly one skill patch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionOptimizer from '../src/index.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

function textTurn(text: string) {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

function usage(useCount: number, failureCount?: number) {
  return {
    useCount, failureCount, viewCount: 0, patchCount: 0, lastUsedAt: null, sessionIds: [],
    lastViewedAt: null, lastPatchedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    state: 'active', pinned: false, createdBy: null, absorbedInto: null, archivedAt: null,
  }
}

/** A SKILL.md file: the frontmatter the candidate admission gate requires. */
function skillBody(name: string, content: string): string {
  return `---\nname: ${name}\ndescription: ${name}.\n---\n${content}`
}

const BASE = skillBody('writer', '# writer')
const V2 = skillBody('writer', '# writer v2')
const V3 = skillBody('writer', '# writer v3')
const V4 = skillBody('writer', '# writer v4')
const V5 = skillBody('writer', '# writer v5')

interface BenchSeams {
  record?: { name: string; usage: ReturnType<typeof usage> } | undefined
  body?: string | undefined
  mutations?: string[] | undefined
  scores?: Record<string, { pass: boolean; tokens: number; wallTimeMs: number }> | undefined
  staged?: { id: string; gist: string; kind: string; op: string; payload: unknown }[] | undefined
  llm?: boolean | undefined
  route?: boolean | undefined
  skipEvaluation?: string | undefined
  skipOnCall?: number | undefined
  /** Governance and mutation settings merged over the harness defaults. */
  config?: Record<string, unknown> | undefined
  /** Bodies the Nth mutation call answers with; the last entry repeats. */
  llmBodies?: string[][] | undefined
  /** Fail every ledger write, so the run must survive a broken store. */
  brokenLedger?: boolean | undefined
  /** Decided staged entries the memory scope reports, for the regression guard. */
  resolutions?: { id: string; kind: string; decision: 'approved' | 'rejected' }[] | undefined
  /** Wall-time samples each scored scenario carries; the attempt count. */
  sampleCount?: number | undefined
  /** Score one call by the scenarios it runs and its global call index. */
  scoresFor?: ((scenarios: readonly string[], call: number) => { pass: boolean; tokens: number; wallTimeMs: number }) | undefined
  /** Scoring-semantics version the fake scorer reports; the ledger stamps it. */
  scorerVersion?: number | undefined
  /** Mount a fake population store; `error` fails every record write. */
  population?: { error?: Error } | undefined
  /** Mount a fake model-routes store; `error` fails every observe write. */
  routes?: { error?: Error } | undefined
  /** Mount a fake canary store; `error` fails every enter write. */
  canary?: { error?: Error } | undefined
  /** Mount a fake novelty-search store; `error` fails every record write. */
  novelty?: { error?: Error } | undefined
  /** Mount a fake stagnation store; `error` fails every recordRun write. */
  stagnation?: { error?: Error } | undefined
  /** Mount a fake islands store; `error` fails every advance write. */
  islands?: { error?: Error } | undefined
  /** Mount a fake self-model store; `error` fails every observe write. */
  selfModel?: { error?: Error } | undefined
  /** Mount a fake lineage store; `error` fails every record write. */
  lineage?: { error?: Error } | undefined
}

/** A storage domain whose only table refuses every write. */
function brokenDomain(): unknown {
  return {
    open: async () => ({
      table: () => ({
        get: () => undefined,
        entries: () => [][Symbol.iterator](),
        keys: () => [][Symbol.iterator](),
        size: 0,
        put: async () => { throw new Error('storage is read-only') },
        delete: async () => false,
      }),
      close: () => {},
    }),
  }
}

async function bench(seams: BenchSeams = {}) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', seams.brokenLedger === true ? brokenDomain() : facility)
  const bodies = seams.mutations ?? []
  let llmCalls = 0
  if (seams.llm !== false) {
    let call = 0
    ctx.provide('llm', {
      stream: () => {
        const perCall = seams.llmBodies?.[Math.min(call, (seams.llmBodies?.length ?? 1) - 1)]
        call += 1
        llmCalls += 1
        return textTurn(JSON.stringify(perCall ?? bodies))
      },
    } as never)
  }
  ctx.provide('evolutionSkillTelemetry', {
    entries: () => seams.record === undefined ? [] : [seams.record],
  } as never)
  ctx.provide('skills', {
    get: async () => seams.body === undefined ? undefined : { content: seams.body },
  } as never)
  const scores = seams.scores ?? {}
  const scoreCalls: string[][] = []
  let calls = 0
  const fakeScorer = {
    version: seams.scorerVersion ?? 1,
    evaluateSkill: async (request: { skill: string; scenarios: readonly string[] }) => {
      const call = calls
      calls += 1
      scoreCalls.push([...request.scenarios])
      if (seams.skipEvaluation !== undefined && (seams.skipOnCall ?? 0) === call) {
        return { status: 'skipped' as const, skill: request.skill, reason: seams.skipEvaluation }
      }
      const measured = seams.scoresFor?.(request.scenarios, call)
        ?? scores[request.skill]
        ?? { pass: true, tokens: 10, wallTimeMs: 10 }
      return {
        status: 'evaluated' as const,
        skill: request.skill,
        score: {
          skill: request.skill,
          ...measured,
          scores: request.scenarios.map(scenario => ({
            scenario,
            pass: measured.pass,
            changes: [],
            tokens: measured.tokens,
            wallTimeMs: measured.wallTimeMs,
            samples: Array.from({ length: seams.sampleCount ?? 0 }, () => measured.wallTimeMs),
          })),
        },
      }
    },
  }
  ctx.provide('evolutionScorer', fakeScorer as never)
  const staged: { id: string; gist: string; kind: string; op: string; payload: unknown }[] = seams.staged ?? []
  ctx.provide('evolutionMemory', {
    read: () => seams.resolutions === undefined
      ? undefined
      : { resolutions: seams.resolutions.map(resolution => ({ ...resolution, op: 'patch', gist: '', at: '', originSessionId: '' })) },
    stageWrite: async (input: { gist: string; kind: string; op: string; payload: unknown }) => {
      const entry = { id: `staged-${staged.length}`, gist: input.gist, kind: input.kind, op: input.op, payload: input.payload }
      staged.push(entry)
      return entry
    },
  } as never)
  const populationRows: Record<string, unknown>[] = []
  if (seams.population !== undefined) {
    ctx.provide('evolutionPopulation', {
      record: async (input: Record<string, unknown>) => {
        if (seams.population?.error !== undefined) throw seams.population.error
        populationRows.push(input)
        return { candidateId: input.candidateId as string, ...input }
      },
    } as never)
  }
  const routeRows: Record<string, unknown>[] = []
  if (seams.routes !== undefined) {
    ctx.provide('evolutionModelRoutes', {
      observe: async (input: Record<string, unknown>) => {
        if (seams.routes?.error !== undefined) throw seams.routes.error
        routeRows.push(input)
        return { id: 'r1', ...input }
      },
    } as never)
  }
  const canaryRows: Record<string, unknown>[] = []
  if (seams.canary !== undefined) {
    ctx.provide('evolutionCanary', {
      enter: async (input: Record<string, unknown>) => {
        if (seams.canary?.error !== undefined) throw seams.canary.error
        canaryRows.push(input)
        return { state: 'shadow', ...input }
      },
    } as never)
  }
  const noveltyRows: Record<string, unknown>[] = []
  if (seams.novelty !== undefined) {
    ctx.provide('evolutionNovelty', {
      record: async (input: Record<string, unknown>) => {
        if (seams.novelty?.error !== undefined) throw seams.novelty.error
        noveltyRows.push(input)
        return { candidateId: input.candidateId as string, ...input, novelty: 1, at: '' }
      },
    } as never)
  }
  const stagnationRows: Record<string, unknown>[] = []
  if (seams.stagnation !== undefined) {
    ctx.provide('evolutionStagnation', {
      recordRun: async (input: Record<string, unknown>) => {
        if (seams.stagnation?.error !== undefined) throw seams.stagnation.error
        stagnationRows.push(input)
        return { runId: input.runId as string, ...input, generation: 1, improved: true, at: '' }
      },
    } as never)
  }
  const islandTicks: string[] = []
  if (seams.islands !== undefined) {
    ctx.provide('evolutionIslands', {
      advance: async (skill: string) => {
        if (seams.islands?.error !== undefined) throw seams.islands.error
        islandTicks.push(skill)
        return { islandId: 'a', skill, generation: 1 }
      },
    } as never)
  }
  const selfModelObservations: Record<string, unknown>[] = []
  if (seams.selfModel !== undefined) {
    ctx.provide('evolutionSelfModel', {
      observe: async (input: Record<string, unknown>) => {
        if (seams.selfModel?.error !== undefined) throw seams.selfModel.error
        selfModelObservations.push(input)
        return { capability: input.capability as string, ...input, score: 1, confidence: 1, failures: [], coveringSkills: [], observations: 1, at: '' }
      },
    } as never)
  }
  const lineageEnvelopes: Record<string, unknown>[] = []
  if (seams.lineage !== undefined) {
    ctx.provide('evolutionLineage', {
      record: async (input: Record<string, unknown>) => {
        if (seams.lineage?.error !== undefined) throw seams.lineage.error
        lineageEnvelopes.push(input)
        return { experimentId: input.experimentId as string, ...input, at: '' }
      },
    } as never)
  }
  await ctx.plugin(EvolutionOptimizer, {
    ...(seams.route === false ? {} : { provider: 'deepseek', model: 'deepseek-chat' }),
    agent: { binScript: 'bin', configPath: 'cfg', tsconfigPath: 'tsconfig' },
    ...seams.config,
  })
  const optimizer = ctx.get('evolutionOptimizer') as EvolutionOptimizer
  return {
    ctx, optimizer, staged, populationRows, routeRows, canaryRows, noveltyRows,
    stagnationRows, islandTicks, selfModelObservations, lineageEnvelopes,
    scoreCalls, scorer: fakeScorer, llmCalls: () => llmCalls,
  }
}
const request = {
  skill: 'writer',
  scenarios: ['s1'],
  scopeId: 'profile/scope' as never,
  originSessionId: 'session-1',
  run: (async () => ({ workspace: [], tokens: 0, wallTimeMs: 0 })) as never,
}

describe('EvolutionOptimizer', () => {
  it('skips a skill with no telemetry record', async () => {
    const { optimizer } = await bench()
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('skipped')
    expect(report.reason).toContain('no telemetry record')
  })

  it('skips a skill below the trigger', async () => {
    const { optimizer } = await bench({ record: { name: 'writer', usage: usage(30) } })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('skipped')
    expect(report.reason).toContain('below the optimization trigger')
  })

  it('skips a skill with no readable body', async () => {
    const { optimizer } = await bench({ record: { name: 'writer', usage: usage(12, 10) } })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('skipped')
    expect(report.reason).toContain('no readable SKILL.md body')
  })

  it('throws when a required seam is missing', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      llm: false,
    })
    await expect(optimizer.optimize(request)).rejects.toThrow('requires the scorer, telemetry, memory, skills, and llm seams')
  })
  it('reports no-improvement when mutation produces no usable bodies', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [],
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('no-improvement')
    expect(report.baseline).toBeNull()
    expect(report.reason).toContain('no usable bodies')
  })

  it('throws when the provider/model route is missing', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      route: false,
    })
    await expect(optimizer.optimize(request)).rejects.toThrow('requires a provider/model route')
  })

  it('propagates a baseline skip without staging', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      skipEvaluation: 'scenario gone',
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('skipped')
    expect(report.reason).toBe('scenario gone')
    expect(staged).toHaveLength(0)
  })

  it('propagates a variant skip with the baseline attached', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      skipEvaluation: 'scenario gone',
      skipOnCall: 1,
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('skipped')
    expect(report.reason).toBe('scenario gone')
    expect(report.baseline?.tokens).toBe(10)
    expect(report.candidates).toHaveLength(0)
    expect(staged).toHaveLength(0)
  })

  it('falls back to the request agent and the process runner', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
    })
    const report = await optimizer.optimize({
      skill: 'writer',
      scenarios: ['s1'],
      scopeId: 'profile/scope' as never,
      originSessionId: 'session-1',
      agent: { binScript: 'custom', configPath: 'custom-cfg', tsconfigPath: 'custom-tsconfig' },
    })
    expect(report.status).toBe('no-improvement')
    expect(report.candidates).toHaveLength(1)
  })

  it('stages nothing when no variant beats the baseline', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scores: { writer: { pass: true, tokens: 5, wallTimeMs: 5 } },
    })
    const report = await optimizer.optimize(request)
    // Baseline and variant score identically, so nothing dominates.
    expect(report.status).toBe('no-improvement')
    expect(report.candidates).toHaveLength(1)
    expect(staged).toHaveLength(0)
  })

  it('stages the winning variant as a skill patch', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      // Baseline scores costly, the variant scores cheap.
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : call === 1 ? 3 : 10, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(report.stagedId).toBe('staged-0')
    expect(report.baseline?.tokens).toBe(9)
    expect(report.candidates[0]?.score.tokens).toBe(3)
    expect(staged).toHaveLength(1)
    expect(staged[0]).toMatchObject({ kind: 'skill', op: 'patch' })
    expect(staged[0]?.payload).toMatchObject({ skill: 'writer', body: V2, operator: 'rewrite' })
  })

  it('keeps staging when the population store is not mounted', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(staged).toHaveLength(1)
  })

  it('records the staged winner into a mounted population store', async () => {
    const { optimizer, populationRows } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      population: {},
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(populationRows).toHaveLength(1)
    expect(populationRows[0]).toMatchObject({
      skill: 'writer',
      candidateId: 'staged-0',
      operator: 'rewrite',
      status: 'staged',
      triple: { pass: true, tokens: 3, wallTimeMs: 5 },
    })
    expect(populationRows[0]?.novelty).toBeGreaterThan(0)
  })

  it('survives a failing population store with a warning', async () => {
    const { ctx, optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      population: { error: new Error('population disk on fire') },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const report = await optimizer.optimize(request)
      expect(report.status).toBe('staged')
      expect(staged).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record population'))
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps staging when the model-routes store is not mounted', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(staged).toHaveLength(1)
  })

  it('records the candidate-generation route into a mounted model-routes store', async () => {
    const { optimizer, routeRows } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      routes: {},
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(routeRows).toHaveLength(1)
    expect(routeRows[0]).toEqual({
      role: 'candidate-generation',
      route: { provider: 'deepseek', model: 'deepseek-chat' },
      triple: { pass: true, tokens: 3, wallTimeMs: 5 },
    })
  })

  it('survives a failing model-routes store with a warning', async () => {
    const { ctx, optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      routes: { error: new Error('routes disk on fire') },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const report = await optimizer.optimize(request)
      expect(report.status).toBe('staged')
      expect(staged).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record model route'))
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps staging when the canary store is not mounted', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(staged).toHaveLength(1)
  })

  it('enters the staged write into a mounted canary store as shadow', async () => {
    const { optimizer, canaryRows } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      canary: {},
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(canaryRows).toHaveLength(1)
    expect(canaryRows[0]).toEqual({
      id: 'staged-0',
      skill: 'writer',
      triple: { pass: true, tokens: 3, wallTimeMs: 5 },
    })
  })

  it('survives a failing canary store with a warning', async () => {
    const { ctx, optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      canary: { error: new Error('canary disk on fire') },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const report = await optimizer.optimize(request)
      expect(report.status).toBe('staged')
      expect(staged).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record canary deployment'))
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps staging when the novelty-search store is not mounted', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(staged).toHaveLength(1)
  })

  it('records the staged winner into a mounted novelty-search archive', async () => {
    const { optimizer, noveltyRows } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      novelty: {},
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(noveltyRows).toHaveLength(1)
    expect(noveltyRows[0]).toMatchObject({
      skill: 'writer',
      candidateId: 'staged-0',
    })
    expect(noveltyRows[0]?.features).toEqual(expect.any(Array))
  })

  it('survives a failing novelty-search store with a warning', async () => {
    const { ctx, optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      novelty: { error: new Error('archive disk on fire') },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const report = await optimizer.optimize(request)
      expect(report.status).toBe('staged')
      expect(staged).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record novelty archive'))
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps staging when the stagnation store is not mounted', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(staged).toHaveLength(1)
  })

  it('records the staged winner into a mounted stagnation store as a run', async () => {
    const { optimizer, stagnationRows } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      stagnation: {},
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(stagnationRows).toHaveLength(1)
    expect(stagnationRows[0]).toEqual({
      skill: 'writer',
      runId: 'staged-0',
      score: { pass: true, tokens: 3, wallTimeMs: 5 },
    })
  })

  it('survives a failing stagnation store with a warning', async () => {
    const { ctx, optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      stagnation: { error: new Error('stagnation disk on fire') },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const report = await optimizer.optimize(request)
      expect(report.status).toBe('staged')
      expect(staged).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record stagnation run'))
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps staging when the islands store is not mounted', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(staged).toHaveLength(1)
  })

  it('advances the skill head island in a mounted islands store', async () => {
    const { optimizer, islandTicks } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      islands: {},
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(islandTicks).toEqual(['writer'])
  })

  it('survives a failing islands store with a warning', async () => {
    const { ctx, optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      islands: { error: new Error('islands disk on fire') },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const report = await optimizer.optimize(request)
      expect(report.status).toBe('staged')
      expect(staged).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not advance evolution islands'))
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps staging when the self-model store is not mounted', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(staged).toHaveLength(1)
  })

  it('records a self-model capability observation in a mounted store', async () => {
    const { optimizer, selfModelObservations } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      selfModel: {},
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(selfModelObservations).toEqual([
      { capability: 'writer', skill: 'writer', pass: true, failure: undefined },
    ])
  })

  it('survives a failing self-model store with a warning', async () => {
    const { ctx, optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      selfModel: { error: new Error('self-model disk on fire') },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const report = await optimizer.optimize(request)
      expect(report.status).toBe('staged')
      expect(staged).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record self model'))
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps staging when the lineage store is not mounted', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(staged).toHaveLength(1)
  })

  it('records a lineage envelope in a mounted store', async () => {
    const { optimizer, lineageEnvelopes } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      lineage: {},
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(lineageEnvelopes).toHaveLength(1)
    const envelope = lineageEnvelopes[0] as Record<string, unknown>
    expect(envelope.experimentId).toBe('staged-0')
    expect(envelope.skill).toBe('writer')
    expect(envelope.outcome).toBe('improved')
    expect(envelope.dependencies).toMatchObject({
      evaluator: 'scorer-v1',
      model: 'deepseek/deepseek-chat',
    })
    expect(typeof (envelope.dependencies as Record<string, unknown>).skill).toBe('string')
  })

  it('survives a failing lineage store with a warning', async () => {
    const { ctx, optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      lineage: { error: new Error('lineage disk on fire') },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const report = await optimizer.optimize(request)
      expect(report.status).toBe('staged')
      expect(staged).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record lineage envelope'))
    } finally {
      warn.mockRestore()
    }
  })

  it('refuses a candidate body that would break the skill before scoring it', async () => {
    const { optimizer, scoreCalls, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      config: { maxCandidates: 2, operators: ['rewrite', 'compress'] },
      llmBodies: [['# writer without frontmatter'], [V2]],
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 9 : 3, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(staged[0]?.payload).toMatchObject({ body: V2, operator: 'compress' })
    // One baseline plus one survivor: the broken body never bought a scoring run.
    expect(scoreCalls).toHaveLength(2)
  })

  it('reports the refusals when no candidate body could be landed', async () => {
    const { optimizer, scoreCalls } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: ['# writer without frontmatter', skillBody('other', '# renamed')],
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('no-improvement')
    expect(report.reason).toContain('no usable bodies')
    expect(report.reason).toContain('2 refused for breaking the skill frontmatter')
    expect(scoreCalls).toHaveLength(0)
  })

  it('draws candidates from every configured operator and tags each one', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      config: { maxCandidates: 2, operators: ['rewrite', 'compress'] },
      llmBodies: [[V2], [V3]],
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 ? 9 : call === 2 ? 3 : 10, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(report.candidates.map(candidate => [candidate.index, candidate.operator])).toEqual([[0, 'rewrite'], [1, 'compress']])
    expect(staged[0]?.gist).toContain('by compress')
  })

  it('keeps one candidate when two operators return the same body', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      config: { maxCandidates: 2, operators: ['rewrite', 'compress'] },
      llmBodies: [[V2], [V2]],
    })
    const report = await optimizer.optimize(request)
    expect(report.candidates.map(candidate => candidate.operator)).toEqual(['rewrite'])
  })

  it('throws when a configured operator is not a built-in one', async () => {
    await expect(bench({ config: { operators: ['nope'] } })).rejects.toThrow("unknown mutation operator 'nope'")
  })

  it('refuses a winner an approved promotion already dominates', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      // The first run stages a winner at 4 tokens; the second offers 6.
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call < 2 ? (call === 1 ? 4 : 10) : (call === 3 ? 6 : 10), wallTimeMs: 5 }),
      resolutions: [{ id: 'staged-0', kind: 'skill', decision: 'approved' }],
    })
    const first = await optimizer.optimize(request)
    expect(first.status).toBe('staged')
    const second = await optimizer.optimize({ ...request, evidence: 'new failures' })
    expect(second.status).toBe('regressed')
    expect(second.floor?.triple).toEqual({ pass: true, tokens: 4, wallTimeMs: 5 })
    expect(second.floor?.stagedId).toBe('staged-0')
    expect(second.reason).toContain('dominated by the approved result')
    const rows = optimizer.experiments(request.scopeId)
    expect(rows[0]).toMatchObject({ outcome: 'regressed', stagedId: null, samples: 0, addedLines: 1, removedLines: 1 })
  })

  it('ignores a rejected promotion and a floor measured on other scenarios', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 || call === 3 ? 4 : 10, wallTimeMs: 5 }),
      resolutions: [{ id: 'staged-0', kind: 'skill', decision: 'rejected' }],
    })
    expect((await optimizer.optimize(request)).status).toBe('staged')
    // The same approved floor on a different scenario set is not comparable.
    const elsewhere = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 ? 4 : call === 3 ? 6 : 10, wallTimeMs: 5 }),
      resolutions: [{ id: 'staged-0', kind: 'skill', decision: 'approved' }],
    })
    await elsewhere.optimizer.optimize(request)
    expect((await elsewhere.optimizer.optimize({ ...request, scenarios: ['s2'] })).status).toBe('staged')
  })

  it('ignores an approved floor measured with a different attempt count', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      sampleCount: 3,
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 ? 4 : call === 3 ? 6 : 10, wallTimeMs: 5 }),
      resolutions: [{ id: 'staged-0', kind: 'skill', decision: 'approved' }],
    })
    expect((await optimizer.optimize(request)).status).toBe('staged')
    expect(optimizer.experiments(request.scopeId)[0]?.samples).toBe(3)

    const single = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      sampleCount: 1,
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 ? 4 : call === 3 ? 6 : 10, wallTimeMs: 5 }),
    })
    expect((await single.optimizer.optimize(request)).status).toBe('staged')
  })

  it('scans past a row that promoted nothing', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      // Run 1 wins at 4 tokens, run 2 offers 6 and is refused, run 3 offers 5.
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call % 2 === 1 ? (call === 1 ? 4 : call === 3 ? 6 : 5) : 10, wallTimeMs: 5 }),
      resolutions: [{ id: 'staged-0', kind: 'skill', decision: 'approved' }],
    })
    expect((await optimizer.optimize(request)).status).toBe('staged')
    expect((await optimizer.optimize({ ...request, evidence: 'second try' })).status).toBe('regressed')
    const third = await optimizer.optimize({ ...request, evidence: 'third try' })
    expect(third.status).toBe('regressed')
    expect(third.floor?.triple.tokens).toBe(4)
  })

  it('ignores an approved floor measured under an older scorer version', async () => {
    const { optimizer, scorer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      // Run 1 stages a winner at 4 tokens; run 2 offers 6, which the run-1
      // floor would dominate had the scorer version not changed.
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call < 2 ? (call === 1 ? 4 : 10) : (call === 3 ? 6 : 10), wallTimeMs: 5 }),
      resolutions: [{ id: 'staged-0', kind: 'skill', decision: 'approved' }],
    })
    expect((await optimizer.optimize(request)).status).toBe('staged')
    scorer.version = 2
    const second = await optimizer.optimize({ ...request, evidence: 'new failures' })
    expect(second.status).toBe('staged')
    expect(second.floor).toBeNull()
    expect(optimizer.experiments(request.scopeId)[0]).toMatchObject({ scorerVersion: 2 })
  })

  it('stages a candidate that still beats the approved floor', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 ? 4 : call === 3 ? 2 : 10, wallTimeMs: 5 }),
      resolutions: [{ id: 'staged-0', kind: 'skill', decision: 'approved' }],
    })
    expect((await optimizer.optimize(request)).status).toBe('staged')
    const second = await optimizer.optimize({ ...request, evidence: 'new failures' })
    expect(second.status).toBe('staged')
    expect(second.floor).toBeNull()
  })

  it('refuses a search scenario listed as holdout', async () => {
    const { optimizer } = await bench({ config: { holdoutScenarios: ['s1'] } })
    await expect(optimizer.optimize(request)).rejects.toThrow('holdout scenarios are also search scenarios: s1')
  })

  it('refuses a holdout scenario the ledger already records as search', async () => {
    const { optimizer } = await bench({ config: { holdoutScenarios: ['s1'] } })
    optimizer.experiments = () => [{
      id: 'earlier',
      at: '2026-09-15T10:00:00.000Z',
      scope: 'profile/scope',
      skill: 'writer',
      evidence: 'evidence',
      operators: ['rewrite'],
      portfolio: ['rewrite'],
      novelOperators: [],
      scenarios: ['s1'],
      holdout: [],
      baseline: { pass: true, tokens: 10, wallTimeMs: 5 },
      winner: null,
      confidence: null,
      samples: 1,
      outcome: 'no-improvement',
      reason: null,
      stagedId: null,
      provider: 'deepseek',
      model: 'deepseek-chat',
      bodySha: 'sha',
      scorerVersion: 1,
      addedLines: 0,
      removedLines: 0,
      winnerSha: null,
      winnerOperator: null,
    }]
    await expect(optimizer.optimize({ ...request, scenarios: ['s2'] }))
      .rejects.toThrow("holdout scenarios were already used for search for 'writer': s1")
  })

  it('refuses a repeated scenario name', async () => {
    const { optimizer } = await bench()
    await expect(optimizer.optimize({ ...request, scenarios: ['s1', 's1'] })).rejects.toThrow('a scenario list repeats a name')
    const held = await bench({ config: { holdoutScenarios: ['h1', 'h1'] } })
    await expect(held.optimizer.optimize(request)).rejects.toThrow('a scenario list repeats a name')
  })

  it('screens every candidate on the short subset before scoring survivors in full', async () => {
    const { optimizer, scoreCalls } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2, V3, V4],
      config: { screenScenarioCount: 1 },
      scoresFor: (scenarios, call) => (scenarios.length === 1
        // The screen scores the three candidates in mutation order; the third
        // is the worst and must never reach a full evaluation.
        ? { pass: true, tokens: [30, 10, 20][call - 1] ?? 99, wallTimeMs: 5 }
        : { pass: true, tokens: call === 0 ? 10 : 4, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize({ ...request, scenarios: ['s1', 's2', 's3'] })
    expect(scoreCalls).toEqual([
      ['s1', 's2', 's3'],
      ['s1'], ['s1'], ['s1'],
      ['s1', 's2', 's3'], ['s1', 's2', 's3'],
    ])
    expect(report.status).toBe('staged')
    expect(report.candidates.map(candidate => candidate.index)).toEqual([1, 2])
    expect(report.truncated).toBe(false)
  })

  it('stops scoring candidates once the token budget is spent', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2, V3],
      config: { budgetTokens: 15 },
      scoresFor: () => ({ pass: true, tokens: 10, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.truncated).toBe(true)
    expect(report.candidates).toHaveLength(1)
    expect(report.status).toBe('no-improvement')
  })

  it('stops scoring candidates once the wall-time budget is spent', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2, V3],
      config: { budgetWallTimeMs: 15 },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: 1, wallTimeMs: call === 0 ? 5 : 20 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.truncated).toBe(true)
    expect(report.candidates).toHaveLength(1)
  })

  it('skips when the budget is spent before any candidate is scored', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      config: { budgetTokens: 5 },
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('skipped')
    expect(report.reason).toContain('budget was spent before any candidate')
    expect(report.truncated).toBe(true)
    expect(staged).toHaveLength(0)
  })

  it('stages a winner the holdout scenarios support', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      config: { holdoutScenarios: ['h1'] },
      // Call 0 scores the baseline over the search set, 1 the candidate, then
      // 2 and 3 repeat that order over the holdout set.
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 || call === 3 ? 4 : 10, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(report.holdout?.baseline.tokens).toBe(10)
    expect(report.holdout?.winner.tokens).toBe(4)
    expect(staged).toHaveLength(1)
  })

  it('refuses a winner the baseline dominates on the holdout', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      config: { holdoutScenarios: ['h1'] },
      // The candidate wins the search set (call 1) and loses the holdout (3).
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 || call === 2 ? 4 : 10, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('holdout-rejected')
    expect(report.reason).toContain('dominated by the baseline on the holdout')
    expect(report.holdout?.winner.tokens).toBe(10)
    expect(staged).toHaveLength(0)
  })

  it('scores every candidate in full when the screen would cover the whole search set', async () => {
    const { optimizer, scoreCalls } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2, V3],
      config: { screenScenarioCount: 5 },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 0 ? 10 : 4, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize({ ...request, scenarios: ['s1', 's2'] })
    expect(scoreCalls).toEqual([['s1', 's2'], ['s1', 's2'], ['s1', 's2']])
    expect(report.status).toBe('staged')
  })

  it('propagates a screen skip without scoring survivors', async () => {
    const { optimizer, staged, scoreCalls } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2, V3],
      config: { screenScenarioCount: 1 },
      skipEvaluation: 'screen scenario gone',
      skipOnCall: 1,
    })
    const report = await optimizer.optimize({ ...request, scenarios: ['s1', 's2'] })
    expect(report.status).toBe('skipped')
    expect(report.reason).toBe('screen scenario gone')
    expect(scoreCalls).toEqual([['s1', 's2'], ['s1']])
    expect(staged).toHaveLength(0)
  })

  it('propagates a winner holdout skip without staging', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      config: { holdoutScenarios: ['h1'] },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 ? 4 : 10, wallTimeMs: 5 }),
      skipEvaluation: 'winner holdout unavailable',
      skipOnCall: 3,
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('skipped')
    expect(report.reason).toBe('winner holdout unavailable')
    expect(staged).toHaveLength(0)
  })

  it('records what a promotion measured', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      config: { holdoutScenarios: ['h1'] },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 || call === 3 ? 4 : 10, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    const rows = optimizer.experiments(request.scopeId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      scope: 'profile/scope',
      skill: 'writer',
      outcome: 'staged',
      stagedId: 'staged-0',
      operators: ['rewrite'],
      scenarios: ['s1'],
      holdout: ['h1'],
      provider: 'deepseek',
      model: 'deepseek-chat',
      confidence: { runs: 1, wins: 1 },
      reason: null,
    })
    expect(rows[0]?.baseline).toEqual({ pass: true, tokens: 10, wallTimeMs: 5 })
    expect(rows[0]?.winner).toEqual({ pass: true, tokens: 4, wallTimeMs: 5 })
    expect(rows[0]?.bodySha).not.toBe(rows[0]?.winnerSha)
  })

  it('records a rejected run and skips a run that never mutated', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scores: { writer: { pass: true, tokens: 5, wallTimeMs: 5 } },
    })
    expect((await optimizer.optimize(request)).status).toBe('no-improvement')
    const rows = optimizer.experiments(request.scopeId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'no-improvement', winnerSha: null, stagedId: null })
    expect(rows[0]?.reason).toContain('no variant beats the baseline')

    const quiet = await bench({ record: { name: 'writer', usage: usage(30) } })
    expect((await quiet.optimizer.optimize(request)).status).toBe('skipped')
    expect(quiet.optimizer.experiments(request.scopeId)).toHaveLength(0)
  })

  it('refuses to pay for an experiment the ledger already decided', async () => {
    const { optimizer, llmCalls } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scores: { writer: { pass: true, tokens: 5, wallTimeMs: 5 } },
    })
    expect((await optimizer.optimize(request)).status).toBe('no-improvement')
    const spent = llmCalls()
    const repeat = await optimizer.optimize(request)
    expect(repeat.status).toBe('skipped')
    expect(repeat.reason).toContain('already ran at')
    expect(repeat.reason).toContain('nothing beat the baseline')
    expect(llmCalls()).toBe(spent)
  })

  it('re-runs a recorded experiment after the scorer version changes', async () => {
    const { optimizer, scorer, llmCalls } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scores: { writer: { pass: true, tokens: 5, wallTimeMs: 5 } },
    })
    expect((await optimizer.optimize(request)).status).toBe('no-improvement')
    expect(optimizer.experiments(request.scopeId)[0]).toMatchObject({ scorerVersion: 1 })
    const spent = llmCalls()
    scorer.version = 2
    expect((await optimizer.optimize(request)).status).toBe('no-improvement')
    expect(llmCalls()).toBeGreaterThan(spent)
    expect(optimizer.experiments(request.scopeId)[0]).toMatchObject({ scorerVersion: 2 })
  })

  it('re-runs a recorded experiment when the guard is off or the evidence changed', async () => {
    const off = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scores: { writer: { pass: true, tokens: 5, wallTimeMs: 5 } },
      config: { skipRepeatedExperiments: false },
    })
    await off.optimizer.optimize(request)
    expect((await off.optimizer.optimize(request)).status).toBe('no-improvement')

    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scores: { writer: { pass: true, tokens: 5, wallTimeMs: 5 } },
    })
    await optimizer.optimize(request)
    expect((await optimizer.optimize({ ...request, evidence: 'new failures' })).status).toBe('no-improvement')
  })

  it('switches to the operator that produced nothing once a skill stagnates', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      config: { maxCandidates: 2, operators: ['rewrite', 'compress'], stagnationWindow: 1 },
      // The first run's rewrite yields a candidate and compress yields none;
      // the stagnant run draws from compress alone.
      llmBodies: [[V2], [], [V3]],
      scores: { writer: { pass: true, tokens: 5, wallTimeMs: 5 } },
    })
    const first = await optimizer.optimize(request)
    expect(first.status).toBe('no-improvement')
    expect(first.stagnant).toBe(false)
    expect(first.candidates.map(candidate => candidate.operator)).toEqual(['rewrite'])
    const second = await optimizer.optimize({ ...request, evidence: 'new failures' })
    expect(second.stagnant).toBe(true)
    expect(second.candidates.map(candidate => candidate.operator)).toEqual(['compress'])
  })

  it('keeps the configured lineup when the window already tried every operator', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      config: { maxCandidates: 2, operators: ['rewrite', 'compress'], stagnationWindow: 1 },
      llmBodies: [[V2], [V3], [V4], [V5]],
      scores: { writer: { pass: true, tokens: 5, wallTimeMs: 5 } },
    })
    await optimizer.optimize(request)
    const second = await optimizer.optimize({ ...request, evidence: 'new failures' })
    expect(second.stagnant).toBe(true)
    expect(second.candidates.map(candidate => candidate.operator)).toEqual(['rewrite', 'compress'])
  })

  it('neither remembers nor stagnates on a run that never evaluated', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      config: { stagnationWindow: 1 },
      skipEvaluation: 'the harness refused to run',
      skipOnCall: 0,
    })
    expect((await optimizer.optimize(request)).status).toBe('skipped')
    const second = await optimizer.optimize(request)
    expect(second.status).toBe('no-improvement')
    expect(second.stagnant).toBe(false)
  })

  it('records zero attempts for a run that measured no scenario', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scores: { writer: { pass: true, tokens: 5, wallTimeMs: 5 } },
    })
    expect((await optimizer.optimize({ ...request, scenarios: [] })).status).toBe('no-improvement')
    expect(optimizer.experiments(request.scopeId)[0]?.samples).toBe(0)
  })

  it('fails loud when the ledger domain was never opened', async () => {
    const ctx = new Context()
    roots.push(ctx)
    // Every seam the run resolves before it needs the ledger, so the missing
    // domain is what it reaches first.
    ctx.provide('evolutionScorer', { evaluateSkill: async () => ({}) } as never)
    ctx.provide('evolutionSkillTelemetry', { entries: () => [{ name: 'writer', usage: usage(12, 10) }] } as never)
    ctx.provide('evolutionMemory', { read: () => undefined, stageWrite: async () => ({ id: 'staged-0' }) } as never)
    ctx.provide('skills', { get: async () => ({ content: BASE }) } as never)
    ctx.provide('llm', { stream: () => textTurn('[]') } as never)
    const optimizer = new EvolutionOptimizer(ctx, {
      provider: 'deepseek',
      model: 'deepseek-chat',
      agent: { binScript: 'bin', configPath: 'cfg', tsconfigPath: 'tsconfig' },
    })
    await expect(optimizer.optimize(request)).rejects.toThrow('the experiments domain is not open')
  })

  it('orders the lineup by what repaired this failure before', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      config: {
        maxCandidates: 2,
        operators: ['rewrite', 'compress'],
        priorMinTries: 1,
        skipRepeatedExperiments: false,
      },
      llmBodies: [[skillBody('writer', '# rewrite a')], [skillBody('writer', '# compress a')], [skillBody('writer', '# compress b')], [skillBody('writer', '# rewrite b')]],
      // Run 1: rewrite's candidate loses to compress's; run 2 measures nothing new.
      scoresFor: (_scenarios, call) => ({
        pass: true,
        tokens: call === 1 ? 8 : call === 2 ? 3 : 10,
        wallTimeMs: 5,
      }),
    })
    const first = await optimizer.optimize(request)
    expect(first.status).toBe('staged')
    expect(first.candidates.map(candidate => candidate.operator)).toEqual(['rewrite', 'compress'])
    expect(optimizer.experiments(request.scopeId)[0]?.winnerOperator).toBe('compress')

    // The same failure mode: compress has won here, so it leads the lineup.
    const second = await optimizer.optimize(request)
    expect(second.candidates.map(candidate => candidate.operator)).toEqual(['compress', 'rewrite'])
  })

  it('leaves the lineup in configuration order below the prior threshold', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      config: {
        maxCandidates: 2,
        operators: ['rewrite', 'compress'],
        priorMinTries: 5,
        skipRepeatedExperiments: false,
      },
      llmBodies: [[skillBody('writer', '# rewrite a')], [skillBody('writer', '# compress a')], [skillBody('writer', '# rewrite b')], [skillBody('writer', '# compress b')]],
      scoresFor: (_scenarios, call) => ({
        pass: true,
        tokens: call === 1 ? 8 : call === 2 ? 3 : 10,
        wallTimeMs: 5,
      }),
    })
    expect((await optimizer.optimize(request)).status).toBe('staged')
    const second = await optimizer.optimize(request)
    expect(second.candidates.map(candidate => candidate.operator)).toEqual(['rewrite', 'compress'])
  })

  it('counts a failure mode by the shape of its evidence, not its counters', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      config: {
        maxCandidates: 2,
        operators: ['rewrite', 'compress'],
        priorMinTries: 1,
        skipRepeatedExperiments: false,
      },
      llmBodies: [[skillBody('writer', '# rewrite a')], [skillBody('writer', '# compress a')], [skillBody('writer', '# compress b')], [skillBody('writer', '# rewrite b')]],
      scoresFor: (_scenarios, call) => ({
        pass: true,
        tokens: call === 1 ? 8 : call === 2 ? 3 : 10,
        wallTimeMs: 5,
      }),
    })
    expect((await optimizer.optimize(request)).status).toBe('staged')
    // Counters moved, the failure did not: 11 failures over 204 loads is the
    // same surface as 3 failures over 20 recorded loads.
    const second = await optimizer.optimize({ ...request, evidence: '11 failures over 204 recorded loads' })
    expect(second.candidates.map(candidate => candidate.operator)).toEqual(['compress', 'rewrite'])
  })

  it('records which operators said something new and orders the next lineup by it', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: skillBody('writer', '# writer\nDo the thing.'),
      config: {
        maxCandidates: 2,
        operators: ['rewrite', 'compress'],
        priorMinTries: 1,
        skipRepeatedExperiments: false,
        stagnationWindow: 5,
      },
      // Run 1: rewrite restates the body, compress adds a rule it lacks.
      llmBodies: [
        [skillBody('writer', '# writer\nDO   THE thing.')],
        [skillBody('writer', '# writer\nDo the thing.\nRefuse unsafe paths.')],
        // Run 2's candidates reformat the body instead of adding to it: not a
        // duplicate of it byte-for-byte, and not novel in its lines either.
        [skillBody('writer', '# writer\nDO  the thing.')],
        [skillBody('writer', '# writer\nDo  THE thing.')],
      ],
      scoresFor: (_scenarios, call) => ({
        pass: true,
        tokens: call === 1 ? 8 : call === 2 ? 3 : 10,
        wallTimeMs: 5,
      }),
    })
    const first = await optimizer.optimize(request)
    expect(first.status).toBe('staged')
    expect(first.candidates.map(candidate => candidate.novelty)).toEqual([0, 1 / 3])
    const row = optimizer.experiments(request.scopeId)[0]
    expect(row?.winnerOperator).toBe('compress')
    // Only compress stated a line the starting body lacked.
    expect(row?.novelOperators).toEqual(['compress'])

    // Both operators lost here before; the one that at least said something new
    // leads the next lineup.
    const second = await optimizer.optimize(request)
    expect(second.candidates.map(candidate => candidate.operator)).toEqual(['compress', 'rewrite'])
  })

  it('filters the ledger by skill and honours the page size', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scores: { writer: { pass: true, tokens: 5, wallTimeMs: 5 } },
      config: { screenScenarioCount: 0 },
    })
    await optimizer.optimize(request)
    await optimizer.optimize({ ...request, skill: 'writer', evidence: 'second run' })
    const scope = request.scopeId
    expect(optimizer.experiments(scope)).toHaveLength(2)
    expect(optimizer.experiments(scope, { limit: 1 })).toHaveLength(1)
    expect(optimizer.experiments(scope, { skill: 'other' })).toHaveLength(0)
    expect(optimizer.experiments(EvolutionScopeId('profile', 'elsewhere'))).toHaveLength(0)
  })

  it('drops the oldest experiments beyond the retention cap', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      scores: { writer: { pass: true, tokens: 5, wallTimeMs: 5 } },
      config: { maxExperiments: 1 },
    })
    await optimizer.optimize(request)
    await optimizer.optimize({ ...request, evidence: 'second run' })
    const rows = optimizer.experiments(request.scopeId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.evidence).toBe('second run')
  })

  it('stages only a winner that repeats on every paired comparison', async () => {
    const { optimizer, staged, scoreCalls } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      config: { confirmationRuns: 2 },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call % 2 === 1 ? 4 : 10, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(scoreCalls).toHaveLength(4)
    expect(report.status).toBe('staged')
    expect(report.confidence).toEqual({ runs: 2, wins: 2 })
    expect(staged).toHaveLength(1)
  })

  it('refuses a winner that fails a confirmation comparison', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      config: { confirmationRuns: 2 },
      // The search comparison favours the variant; the repeat favours the baseline.
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 2 ? 1 : call === 1 ? 4 : 10, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('unconfirmed')
    expect(report.confidence).toEqual({ runs: 2, wins: 1 })
    expect(report.reason).toContain('repeated 1 of 2 paired comparisons')
    expect(staged).toHaveLength(0)
    expect(optimizer.experiments(request.scopeId)[0]).toMatchObject({
      outcome: 'unconfirmed',
      confidence: { runs: 2, wins: 1 },
      stagedId: null,
    })
  })

  it('stops when the budget is spent during confirmation', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      config: { confirmationRuns: 2, budgetTokens: 14 },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 ? 4 : 10, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('skipped')
    expect(report.truncated).toBe(true)
    expect(report.reason).toContain('spent during confirmation')
    expect(staged).toHaveLength(0)
  })

  it('propagates a confirmation skip without staging', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      config: { confirmationRuns: 2 },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 ? 4 : 10, wallTimeMs: 5 }),
      skipEvaluation: 'confirmation scenario gone',
      skipOnCall: 2,
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('skipped')
    expect(report.reason).toBe('confirmation scenario gone')
    expect(staged).toHaveLength(0)
  })

  it('propagates a winner confirmation skip without staging', async () => {
    const { optimizer } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      config: { confirmationRuns: 2 },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 ? 4 : 10, wallTimeMs: 5 }),
      skipEvaluation: 'winner confirmation unavailable',
      skipOnCall: 3,
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('skipped')
    expect(report.reason).toBe('winner confirmation unavailable')
  })

  it('reports a broken ledger instead of failing the promotion', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      brokenLedger: true,
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 ? 4 : 10, wallTimeMs: 5 }),
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('staged')
    expect(staged).toHaveLength(1)
  })

  it('propagates a holdout skip without staging', async () => {
    const { optimizer, staged } = await bench({
      record: { name: 'writer', usage: usage(12, 10) },
      body: BASE,
      mutations: [V2],
      config: { holdoutScenarios: ['h1'] },
      scoresFor: (_scenarios, call) => ({ pass: true, tokens: call === 1 ? 4 : 10, wallTimeMs: 5 }),
      skipEvaluation: 'holdout scenario gone',
      skipOnCall: 2,
    })
    const report = await optimizer.optimize(request)
    expect(report.status).toBe('skipped')
    expect(report.reason).toBe('holdout scenario gone')
    expect(staged).toHaveLength(0)
  })
})
