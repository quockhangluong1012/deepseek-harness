/**
 * Scorer behaviour over a corpus built on disk: the arithmetic itself is
 * covered by `score.spec.ts`, so this suite drives the service the way a host
 * does — a scenario plan, a fresh-process runner per attempt, and token
 * accounting through the real `ctx.tokenMeter`. The runner is a recorded fake
 * because booting a real ACP subprocess is the snapshot suites' own tier; every
 * observable the scorer reports still comes from a real recorded fixture, real
 * workspace captures, and the real meter.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { captureWorkspaceSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import type { AgentUnderTest, RunOptions, RunResult } from '@deepseek-ai/dsh-session-snapshot'
import EvolutionScorer, { resolveConfig } from '../src/index.ts'
import { loadScenarioPlan } from '../src/scenario.ts'
import type { ScenarioRunner } from '../src/types.ts'

/**
 * A recorded turn whose provider usage is 3091 input + 23 output tokens — the
 * billed number the meter must report for this run.
 */
const RECORDED_FIXTURE = fileURLToPath(new URL(
  '../../../../snapshots/session/text-turn/session.v1.jsonl',
  import.meta.url,
))
const RECORDED_USAGE_TOKENS = 3114

/** The composition the runner would boot; the fake runner never reads it. */
const AGENT: AgentUnderTest = { binScript: 'unused-bin', configPath: 'unused-cordis.yml', tsconfigPath: 'unused-tsconfig.json' }

let root = ''
let corpus = ''
const calls: RunOptions[] = []

function scorer(attempts: number): EvolutionScorer {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  return new EvolutionScorer(ctx, { corpusDir: corpus, attempts })
}

/**
 * The process-level runner stand-in: harvest the fixture the plan resolved into
 * a fresh cwd seeded from the scenario's workspace, and report the captures the
 * snapshot harness would report.
 */
const fakeRunner: ScenarioRunner = async (_script, options): Promise<RunResult> => {
  calls.push(options)
  const cwd = await mkdtemp(join(root, 'attempt-'))
  if (options.workspaceDir !== undefined) await cp(options.workspaceDir, cwd, { recursive: true })
  const captured = await captureWorkspaceSnapshot(cwd)
  return {
    rawStdout: '',
    stderr: '',
    cwd,
    cwdAliases: [],
    initialWorkspace: captured,
    finalWorkspace: captured,
    sessionLogs: [{ id: 'recorded', createdAt: 1, content: await readFile(options.fixtureFile, 'utf8') }],
  }
}

/** The on-disk corpus every case scores against. */
const SCENARIOS = {
  'text-turn': {
    'input.json': '{ "steps": [] }',
    'session.v2.jsonl': '',
    'session.1.jsonl': '',
    'replay.override.json': '[]',
    'workspace/note.txt': 'seed\n',
    'workspace.expected/note.txt': 'seed\n',
  },
  'workspace-edit': {
    'input.json': '{ "steps": [] }',
    'session.jsonl': '',
    'workspace/note.txt': 'seed\n',
    'workspace.expected/note.txt': 'expected\n',
  },
  'read-only': {
    'input.json': '{ "steps": [] }',
    'session.jsonl': '',
  },
} as const

