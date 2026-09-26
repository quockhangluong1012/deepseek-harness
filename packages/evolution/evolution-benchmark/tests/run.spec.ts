/**
 * The benchmark run pass (`ctx.evolutionBenchmark.run`): one durable outcome
 * per executed task, the §13.5 facts read from the run's own harvested
 * sessions, and the failure and cap paths. The runner is a recorded stand-in
 * for the fresh-process seam `evolution-scorer` scores through, so every number
 * a case asserts still comes from a real recorded fixture and the real token
 * meter; booting a real ACP subprocess is the snapshot suites' own tier.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { captureWorkspaceSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import type { AgentUnderTest, RunOptions, RunResult, WorkspaceSnapshotEntry } from '@deepseek-ai/dsh-session-snapshot'
import type { ScenarioRunner } from '@deepseek-ai/dsh-evolution-scorer'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionBenchmark, { datasetInputs, HORIZON_TIERS, loadDatasets } from '../src/index.ts'
import type { BenchmarkInput } from '../src/index.ts'

/** The shipped §5.3 corpus, as a run pass enumerates it. */
const datasetRoot = fileURLToPath(new URL('../datasets/', import.meta.url))

/** The composition the runner would boot; the recorded stand-in never reads it. */
const AGENT: AgentUnderTest = { binScript: 'unused-bin', configPath: 'unused-cordis.yml', tsconfigPath: 'unused-tsconfig.json' }

/** A settled turn whose provider usage is 3091 input + 23 output tokens. */
const TEXT_TURN = fileURLToPath(new URL('../../../../snapshots/session/text-turn/session.v1.jsonl', import.meta.url))
const TEXT_TURN_TOKENS = 3114

/** A turn that reports a 128000-token context window and closes one task. */
const CONTEXT_WINDOW = fileURLToPath(new URL('../../../../snapshots/session/compaction-recovery/session.v5.jsonl', import.meta.url))
const REPORTED_CONTEXT_WINDOW = 128_000

/** A turn that records one failure and answers it with one recovery decision. */
const RECOVERED_FAILURE = fileURLToPath(new URL('../../../../snapshots/session/repeat-tool-reminder/session.v5.jsonl', import.meta.url))

let root = ''
let recorded = ''

async function boot(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  const fiber = await ctx.plugin(EvolutionBenchmark, config)
  return { ctx, fiber, store: ctx.evolutionBenchmark }
}

/**
 * The fresh-process runner stand-in: harvest the fixture it was built with and
 * report the captures the snapshot harness would report for a cwd seeded from
 * the given directory.
 * @param fixture - absolute recorded session fixture the attempt harvests.
 * @param workspace - absolute directory copied into the attempt's cwd first.
 * @returns a runner that never spawns a process.
 */
function recordedRunner(fixture: string, workspace?: string): ScenarioRunner {
  return async (): Promise<RunResult> => {
    const cwd = await mkdtemp(join(root, 'attempt-'))
    if (workspace !== undefined) await cp(workspace, cwd, { recursive: true })
    const captured = await captureWorkspaceSnapshot(cwd)
    return {
      rawStdout: '',
      stderr: '',
      cwd,
      cwdAliases: [],
      initialWorkspace: captured,
      finalWorkspace: captured,
      sessionLogs: [{ id: 'recorded', createdAt: 1, content: await readFile(fixture, 'utf8') }],
    }
  }
}

/** The wiring one run is booted with, naming the fixture the runner harvests. */
function wiring(fixture: string): RunOptions {
  return { agent: AGENT, mode: 'replay', fixtureFile: fixture }
}

