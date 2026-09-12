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
  it('reports an unmounted curator with no passes', async () => {
    const { ctx, controller } = await bench()
    // The service is provided under the class's own key (cordis wraps the
    // instance, so identity is not comparable; the verbs below are).
    expect(ctx.get('evolutionCuratorStatus')).toBeDefined()
    await expect(controller.status()).resolves.toEqual({ mounted: false, lastRunAt: null, passes: [] })
  })

  it('projects the mounted curator passes and newest instant', async () => {
    const passes = [
      { passId: 'pass-2', at: '2026-09-11T00:00:00.000Z', snapshot: 'b.tar.gz', transitions: 1 },
      { passId: 'pass-1', at: '2026-09-04T00:00:00.000Z', snapshot: 'a.tar.gz', transitions: 3 },
    ]
    const { controller } = await bench({
      lastRunAt: () => '2026-09-11T00:00:00.000Z',
      passes: async () => passes,
    })
    await expect(controller.status()).resolves.toEqual({
      mounted: true,
      lastRunAt: '2026-09-11T00:00:00.000Z',
      passes,
    })
  })
})
