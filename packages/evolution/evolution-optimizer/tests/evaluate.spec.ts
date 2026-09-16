/**
 * Overlay staging, runner wrapping, and scoring with cleanup: the overlay
 * serves exactly the staged body, every attempt boots inside it, and the
 * directory is gone when scoring settles either way.
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentUnderTest, RunOptions, RunResult } from '@deepseek-ai/dsh-session-snapshot'
import type { ScenarioRunner } from '@deepseek-ai/dsh-evolution-scorer'
import { overlayRunner, scoreVariant, stageVariantHome } from '../src/evaluate.ts'

/** Agent composition the fakes never boot. */
const AGENT: AgentUnderTest = { binScript: 'unused-bin', configPath: 'unused-cfg', tsconfigPath: 'unused-tsconfig' }

/** Minimal runner result; the fakes never harvest. */
function emptyResult(): RunResult {
  return {
    rawStdout: '',
    stderr: '',
    cwd: '/tmp/nowhere',
    cwdAliases: [],
    initialWorkspace: [],
    finalWorkspace: [],
    sessionLogs: [],
  }
}
function options(env?: NodeJS.ProcessEnv): RunOptions {
  return env === undefined
    ? { agent: AGENT, mode: 'replay', fixtureFile: 'f' }
    : { agent: AGENT, mode: 'replay', fixtureFile: 'f', env }
}

describe('stageVariantHome', () => {
  it('serves the staged body at skills/<name>/SKILL.md', async () => {
    const home = await stageVariantHome('writer', '# writer v2')
    try {
      await expect(readFile(join(home, 'skills', 'writer', 'SKILL.md'), 'utf8')).resolves.toBe('# writer v2')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('overlayRunner', () => {
  it('names the overlay home through the harness option, keeping the caller environment', async () => {
    let seen: RunOptions | undefined
    const run: ScenarioRunner = async (_input, runOptions) => {
      seen = runOptions
      return emptyResult()
    }
    const wrapped = overlayRunner(run, '/tmp/overlay-home')
    await wrapped({ steps: [] }, options({ KEEP: '1' }))
    // The replay harness builds its own DSH_HOME after layering `env`, so the
    // overlay reaches the attempt as the home option and not as an entry the
    // harness would overwrite.
    expect(seen?.homeDir).toBe('/tmp/overlay-home')
    expect(seen?.env).toMatchObject({ KEEP: '1' })
    expect(seen?.env?.['DSH_HOME']).toBeUndefined()
  })
})

describe('scoreVariant', () => {
  it('scores through the overlay and removes it afterwards', async () => {
    const seenHomes: (string | undefined)[] = []
    const run: ScenarioRunner = async (_input, runOptions) => {
      seenHomes.push(runOptions.homeDir)
      return emptyResult()
    }
    const scorer = {
      evaluateSkill: async (request: { skill: string; run: ScenarioRunner }) => {
        await request.run({ steps: [] }, options({}))
        return {
          status: 'evaluated' as const,
          skill: request.skill,
          score: { skill: request.skill, pass: true, tokens: 5, wallTimeMs: 5, scores: [] },
        }
      },
    }
    const outcome = await scoreVariant(
      { scorer: scorer as unknown as import('../src/evaluate.ts').ScoreVariantDeps['scorer'], skill: 'writer', scenarios: ['s1'], agent: AGENT, run },
      '# writer v2',
    )
    expect(outcome.status).toBe('evaluated')
    const home = seenHomes[0] ?? ''
    expect(home).toMatch(/dsh-optimizer-/)
    // The overlay directory is removed once scoring settles.
    await expect(readFile(join(home, 'skills', 'writer', 'SKILL.md'), 'utf8')).rejects.toThrow()
  })
})