/** One admitted task, as a producer states it. */
function input(task: string, capability = 'writer'): BenchmarkInput {
  return {
    capability,
    task,
    gists: [],
    sourceSessions: [],
    profile: 'coding',
    family: 'coding',
    stepSpan: 10,
    acceptance: 'the task observable holds',
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'benchmark-run-'))
  recorded = join(root, 'workspaces')
  await mkdir(join(recorded, 'expected'), { recursive: true })
  await mkdir(join(recorded, 'diverged'), { recursive: true })
  await writeFile(join(recorded, 'expected', 'note.txt'), 'expected\n')
  await writeFile(join(recorded, 'diverged', 'note.txt'), 'actual\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('evolution benchmark run pass', () => {
  it('executes every task of an enumerated dataset and records one outcome per task', async () => {
    const { fiber, store } = await boot()
    try {
      const datasets = await loadDatasets(datasetRoot)
      const longHorizon = datasets.find(dataset => dataset.family === 'long-horizon')
      if (longHorizon === undefined) throw new Error('the long-horizon dataset is not shipped')
      const { admitted } = await store.admit(datasetInputs([longHorizon]))

      const report = await store.run({
        tasks: admitted,
        options: wiring(TEXT_TURN),
        run: recordedRunner(TEXT_TURN),
      })

      expect(report.outcomes).toHaveLength(admitted.length)
      expect(report.deferred).toBe(0)
      expect(report.scored).toBe(admitted.length)
      expect(report.passed).toBe(admitted.length)
      // The corpus states every §13.5 horizon, and each outcome carries the
      // tier its task's own step span reaches.
      const tiers = new Set(report.outcomes.map(outcome => outcome.tier))
      for (const tier of HORIZON_TIERS) expect(tiers.has(tier)).toBe(true)
      for (const outcome of report.outcomes) {
        expect(outcome).toMatchObject({
          status: 'scored',
          pass: true,
          attempts: 1,
          tokens: TEXT_TURN_TOKENS,
          trajectory: 'recorded',
          sessionIds: ['recorded'],
        })
      }
      // The row is durable, not a report the pass forgets.
      expect(store.outcomes().map(outcome => outcome.id).sort())
        .toEqual(report.outcomes.map(outcome => outcome.id).sort())
    } finally {
      await fiber.dispose()
    }
  })

  it('caps the pass at maxTasks and reports the rest as deferred', async () => {
    const { fiber, store } = await boot({ maxTasks: 1 })
    try {
      const { admitted } = await store.admit([input('first task'), input('second task')])

      const report = await store.run({
        tasks: admitted,
        options: wiring(TEXT_TURN),
        run: recordedRunner(TEXT_TURN),
      })

      expect(report.outcomes).toHaveLength(1)
      expect(report.deferred).toBe(1)
      expect(store.outcomes()).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('records a run that failed before a verdict and keeps going with the next task', async () => {
    const { fiber, store } = await boot()
    try {
      const { admitted } = await store.admit([input('the runner rejects this'), input('the runner answers this')])
      let attempts = 0
      const flaky: ScenarioRunner = async (script, options) => {
        attempts += 1
        if (attempts === 1) throw new Error('the runner subprocess died')
        return await recordedRunner(TEXT_TURN)(script, options)
      }

      const report = await store.run({ tasks: admitted, options: wiring(TEXT_TURN), run: flaky })

      expect(report.failed).toBe(1)
      expect(report.scored).toBe(1)
      expect(report.outcomes).toHaveLength(2)
      expect(report.outcomes[0]).toMatchObject({
        status: 'failed',
        pass: false,
        reason: 'the runner subprocess died',
        attempts: 0,
        tokens: 0,
        wallTimeMs: 0,
        samples: [],
        changes: [],
        trajectory: null,
      })
      expect(report.outcomes[1]).toMatchObject({ status: 'scored', pass: true, tokens: TEXT_TURN_TOKENS })
    } finally {
      await fiber.dispose()
    }
  })

  it('reads the §13.5 facts and the context pressure from the run\'s harvested sessions', async () => {
    const { fiber, store } = await boot()
    try {
      const { admitted } = await store.admit([
        input('walk one task to completion', 'task-closure'),
        input('recover from the recorded failure', 'recorded-recovery'),
      ])
      const runners = [recordedRunner(CONTEXT_WINDOW), recordedRunner(RECOVERED_FAILURE)]
      let index = 0
      const runner: ScenarioRunner = (script, options) => {
        const next = runners[index]
        index += 1
        if (next === undefined) throw new Error('the pass executed more tasks than the fixture list holds')
        return next(script, options)
      }

      const report = await store.run({ tasks: admitted, options: wiring(CONTEXT_WINDOW), run: runner })

      // `compaction-recovery` starts two steps and carries one task to
      // `completed`; the occupancy the projection publishes is prompt-side, so
      // it never exceeds the window the same session reported.
      expect(report.outcomes[0]).toMatchObject({
        steps: 2,
        tasksClosed: 1,
        tasksCompleted: 1,
        failures: 0,
        failuresAnswered: 0,
        contextWindow: REPORTED_CONTEXT_WINDOW,
      })
      expect(report.outcomes[0]?.contextTokens).toBeGreaterThan(0)
      expect(report.outcomes[0]?.contextTokens).toBeLessThanOrEqual(REPORTED_CONTEXT_WINDOW)
      // `repeat-tool-reminder` records one failure and the decision that answers it.
      expect(report.outcomes[1]).toMatchObject({
        steps: 5,
        tasksCompleted: 1,
        failures: 1,
        failuresAnswered: 1,
      })
    } finally {
      await fiber.dispose()
    }
  })

  it('counts the verifications the run recorded, the §13.5 process-discipline input', async () => {
    const { fiber, store } = await boot()
    try {
      const { admitted } = await store.admit([input('verify before completing', 'verified-completion')])
      // No shipped fixture carries a `verification/result`, so the recorded turn
      // gets one appended: the reading is the kernel's own counter over the log.
      const log = join(root, 'verified.jsonl')
      await writeFile(log, `${await readFile(RECOVERED_FAILURE, 'utf8')}${JSON.stringify({
        type: 'verification/result',
        data: {
          taskId: 't1',
          revision: 1,
          status: 'pass',
          criterionResults: [{ criterionId: 'c1', status: 'pass', evidence: [] }],
          commands: [],
          verifierVersion: 'spec',
        },
      })}\n`)

      const report = await store.run({ tasks: admitted, options: wiring(log), run: recordedRunner(log) })

      expect(report.outcomes[0]).toMatchObject({
        status: 'scored',
        verifications: 1,
        verificationsPassed: 1,
        failures: 1,
        failuresAnswered: 1,
      })
    } finally {
      await fiber.dispose()
    }
  })

  it('fails a task whose workspace diverged from the expected observable and names the paths', async () => {
    const { fiber, store } = await boot()
    try {
      const { admitted } = await store.admit([input('a task that mutates the workspace')])
      const expected: readonly WorkspaceSnapshotEntry[] = await captureWorkspaceSnapshot(join(recorded, 'expected'))

      const report = await store.run({
        tasks: admitted,
        options: wiring(TEXT_TURN),
        run: recordedRunner(TEXT_TURN, join(recorded, 'diverged')),
        expected: () => expected,
      })

      expect(report.outcomes[0]).toMatchObject({
        status: 'scored',
        pass: false,
        changes: [{ path: 'note.txt', kind: 'changed' }],
      })
      expect(report.passed).toBe(0)
    } finally {
      await fiber.dispose()
    }
  })

  it('records nothing and runs nothing for an empty task list', async () => {
    const { fiber, store } = await boot()
    try {
      let calls = 0
      const runner: ScenarioRunner = async (script, options) => {
        calls += 1
        return await recordedRunner(TEXT_TURN)(script, options)
      }

      const report = await store.run({ tasks: [], options: wiring(TEXT_TURN), run: runner })

      expect(report).toEqual({ outcomes: [], scored: 0, passed: 0, failed: 0, deferred: 0 })
      expect(calls).toBe(0)
      expect(store.outcomes()).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })
})
