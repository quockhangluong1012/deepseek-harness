/**
 * The evolution journey host face projects the mounted curator's recorded
 * passes, and reports an unmounted curator as unmounted rather than as a pass
 * that never ran.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import EvolutionCuratorStatusController from '../src/index.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

function bench(curator?: object) {
  const ctx = new Context()
  roots.push(ctx)
  ctx.provide('typert', {
    lookups: { configure: () => () => {} },
    contexts: { configureHost: () => () => {} },
  } as never)
  if (curator !== undefined) ctx.provide('evolutionCurator', curator as never)
  return { ctx, controller: new EvolutionCuratorStatusController(ctx) }
}

describe('EvolutionCuratorStatusController', () => {
  it('reports an unmounted curator with no passes and null rates', async () => {
    const { ctx, controller } = bench()
    // The service is provided under the class's own key (cordis wraps the
    // instance, so identity is not comparable; the verbs below are).
    expect(ctx.get('evolutionCuratorStatus')).toBeDefined()
    await expect(controller.status()).resolves.toEqual({
      mounted: false,
      lastRunAt: null,
      passes: [],
      cacheHitRate: null,
      skillFailureRate: null,
    })
  })

  it('projects the mounted curator passes and newest instant', async () => {
    const passes = [
      { passId: 'pass-2', at: '2026-09-11T00:00:00.000Z', snapshot: 'b.tar.gz', transitions: 1 },
      { passId: 'pass-1', at: '2026-09-04T00:00:00.000Z', snapshot: 'a.tar.gz', transitions: 3 },
    ]
    const { controller } = bench({
      lastRunAt: () => '2026-09-11T00:00:00.000Z',
      passes: async () => passes,
    })
    await expect(controller.status()).resolves.toEqual({
      mounted: true,
      lastRunAt: '2026-09-11T00:00:00.000Z',
      passes,
      cacheHitRate: null,
      skillFailureRate: null,
    })
  })

  it('reads both dashboard rates from the ledger and telemetry', async () => {
    const ctx = new Context()
    roots.push(ctx)
    ctx.provide('typert', {
      lookups: { configure: () => () => {} },
      contexts: { configureHost: () => () => {} },
    } as never)
    ctx.provide('evolutionCurator', { lastRunAt: () => null, passes: async () => [] } as never)
    ctx.provide('usageLedger', {
      summary: async () => ({ totals: { cacheHitAvg: 0.73, requests: 142 } }),
    } as never)
    ctx.provide('evolutionSkillTelemetry', {
      entries: () => [
        { usage: { useCount: 10, failureCount: 2, state: 'active', pinned: false } },
        { usage: { useCount: 4, state: 'stale', pinned: false } },
      ],
    } as never)
    await expect(new EvolutionCuratorStatusController(ctx).status()).resolves.toEqual({
      mounted: true,
      lastRunAt: null,
      passes: [],
      cacheHitRate: 0.73,
      // 2 failures over 10 + 2 + 4 loads.
      skillFailureRate: 2 / 16,
    })
  })
})
