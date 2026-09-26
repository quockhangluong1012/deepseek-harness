/**
 * Behavior evaluation over skill candidates: the frontmatter contract gate,
 * positive/negative trigger-query routing through the real selector, and the
 * baseline-vs-candidate replay comparison with its early stop. Cheap gates
 * are covered as pure unit cases; the service suite drives replay through
 * scripted runners over a one-scenario on-disk corpus, so no gate pays for
 * a fresh process it never needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { captureWorkspaceSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import type { AgentUnderTest, RunOptions, RunResult } from '@deepseek-ai/dsh-session-snapshot'
import { buildSkillFile } from '@deepseek-ai/dsh-evolution-skill-manage'
import EvolutionScorer from '../src/index.ts'
import { checkBehaviorContract, checkBehaviorRouting, compareBehaviorReplay } from '../src/behavior.ts'
import type { BehaviorCatalogSkill, ScenarioRunner, SkillScore } from '../src/types.ts'

/** The composition the runners would boot; the scripted runners never read it. */
const AGENT: AgentUnderTest = { binScript: 'unused-bin', configPath: 'unused-cordis.yml', tsconfigPath: 'unused-tsconfig.json' }

const CANDIDATE = 'polish'

function validBody(): string {
  return buildSkillFile(CANDIDATE, 'Polishes prose.', 'Do it.')
}

/** Routing catalog: the candidate among distractors, with revision keys. */
const CATALOG: BehaviorCatalogSkill[] = [
  { name: CANDIDATE, text: 'polish prose drafts', revisionKey: 'r2', signal: { trusted: true, useCount: 3, failureCount: 0 } },
  { name: 'deploy', text: 'ships code to production', revisionKey: 'r1' },
  { name: 'release', text: 'ship code fast', revisionKey: 'r1' },
  { name: 'rollback', text: 'ship code safely', revisionKey: 'r1' },
]

let root = ''
let corpus = ''
let runs = 0

function scorer(): EvolutionScorer {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  return new EvolutionScorer(ctx, { corpusDir: corpus, attempts: 1 })
}

function offlineScorer(): EvolutionScorer {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  return new EvolutionScorer(ctx, { corpusDir: join(root, 'absent'), attempts: 1 })
}

async function scriptedRun(outcome: 'pass' | 'fail', options: RunOptions): Promise<RunResult> {
  runs += 1
  const cwd = await mkdtemp(join(root, 'attempt-'))
  if (options.workspaceDir !== undefined) await cp(options.workspaceDir, cwd, { recursive: true })
  if (outcome === 'pass') await writeFile(join(cwd, 'note.txt'), 'expected\n')
  const captured = await captureWorkspaceSnapshot(cwd)
  return {
    rawStdout: '',
    stderr: '',
    cwd,
    cwdAliases: [],
    initialWorkspace: captured,
    finalWorkspace: captured,
    sessionLogs: [],
  }
}

const passRunner: ScenarioRunner = (_script, options) => scriptedRun('pass', options)
const failRunner: ScenarioRunner = (_script, options) => scriptedRun('fail', options)

