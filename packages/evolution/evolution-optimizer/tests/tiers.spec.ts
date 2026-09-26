/**
 * S9 evaluation-tier behavior: batch-id helpers behind the tier-2 ceiling
 * gate, and the tier-1 content key that buys one attempt for a body the
 * fixture corpus already validates while escalating any changed candidate
 * to the scorer's full configured attempt count.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ScoreVariantDeps } from '../src/evaluate.ts'
import { dailyBatchId, scoreVariantTiered, tierOneKey, weeklyBatchId } from '../src/tiers.ts'

describe('dailyBatchId', () => {
  it('keys by the UTC calendar date', () => {
    expect(dailyBatchId('writer', new Date('2024-06-15T23:59:00Z'))).toBe('evolution-optimizer:writer:daily:2024-06-15')
  })
})

describe('weeklyBatchId', () => {
  it('keys a Monday-start week the plain year-of-date agrees with', () => {
    expect(weeklyBatchId('writer', new Date('2024-01-01T00:00:00Z'))).toBe('evolution-optimizer:writer:weekly:2024-W01')
  })

  it('assigns an early-January date to the prior ISO year’s last week', () => {
    // 2023-01-01 is a Sunday: ISO calendar puts it in 2022's week 52.
    expect(weeklyBatchId('writer', new Date('2023-01-01T00:00:00Z'))).toBe('evolution-optimizer:writer:weekly:2022-W52')
  })

  it('reaches a 53rd week in a year that has one', () => {
    expect(weeklyBatchId('writer', new Date('2026-12-28T00:00:00Z'))).toBe('evolution-optimizer:writer:weekly:2026-W53')
  })

  it('carries the same key across the whole week regardless of weekday', () => {
    const monday = weeklyBatchId('writer', new Date('2024-06-10T00:00:00Z'))
    const sunday = weeklyBatchId('writer', new Date('2024-06-16T23:59:00Z'))
    expect(monday).toBe(sunday)
  })
})

describe('tierOneKey', () => {
  it('is stable regardless of scenario order and changes with any input', () => {
    const a = tierOneKey('writer', ['s1', 's2'], 'body')
    expect(tierOneKey('writer', ['s2', 's1'], 'body')).toBe(a)
    expect(tierOneKey('writer', ['s1'], 'body')).not.toBe(a)
    expect(tierOneKey('other', ['s1', 's2'], 'body')).not.toBe(a)
    expect(tierOneKey('writer', ['s1', 's2'], 'body v2')).not.toBe(a)
  })
})

describe('scoreVariantTiered', () => {
  /** Fake scorer that records the attempts each evaluateSkill call received. */
  function fakeScorer(): { attemptsSeen: (number | undefined)[]; scorer: ScoreVariantDeps['scorer'] } {
    const attemptsSeen: (number | undefined)[] = []
    const scorer = {
      version: 1,
      evaluateSkill: async (request: { skill: string; attempts?: number }) => {
        attemptsSeen.push(request.attempts)
        return {
          status: 'evaluated' as const,
          skill: request.skill,
          score: { skill: request.skill, pass: true, tokens: 5, wallTimeMs: 5, scores: [] },
        }
      },
    } as unknown as ScoreVariantDeps['scorer']
    return { attemptsSeen, scorer }
  }

  const AGENT = { binScript: 'unused-bin', configPath: 'unused-cfg', tsconfigPath: 'unused-tsconfig' }
  const run: ScoreVariantDeps['run'] = async () => ({
    rawStdout: '', stderr: '', cwd: '/tmp/nowhere', cwdAliases: [], initialWorkspace: [], finalWorkspace: [], sessionLogs: [],
  })

  it('buys one attempt for the run\'s own starting body — the fixture corpus already validates it', async () => {
    const { attemptsSeen, scorer } = fakeScorer()
    const deps: ScoreVariantDeps = { scorer, skill: 'writer', scenarios: ['s1'], agent: AGENT, run }
    await scoreVariantTiered(new Context(), deps, '# writer', '# writer')
    expect(attemptsSeen).toEqual([1])
  })

  it('escalates to the scorer\'s configured attempts for a body that changed — a content-key miss', async () => {
    const { attemptsSeen, scorer } = fakeScorer()
    const deps: ScoreVariantDeps = { scorer, skill: 'writer', scenarios: ['s1'], agent: AGENT, run }
    await scoreVariantTiered(new Context(), deps, '# writer v2', '# writer')
    expect(attemptsSeen).toEqual([undefined])
  })

  it('never caches — a candidate that keeps changing keeps escalating', async () => {
    const { attemptsSeen, scorer } = fakeScorer()
    const deps: ScoreVariantDeps = { scorer, skill: 'writer', scenarios: ['s1'], agent: AGENT, run }
    await scoreVariantTiered(new Context(), deps, '# writer v2', '# writer')
    await scoreVariantTiered(new Context(), deps, '# writer v3', '# writer')
    expect(attemptsSeen).toEqual([undefined, undefined])
  })

  it('refuses before the scorer runs once the skill ceiling is spent', async () => {
    const { attemptsSeen, scorer } = fakeScorer()
    const ctx = new Context()
    ctx.provide('evolutionBudget', {
      batches: () => [],
      allocate: async () => ({}),
      withinBudget: () => false,
      spend: async () => ({}),
    } as never)
    const deps: ScoreVariantDeps = { scorer, skill: 'writer', scenarios: ['s1'], agent: AGENT, run }

    const evaluation = await scoreVariantTiered(ctx, deps, '# writer', '# writer')

    expect(attemptsSeen).toEqual([])
    expect(evaluation).toEqual({
      status: 'skipped',
      skill: 'writer',
      reason: "the daily or weekly evolution-budget ceiling for 'writer' is spent",
    })
  })
})
