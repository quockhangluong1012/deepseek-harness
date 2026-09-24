/**
 * Variant evaluation harness: stage one SKILL.md body into an isolated
 * DSH_HOME overlay and score it through the scorer with a runner that boots
 * every attempt inside that overlay. The user's live skills are never
 * touched; the overlay is removed when scoring settles.
 * @module @deepseek-ai/dsh-evolution-optimizer/evaluate
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EvolutionScorer, ScenarioRunner, SkillEvaluation } from '@deepseek-ai/dsh-evolution-scorer'
import type { AgentUnderTest } from '@deepseek-ai/dsh-session-snapshot'

/**
 * Write one SKILL.md body into a fresh DSH_HOME overlay.
 * @param skill - skill name the overlay provides.
 * @param body - complete SKILL.md body the overlay serves.
 * @returns the overlay home directory; the caller removes it.
 */
export async function stageVariantHome(skill: string, body: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-optimizer-'))
  await mkdir(join(home, 'skills', skill), { recursive: true })
  await writeFile(join(home, 'skills', skill, 'SKILL.md'), body, 'utf8')
  return home
}

/**
 * Wrap a fresh-process runner so every attempt boots inside the overlay home.
 * The home is a harness option, not an environment entry: the recorded-replay
 * runner builds its own environment after layering the caller's, so an
 * `DSH_HOME` passed through `env` would be overwritten and every attempt would
 * measure the live skills instead of the variant.
 * @param run - base runner.
 * @param home - overlay DSH_HOME.
 * @returns the runner the scorer scores one variant with.
 */
export function overlayRunner(run: ScenarioRunner, home: string): ScenarioRunner {
  return (input, options) => run(input, { ...options, homeDir: home })
}

/** What one variant scoring needs beyond the harness. */
export interface ScoreVariantDeps {
  /** Scorer whose corpus and attempt count the evaluation runs under. */
  scorer: EvolutionScorer
  /** Skill the scenarios exercise. */
  skill: string
  /** Scenario directory names inside the scorer's corpus, in run order. */
  scenarios: readonly string[]
  /** Agent composition the runner boots. */
  agent: AgentUnderTest
  /** Fresh-process runner; each call runs one variant's attempts. */
  run: ScenarioRunner
  /** Upstream cancellation forwarded to every score. */
  signal?: AbortSignal | undefined
}

/**
 * Score one SKILL.md body: stage the overlay, run the scorer through it, and
 * remove the overlay when scoring settles.
 * @param deps - scorer, skill, scenarios, agent, and runner.
 * @param body - complete SKILL.md body to score.
 * @param attempts - fresh-process attempt-count override; see {@link ScoreRequest.attempts}.
 * @returns the scorer's evaluation, possibly a skip the caller propagates.
 */
export async function scoreVariant(deps: ScoreVariantDeps, body: string, attempts?: number): Promise<SkillEvaluation> {
  const home = await stageVariantHome(deps.skill, body)
  try {
    return await deps.scorer.evaluateSkill({
      skill: deps.skill,
      scenarios: deps.scenarios,
      agent: deps.agent,
      run: overlayRunner(deps.run, home),
      ...attempts === undefined ? {} : { attempts },
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