beforeEach(async () => {
  runs = 0
  root = await mkdtemp(join(tmpdir(), 'evolution-behavior-'))
  corpus = join(root, 'corpus')
  const files: Record<string, string> = {
    'input.json': '{ "steps": [] }',
    'session.jsonl': '',
    'workspace/note.txt': 'seed\n',
    'workspace.expected/note.txt': 'expected\n',
  }
  for (const [relative, content] of Object.entries(files)) {
    const target = join(corpus, 'edit', relative)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('checkBehaviorContract', () => {
  it('admits a committable body', () => {
    expect(checkBehaviorContract(CANDIDATE, validBody())).toEqual({ ok: true, issues: [] })
  })

  it('refuses a body without frontmatter', () => {
    expect(checkBehaviorContract(CANDIDATE, 'plain text')).toEqual({ ok: false, issues: ['body has no frontmatter'] })
  })

  it('refuses a body that renames the skill', () => {
    const verdict = checkBehaviorContract(CANDIDATE, buildSkillFile('other', 'Other skill.', 'Do it.'))
    expect(verdict).toEqual({ ok: false, issues: [`skill "${CANDIDATE}" frontmatter must keep name "${CANDIDATE}"`] })
  })
})

describe('checkBehaviorRouting', () => {
  it('routes positives inside the window and keeps negatives outside', () => {
    const gate = checkBehaviorRouting(CANDIDATE, CATALOG, ['polish prose'], ['ship code'], 3)
    expect(gate.ok).toBe(true)
    expect(gate.checks).toEqual([
      { query: 'polish prose', expected: 'route', rank: 1, ok: true },
      { query: 'ship code', expected: 'avoid', rank: 4, ok: true },
    ])
    expect(gate.revisions).toEqual([
      { name: 'polish', revisionKey: 'r2' },
      { name: 'deploy', revisionKey: 'r1' },
      { name: 'release', revisionKey: 'r1' },
      { name: 'rollback', revisionKey: 'r1' },
    ])
  })

  it('fails a positive the candidate misses and a negative it hijacks', () => {
    const missed = checkBehaviorRouting(CANDIDATE, CATALOG, ['ship code fast'], ['ship code'], 1)
    expect(missed.ok).toBe(false)
    expect(missed.checks[0]).toMatchObject({ expected: 'route', rank: 4, ok: false })
    const hijacked = checkBehaviorRouting(CANDIDATE, CATALOG, ['polish prose'], ['polish'], 3)
    expect(hijacked.ok).toBe(false)
    expect(hijacked.checks[1]).toMatchObject({ expected: 'avoid', rank: 1, ok: false })
  })

  it('refuses a catalog without the candidate and a non-positive window', () => {
    expect(() => checkBehaviorRouting('absent', CATALOG, ['x'], [], 3)).toThrow("needs the candidate 'absent'")
    expect(() => checkBehaviorRouting(CANDIDATE, CATALOG, ['x'], [], 0)).toThrow('positive integer')
    expect(() => checkBehaviorRouting(CANDIDATE, CATALOG, ['x'], [], 1.5)).toThrow('positive integer')
  })

  it('fails every positive when the candidate requires a skill outside the catalog', () => {
    const catalog = CATALOG.map(entry =>
      entry.name === CANDIDATE ? { ...entry, requires: ['missing-base'] as const } : entry)
    const gate = checkBehaviorRouting(CANDIDATE, catalog, ['polish prose'], ['ship code'], 3)
    expect(gate.ok).toBe(false)
    // Zero score sorts after every positive scorer, so the candidate ranks last.
    expect(gate.checks[0]).toMatchObject({ expected: 'route', rank: 4, ok: false })
  })

  it('keeps routing when the required skill is in the catalog', () => {
    const catalog = CATALOG.map(entry =>
      entry.name === CANDIDATE ? { ...entry, requires: ['deploy'] as const } : entry)
    const gate = checkBehaviorRouting(CANDIDATE, catalog, ['polish prose'], ['ship code'], 3)
    expect(gate.ok).toBe(true)
    expect(gate.checks[0]).toMatchObject({ expected: 'route', rank: 1, ok: true })
  })

  it('meets a prerequisite through a capability another catalog entry provides', () => {
    const catalog = CATALOG.map((entry) => {
      if (entry.name === CANDIDATE) return { ...entry, requires: ['prose-tooling'] as const }
      if (entry.name === 'deploy') return { ...entry, capabilities: ['prose-tooling'] as const }
      return entry
    })
    const gate = checkBehaviorRouting(CANDIDATE, catalog, ['polish prose'], ['ship code'], 3)
    expect(gate.ok).toBe(true)
    expect(gate.checks[0]).toMatchObject({ expected: 'route', rank: 1, ok: true })

    const withoutProvider = catalog.filter(entry => entry.name !== 'deploy')
    // A window narrower than the catalog, as the prerequisite case above: an
    // unroutable candidate ranking last can only fall outside a real window.
    const orphaned = checkBehaviorRouting(CANDIDATE, withoutProvider, ['polish prose'], [], 2)
    expect(orphaned.ok).toBe(false)
    // The capability is gone, so nothing satisfies the prerequisite and the candidate scores zero.
    expect(orphaned.checks[0]).toMatchObject({ expected: 'route', rank: 3, ok: false })
  })

  it('fails every positive when a better ranked catalog entry declares the conflict', () => {
    const catalog = CATALOG.map(entry =>
      entry.name === 'release' ? { ...entry, text: 'polish prose' } : entry)
    const clean = checkBehaviorRouting(CANDIDATE, catalog, ['polish prose', 'ship code'], [], 3)
    expect(clean.ok).toBe(true)
    expect(clean.checks[0]).toMatchObject({ expected: 'route', rank: 2, ok: true })

    const rival = catalog.map(entry =>
      entry.name === CANDIDATE ? { ...entry, conflictsWith: ['release'] as const } : entry)
    const gate = checkBehaviorRouting(CANDIDATE, rival, ['polish prose', 'ship code'], [], 3)
    expect(gate.ok).toBe(false)
    // The rival outranks the candidate, so the candidate is the excluded side and never routes.
    expect(gate.checks[0]).toMatchObject({ expected: 'route', rank: 4, ok: false })
  })
})

describe('compareBehaviorReplay', () => {
  function triple(pass: boolean, scenario: string): SkillScore {
    return {
      skill: CANDIDATE,
      pass,
      tokens: 10,
      wallTimeMs: 5,
      scores: [{
        scenario,
        pass,
        changes: [],
        tokens: 10,
        wallTimeMs: 5,
        samples: [5],
        fixtureDigest: 'test-fixture-digest',
        trajectory: null,
      }],
    }
  }

  it('approves parity on shared failures and improvements alike', () => {
    const parity = compareBehaviorReplay(triple(false, 's'), triple(false, 's'))
    expect(parity).toMatchObject({ ok: true, regressions: [], tokenDelta: 0 })
    const improved = compareBehaviorReplay(triple(false, 's'), triple(true, 's'))
    expect(improved.ok).toBe(true)
  })

  it('names scenarios the baseline passed that the candidate failed', () => {
    const regressed = compareBehaviorReplay(triple(true, 's'), triple(false, 's'))
    expect(regressed).toMatchObject({ ok: false, regressions: ['s'] })
  })
})

describe('EvolutionScorer.evaluateBehavior', () => {
  it('stops before replay when the contract gate fails', async () => {
    const evaluation = await offlineScorer().evaluateBehavior({
      baseline: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: failRunner },
      candidate: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: passRunner },
      candidateBody: { name: CANDIDATE, body: 'no frontmatter here' },
      catalog: CATALOG.slice(0, 2),
      positiveQueries: ['polish prose'],
      negativeQueries: ['ship code'],
      routingTopK: 1,
    })
    expect(evaluation.status).toBe('gated')
    if (evaluation.status !== 'gated') throw new Error('expected the evaluation to stop before replay')
    expect(evaluation.reason).toContain('contract gate failed')
    expect(evaluation.disagreement)
      .toEqual({ unanimous: false, approving: ['routing'], dissenting: ['contract'] })
    expect(runs).toBe(0)
  })

  it('stops before replay when the routing gate fails', async () => {
    const evaluation = await offlineScorer().evaluateBehavior({
      baseline: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: failRunner },
      candidate: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: passRunner },
      candidateBody: { name: CANDIDATE, body: validBody() },
      catalog: CATALOG.slice(0, 2),
      positiveQueries: ['ship code'],
      negativeQueries: ['ship code fast'],
      routingTopK: 1,
    })
    expect(evaluation.status).toBe('gated')
    if (evaluation.status !== 'gated') throw new Error('expected the evaluation to stop before replay')
    expect(evaluation.reason).toBe('routing gate failed')
    expect(evaluation.disagreement)
      .toEqual({ unanimous: false, approving: ['contract'], dissenting: ['routing'] })
    expect(runs).toBe(0)
  })

  it('skips when a replay composition names no scenarios', async () => {
    const baselineSkipped = await offlineScorer().evaluateBehavior({
      baseline: { skill: CANDIDATE, scenarios: [], agent: AGENT, run: failRunner },
      candidate: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: passRunner },
      candidateBody: { name: CANDIDATE, body: validBody() },
      catalog: CATALOG.slice(0, 2),
      positiveQueries: ['polish prose'],
      negativeQueries: ['ship code'],
      routingTopK: 1,
    })
    expect(baselineSkipped.status).toBe('skipped')
    expect(runs).toBe(0)
    runs = 0
    const candidateSkipped = await scorer().evaluateBehavior({
      baseline: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: failRunner },
      candidate: { skill: CANDIDATE, scenarios: [], agent: AGENT, run: passRunner },
      candidateBody: { name: CANDIDATE, body: validBody() },
      catalog: CATALOG.slice(0, 2),
      positiveQueries: ['polish prose'],
      negativeQueries: ['ship code'],
      routingTopK: 1,
    })
    expect(candidateSkipped.status).toBe('skipped')
    expect(runs).toBe(1)
  })

  it('approves a candidate that regresses nothing the baseline proved', async () => {
    const evaluation = await scorer().evaluateBehavior({
      baseline: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: failRunner },
      candidate: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: passRunner },
      candidateBody: { name: CANDIDATE, body: validBody() },
      catalog: CATALOG,
      positiveQueries: ['polish prose'],
      negativeQueries: ['ship code'],
    })
    expect(evaluation.status).toBe('evaluated')
    if (evaluation.status !== 'evaluated') throw new Error('expected a full evaluation')
    expect(evaluation.approved).toBe(true)
    expect(evaluation.disagreement)
      .toEqual({ unanimous: true, approving: ['contract', 'routing', 'replay'], dissenting: [] })
    expect(evaluation.replay.regressions).toEqual([])
    expect(evaluation.replay.tokenDelta).toBe(0)
    expect(runs).toBe(2)
  })

  it('rejects a candidate that regresses the baseline', async () => {
    const evaluation = await scorer().evaluateBehavior({
      baseline: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: passRunner },
      candidate: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: failRunner },
      candidateBody: { name: CANDIDATE, body: validBody() },
      catalog: CATALOG,
      positiveQueries: ['polish prose'],
      negativeQueries: ['ship code'],
    })
    expect(evaluation.status).toBe('evaluated')
    if (evaluation.status !== 'evaluated') throw new Error('expected a full evaluation')
    expect(evaluation.approved).toBe(false)
    expect(evaluation.replay.regressions).toEqual(['edit'])
    // Routing approved a candidate replay rejects: the split names replay,
    // the uncertainty signal a future investigation queue would read.
    expect(evaluation.disagreement)
      .toEqual({ unanimous: false, approving: ['contract', 'routing'], dissenting: ['replay'] })
  })

  it('records gated and evaluated verdicts into the mounted health store', async () => {
    const health: { runs: Record<string, unknown>[]; error?: Error } = { runs: [] }
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    new TokenMeter(ctx)
    ctx.provide('evolutionEvaluatorHealth', {
      observe: async (input: Record<string, unknown>) => {
        if (health.error !== undefined) throw health.error
        health.runs.push(input)
        return { id: 'r', ...input }
      },
    } as never)
    const mounted = new EvolutionScorer(ctx, { corpusDir: corpus, attempts: 1 })

    const gated = await mounted.evaluateBehavior({
      baseline: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: failRunner },
      candidate: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: passRunner },
      candidateBody: { name: CANDIDATE, body: 'no frontmatter here' },
      catalog: CATALOG.slice(0, 2),
      positiveQueries: ['polish prose'],
      negativeQueries: ['ship code'],
      routingTopK: 1,
    })
    expect(gated.status).toBe('gated')
    expect(health.runs[0]).toMatchObject({
      skill: CANDIDATE,
      status: 'gated',
      approved: false,
      unanimous: false,
      approving: ['routing'],
      dissenting: ['contract'],
    })

    const evaluated = await mounted.evaluateBehavior({
      baseline: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: failRunner },
      candidate: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: passRunner },
      candidateBody: { name: CANDIDATE, body: validBody() },
      catalog: CATALOG,
      positiveQueries: ['polish prose'],
      negativeQueries: ['ship code'],
    })
    expect(evaluated.status).toBe('evaluated')
    expect(health.runs[1]).toMatchObject({
      skill: CANDIDATE,
      status: 'evaluated',
      approved: true,
      unanimous: true,
      approving: ['contract', 'routing', 'replay'],
      dissenting: [],
    })
    expect(runs).toBe(2)
  })

  it('survives a failing health store with a warning', async () => {
    const health: { runs: Record<string, unknown>[]; error?: Error } = { runs: [] }
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    new TokenMeter(ctx)
    ctx.provide('evolutionEvaluatorHealth', {
      observe: async (input: Record<string, unknown>) => {
        if (health.error !== undefined) throw health.error
        health.runs.push(input)
        return { id: 'r', ...input }
      },
    } as never)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const mounted = new EvolutionScorer(ctx, { corpusDir: corpus, attempts: 1 })
    health.error = new Error('health disk on fire')
    try {
      const evaluation = await mounted.evaluateBehavior({
        baseline: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: failRunner },
        candidate: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: passRunner },
        candidateBody: { name: CANDIDATE, body: validBody() },
        catalog: CATALOG,
        positiveQueries: ['polish prose'],
        negativeQueries: ['ship code'],
      })
      expect(evaluation.status).toBe('evaluated')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record evaluator health'))
    } finally {
      warn.mockRestore()
    }
  })

  it('records a disagreement signal into the mounted uncertainty store', async () => {
    const signals: Record<string, unknown>[] = []
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    new TokenMeter(ctx)
    ctx.provide('evolutionUncertainty', {
      record: async (input: Record<string, unknown>) => {
        signals.push(input)
        return { signalId: input.signalId as string, ...input, at: '' }
      },
    } as never)
    const mounted = new EvolutionScorer(ctx, { corpusDir: corpus, attempts: 1 })

    // A split verdict names the dissenting channel as a disagreement signal.
    const gated = await mounted.evaluateBehavior({
      baseline: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: failRunner },
      candidate: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: passRunner },
      candidateBody: { name: CANDIDATE, body: 'no frontmatter here' },
      catalog: CATALOG.slice(0, 2),
      positiveQueries: ['polish prose'],
      negativeQueries: ['ship code'],
      routingTopK: 1,
    })
    expect(gated.status).toBe('gated')
    expect(signals[0]).toMatchObject({
      skill: CANDIDATE,
      taskId: null,
      kind: 'disagreement',
      score: 0.5,
    })
    expect(String(signals[0]?.detail)).toContain('contract dissenting')

    // A unanimous verdict produces no signal.
    const evaluated = await mounted.evaluateBehavior({
      baseline: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: failRunner },
      candidate: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: passRunner },
      candidateBody: { name: CANDIDATE, body: validBody() },
      catalog: CATALOG,
      positiveQueries: ['polish prose'],
      negativeQueries: ['ship code'],
    })
    expect(evaluated.status).toBe('evaluated')
    expect(signals).toHaveLength(1)
    expect(runs).toBe(2)
  })

  it('survives a failing uncertainty store with a warning', async () => {
    const uncertainty: { error?: Error } = {}
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    new TokenMeter(ctx)
    ctx.provide('evolutionUncertainty', {
      record: async () => {
        if (uncertainty.error !== undefined) throw uncertainty.error
        return { signalId: 's', at: '' }
      },
    } as never)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const mounted = new EvolutionScorer(ctx, { corpusDir: corpus, attempts: 1 })
    uncertainty.error = new Error('uncertainty disk on fire')
    try {
      const evaluation = await mounted.evaluateBehavior({
        baseline: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: failRunner },
        candidate: { skill: CANDIDATE, scenarios: ['edit'], agent: AGENT, run: passRunner },
        candidateBody: { name: CANDIDATE, body: 'no frontmatter here' },
        catalog: CATALOG.slice(0, 2),
        positiveQueries: ['polish prose'],
        negativeQueries: ['ship code'],
        routingTopK: 1,
      })
      expect(evaluation.status).toBe('gated')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record uncertainty signal'))
    } finally {
      warn.mockRestore()
    }
  })
})
