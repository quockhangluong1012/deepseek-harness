import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import EvolutionVerifiers from '../src/index.ts'

async function boot() {
  const ctx = new Context()
  const fiber = await ctx.plugin(EvolutionVerifiers)
  return { fiber, verifiers: ctx.evolutionVerifiers }
}

describe('evolution verifiers', () => {
  it('runs the ladder through the mounted service', async () => {
    const { fiber, verifiers } = await boot()
    try {
      const verdict = await verifiers.verify({
        name: 'leaf',
        body: '---\nname: leaf\ndescription: leaf skill\n---\nrewrite the leaf instructions\n',
        simulation: async () => ({ status: 'passed', reason: 'replay held' }),
        evaluator: async () => ({ status: 'passed', reason: 'judge approved' }),
        review: async () => ({ status: 'passed', reason: 'operator approved' }),
      })
      expect(verdict).toMatchObject({ status: 'passed', decidedBy: 4 })
      expect(verdict.rungs.map(rung => rung.level)).toEqual([0, 1, 2, 3, 4])
    } finally {
      await fiber.dispose()
    }
  })

  it('refuses a body that breaks the skill before any seam runs', async () => {
    const { fiber, verifiers } = await boot()
    try {
      const verdict = await verifiers.verify({
        name: 'leaf',
        body: 'rewritten without its frontmatter\n',
        simulation: async () => ({ status: 'passed', reason: 'replay held' }),
      })
      expect(verdict).toMatchObject({ status: 'failed', decidedBy: 0 })
    } finally {
      await fiber.dispose()
    }
  })
})
