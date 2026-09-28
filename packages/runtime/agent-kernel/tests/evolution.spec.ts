/**
 * The §18.2 evolution families: a session log records what the evolution layer
 * did, and folding that log rebuilds the same facts for a reader that holds the
 * log alone.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { EvolutionEventMetadata, RunId } from '../src/types.ts'
import { readKernelRecord } from '../src/ledger.ts'
import { eventsOf, humanMessage, makeAgent, preStep, rig } from './rig.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount a rig with a task already open, and remember it for teardown. */
async function opened() {
  const mounted = await rig()
  contexts.push(mounted.ctx)
  const agent = await makeAgent(mounted.ctx)
  await preStep(mounted.ctx, agent, [humanMessage('optimize the skill')])
  return { ...mounted, agent }
}

/** The §18.2 envelope one optimization run stamps on its events. */
function metadata(source: 'evolution-optimizer' | 'command-evolution'): EvolutionEventMetadata {
  return {
    version: 1,
    runId: brandString<RunId>('run-1'),
    actor: 'user',
    timestamp: 1_700_000_000_000,
    source,
    locator: 'writer',
  }
}

/** Digest the fixtures stand in for, one per body the run moved between. */
const CANDIDATE_SHA = 'a'.repeat(64)
const BASELINE_SHA = 'b'.repeat(64)

/** Append the four §18.2 events one promotion of `writer` produces. */
function appendEvolutionRun(agent: Agent): void {
  agent.session.append('evolution/candidate', {
    skill: 'writer',
    scopeId: 'scope-1',
    bodySha: CANDIDATE_SHA,
    operator: 'rewrite',
    novelty: 0.5,
    archiveNovelty: 0.25,
    scenarios: ['s1', 's2'],
    route: 'deepseek/deepseek-chat',
    metadata: metadata('evolution-optimizer'),
  })
  agent.session.append('evolution/evaluated', {
    skill: 'writer',
    bodySha: CANDIDATE_SHA,
    scenarios: ['s1', 's2'],
    pass: true,
    tokens: 120,
    wallTimeMs: 900,
    scores: [{ scenario: 's1', pass: true, tokens: 60, wallTimeMs: 400, fixtureDigest: 'f'.repeat(64), trajectory: 'trail-1' }],
    metadata: metadata('evolution-optimizer'),
  })
  agent.session.append('evolution/promoted', {
    skill: 'writer',
    scopeId: 'scope-1',
    state: 'promoted',
    bodySha: CANDIDATE_SHA,
    preimageSha: BASELINE_SHA,
    evidence: '4 failures over 12 recorded loads',
    stagedId: 'staged-1',
    measured: {
      body: { pass: true, tokens: 120, wallTimeMs: 900 },
      baseline: { pass: false, tokens: 400, wallTimeMs: 1200 },
    },
    confidence: { wins: 3, runs: 3 },
    metadata: metadata('command-evolution'),
  })
  agent.session.append('evolution/rolled-back', {
    skill: 'writer',
    scopeId: 'scope-1',
    state: 'rolled-back',
    bodySha: BASELINE_SHA,
    preimageSha: CANDIDATE_SHA,
    reason: 'restored the preimage, recorded as revision 3',
    metadata: metadata('command-evolution'),
  })
}

describe('§18.2 evolution events', () => {
  it('rebuilds what the evolution layer did from the log alone', async () => {
    const { ctx, agent } = await opened()

    expect(readKernelRecord(agent.session.snapshotEvents())?.evolution)
      .toEqual({ candidates: [], evaluations: [], promotions: new Map() })

    appendEvolutionRun(agent)

    const record = readKernelRecord(agent.session.snapshotEvents())
    expect(record?.evolution.candidates).toEqual([expect.objectContaining({
      skill: 'writer',
      bodySha: CANDIDATE_SHA,
      operator: 'rewrite',
      scenarios: ['s1', 's2'],
    })])
    expect(record?.evolution.evaluations).toEqual([expect.objectContaining({
      bodySha: CANDIDATE_SHA,
      pass: true,
      tokens: 120,
      scores: [expect.objectContaining({ scenario: 's1', fixtureDigest: 'f'.repeat(64), trajectory: 'trail-1' })],
    })])
    // A revert supersedes the promotion it undoes, so the fold reports the
    // current state while the log still holds both records.
    expect([...record?.evolution.promotions.values() ?? []]).toEqual([expect.objectContaining({
      skill: 'writer',
      state: 'rolled-back',
      bodySha: BASELINE_SHA,
    })])
    // The live view folds the same events the offline reader does.
    expect(ctx.agentKernel.state.view(agent.session)?.evolution.promotions.get('writer')?.state)
      .toBe('rolled-back')
  })

  it('keeps every event appendable without a kernel task behind it', async () => {
    const { agent } = await opened()
    appendEvolutionRun(agent)

    expect(eventsOf(agent, 'evolution/candidate')).toHaveLength(1)
    expect(eventsOf(agent, 'evolution/evaluated')).toHaveLength(1)
    expect(eventsOf(agent, 'evolution/promoted')).toHaveLength(1)
    expect(eventsOf(agent, 'evolution/rolled-back')).toHaveLength(1)
    // Log-only: none of them may reach the model-visible surface.
    expect(agent.session.deriveMessages()).toEqual([])
  })
})