beforeEach(async () => {
  calls.length = 0
  root = await mkdtemp(join(tmpdir(), 'evolution-scorer-'))
  corpus = join(root, 'corpus')
  const recorded = await readFile(RECORDED_FIXTURE, 'utf8')
  for (const [scenario, files] of Object.entries(SCENARIOS)) {
    for (const [relative, content] of Object.entries(files)) {
      const target = join(corpus, scenario, relative)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, relative.endsWith('.jsonl') ? recorded : content)
    }
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('EvolutionScorer', () => {
  it('scores a scenario from its expected workspace and the meter, one fresh attempt per run', async () => {
    const outcome = await scorer(2).score({ scenario: 'text-turn', agent: AGENT, run: fakeRunner })
    expect(outcome.status).toBe('scored')
    if (outcome.status !== 'scored') throw new Error(`expected a score, got a skip: ${outcome.reason}`)
    expect(outcome.score).toMatchObject({
      scenario: 'text-turn',
      pass: true,
      changes: [],
      tokens: RECORDED_USAGE_TOKENS,
    })
    expect(outcome.score.samples).toHaveLength(2)
    expect(outcome.score.wallTimeMs).toBeGreaterThanOrEqual(Math.min(...outcome.score.samples))
    expect(outcome.score.wallTimeMs).toBeLessThanOrEqual(Math.max(...outcome.score.samples))
    expect(calls.map(call => call.mode)).toEqual(['replay', 'replay'])
  })

  it('overrides the configured attempt count for one call (S9 tier gate)', async () => {
    calls.length = 0
    const outcome = await scorer(3).score({ scenario: 'text-turn', agent: AGENT, run: fakeRunner, attempts: 1 })
    expect(outcome.status).toBe('scored')
    if (outcome.status !== 'scored') throw new Error(`expected a score, got a skip: ${outcome.reason}`)
    expect(outcome.score.samples).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it('captures the recorded fixture digest and the first attempt\'s session as the trajectory (§24.3)', async () => {
    const outcome = await scorer(1).score({ scenario: 'text-turn', agent: AGENT, run: fakeRunner })
    expect(outcome.status).toBe('scored')
    if (outcome.status !== 'scored') throw new Error(`expected a score, got a skip: ${outcome.reason}`)
    expect(outcome.score.trajectory).toBe('recorded')
    const planned = await loadScenarioPlan(corpus, 'text-turn')
    if (planned.status !== 'planned') throw new Error('expected a plan')
    const digest = createHash('sha256')
    for (const file of [planned.plan.fixtureFile, ...planned.plan.childFiles]) digest.update(await readFile(file))
    expect(outcome.score.fixtureDigest).toBe(digest.digest('hex'))
    // read-only ships one recorded fixture where text-turn ships two, so even
    // though every fixture holds the same recorded bytes the digests differ.
    const other = await scorer(1).score({ scenario: 'read-only', agent: AGENT, run: fakeRunner })
    if (other.status !== 'scored') throw new Error('expected a score')
    expect(other.score.fixtureDigest).not.toBe(outcome.score.fixtureDigest)
  })

  it('forwards the per-call attempt override to every scenario in a skill evaluation', async () => {
    calls.length = 0
    const evaluation = await scorer(3).evaluateSkill({
      skill: 'writer',
      scenarios: ['text-turn', 'read-only'],
      agent: AGENT,
      run: fakeRunner,
      attempts: 1,
    })
    expect(evaluation.status).toBe('evaluated')
    expect(calls).toHaveLength(2)
  })

  it('fails the score when the attempt diverges from workspace.expected', async () => {
    const outcome = await scorer(1).score({ scenario: 'workspace-edit', agent: AGENT, run: fakeRunner })
    expect(outcome).toMatchObject({
      status: 'scored',
      score: { pass: false, changes: [{ path: 'note.txt', kind: 'changed' }] },
    })
  })

  it('falls back to each attempt\'s own initial workspace when the scenario ships no expectation', async () => {
    const outcome = await scorer(1).score({ scenario: 'read-only', agent: AGENT, run: fakeRunner })
    expect(outcome).toMatchObject({
      status: 'scored',
      score: { scenario: 'read-only', pass: true, changes: [], tokens: RECORDED_USAGE_TOKENS },
    })
  })

  it('reports a skip without running anything when the scenario is not in the corpus', async () => {
    const outcome = await scorer(1).score({ scenario: 'absent', agent: AGENT, run: fakeRunner })
    expect(outcome).toEqual({
      status: 'skipped',
      scenario: 'absent',
      reason: "scenario 'absent' is not in the corpus",
    })
    expect(calls).toEqual([])
  })

  it('defaults to three attempts when the configuration names only the corpus', () => {
    expect(resolveConfig({ corpusDir: corpus })).toEqual({
      corpusDir: corpus,
      attempts: 3,
      triggerMinUses: 20,
      triggerFailureRate: 0.3,
    })
  })

  it('aggregates one skill over every scenario into the optimizer triple', async () => {
    const evaluation = await scorer(1).evaluateSkill({
      skill: 'writer',
      scenarios: ['text-turn', 'read-only'],
      agent: AGENT,
      run: fakeRunner,
    })
    expect(evaluation.status).toBe('evaluated')
    if (evaluation.status !== 'evaluated') throw new Error('expected an evaluation')
    expect(evaluation.score).toMatchObject({
      skill: 'writer',
      pass: true,
      tokens: RECORDED_USAGE_TOKENS * 2,
    })
    expect(evaluation.score.scores.map(record => record.scenario)).toEqual(['text-turn', 'read-only'])
  })

  it('fails the skill without failing the evaluation when one scenario diverges', async () => {
    const evaluation = await scorer(1).evaluateSkill({
      skill: 'writer',
      scenarios: ['text-turn', 'workspace-edit'],
      agent: AGENT,
      run: fakeRunner,
    })
    expect(evaluation).toMatchObject({ status: 'evaluated', score: { skill: 'writer', pass: false } })
  })

  it('skips the whole evaluation when one scenario cannot be scored', async () => {
    const evaluation = await scorer(1).evaluateSkill({
      skill: 'writer',
      scenarios: ['text-turn', 'absent'],
      agent: AGENT,
      run: fakeRunner,
    })
    expect(evaluation).toEqual({
      status: 'skipped',
      skill: 'writer',
      reason: "scenario 'absent' is not in the corpus",
    })
  })

  it('skips a skill that names no evaluation scenarios', async () => {
    const evaluation = await scorer(1).evaluateSkill({ skill: 'writer', scenarios: [], agent: AGENT, run: fakeRunner })
    expect(evaluation).toEqual({
      status: 'skipped',
      skill: 'writer',
      reason: "skill 'writer' names no evaluation scenarios",
    })
  })
})
