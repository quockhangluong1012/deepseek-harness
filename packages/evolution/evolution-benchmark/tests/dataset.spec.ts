import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionBenchmark, { benchmarkTaskRow, datasetInputs, HORIZON_TIERS, horizonTier, loadDatasets } from '../src/index.ts'
import type { BenchmarkInput } from '../src/index.ts'
import type { TaskFamily, TaskProfile } from '@deepseek-ai/dsh-evolution-curriculum'

/** The shipped datasets, as a runner enumerates them. */
const datasetRoot = fileURLToPath(new URL('../datasets/', import.meta.url))

const FAMILIES: readonly TaskFamily[] = ['coding', 'research', 'mentor-ict', 'long-horizon', 'loop-recovery']
const PROFILES: readonly TaskProfile[] = ['coding', 'research', 'mentor', 'ict']

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

describe('evolution benchmark datasets', () => {
  it('ships one non-empty dataset per §5.3 family, each definition complete', async () => {
    const datasets = await loadDatasets(datasetRoot)
    // Datasets come back ordered by family name.
    expect(datasets.map(dataset => dataset.family)).toEqual([...FAMILIES].sort())
    for (const dataset of datasets) {
      expect(dataset.runRequirement).toBe('live-model')
      expect(dataset.tasks.length).toBeGreaterThan(0)
      for (const task of dataset.tasks) {
        expect(task.task).not.toBe('')
        expect(task.acceptance).not.toBe('')
        expect(task.capability).not.toBe('')
        expect(task.stepSpan).toBeGreaterThanOrEqual(1)
        expect(PROFILES).toContain(task.profile)
      }
    }
  })

  it('covers all four §3 profiles across the corpus', async () => {
    const datasets = await loadDatasets(datasetRoot)
    const covered = new Set(datasets.flatMap(dataset => dataset.tasks.map(task => task.profile)))
    expect([...covered].sort()).toEqual([...PROFILES].sort())
  })

  it('spans the four §13.5 horizon tiers, the long-horizon family alone among them', async () => {
    const datasets = await loadDatasets(datasetRoot)
    const longHorizon = datasets.find(dataset => dataset.family === 'long-horizon')
    if (longHorizon === undefined) throw new Error('the long-horizon dataset is not shipped')
    // Every long-horizon task reaches a tier, and the four are all represented.
    expect(new Set(longHorizon.tasks.map(task => horizonTier(task.stepSpan)))).toEqual(new Set(HORIZON_TIERS))
    const corpusTiers = new Set(datasets.flatMap(dataset => dataset.tasks.map(task => horizonTier(task.stepSpan))))
    for (const tier of HORIZON_TIERS) expect(corpusTiers.has(tier)).toBe(true)
  })

  it('names the highest tier a step span reaches and none below the lowest', () => {
    expect(horizonTier(9)).toBeUndefined()
    expect(horizonTier(10)).toBe(10)
    expect(horizonTier(30)).toBe(20)
    expect(horizonTier(99)).toBe(50)
    expect(horizonTier(100)).toBe(100)
    expect(horizonTier(500)).toBe(100)
  })

  it('admits every dataset definition with its profile, family, and horizon', async () => {
    const datasets = await loadDatasets(datasetRoot)
    const inputs: BenchmarkInput[] = datasetInputs(datasets)
    const { fiber, store } = await boot({ maxAdmit: inputs.length })
    try {
      const { admitted, duplicates } = await store.admit(inputs)
      expect(duplicates).toEqual([])
      expect(admitted).toHaveLength(inputs.length)
      const stored = new Map(store.tasks().map(task => [task.task, task]))
      for (const dataset of datasets) {
        for (const task of dataset.tasks) {
          expect(stored.get(task.task)).toMatchObject({
            capability: task.capability,
            profile: task.profile,
            family: dataset.family,
            stepSpan: task.stepSpan,
            acceptance: task.acceptance,
            gists: [],
            sourceSessions: [],
            state: 'fresh',
          })
        }
      }
    } finally {
      await fiber.dispose()
    }
  })

  it('opens a row stored before the classification fields existed', () => {
    // A version-1 row carries no profile, family, horizon, or acceptance.
    const row = benchmarkTaskRow.parse({
      id: 'legacy',
      hash: 'h',
      capability: 'writer',
      task: 'recover from the recurring failure',
      gists: [],
      sourceSessions: [],
      at: '2026-09-26T00:00:00.000Z',
      state: 'fresh',
    })
    expect(row).toMatchObject({ profile: null, family: 'loop-recovery', stepSpan: null, acceptance: null })
  })
})
