/**
 * Measured improvement scoring (`ctx.evolutionScorer`): run one recorded
 * scenario N times in fresh processes and report the metric triple — pass from
 * the workspace diff, billed tokens from the host token meter, and median
 * wall-clock time.
 *
 * Scoring reads fixtures already on disk. It always runs the recorded-session
 * replay tier from the snapshot harness, so it needs no API key and never
 * records: a scenario the corpus does not describe, or one whose recorded
 * fixture is absent, is reported as a skip. The pure scorer is exported
 * separately so specs drive the arithmetic without spawning anything.
 * @module @deepseek-ai/dsh-evolution-scorer
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { captureExpectedWorkspaceSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import type { RunOptions } from '@deepseek-ai/dsh-session-snapshot'
import { measureRunTokens } from './sessions.ts'
import { loadScenarioPlan } from './scenario.ts'
import { scoreRun } from './score.ts'
import type { ScoreAttempt, ScoreOutcome, ScoreRequest } from './types.ts'

export type {
  ScoreAttempt,
  ScoreInput,
  ScoreOutcome,
  ScoreRecord,
  ScoreRequest,
  ScenarioPlan,
  ScenarioPlanResult,
  ScenarioRunner,
  WorkspaceChange,
} from './types.ts'
export { processScenarioRunner } from './runner.ts'
export { loadScenarioPlan } from './scenario.ts'
export { scoreRun } from './score.ts'
export { measureRunTokens } from './sessions.ts'
export { medianOf } from './statistics.ts'
export { diffWorkspace } from './workspace.ts'

/**
 * Corpus location and attempt count are deployment choices: which corpus a
 * host scores against, and how many fresh processes the median covers.
 */
export interface Config {
  /** Absolute corpus root holding one directory per recorded scenario. */
  corpusDir: string
  /** Fresh-process attempts per score; the median is taken over their samples. */
  attempts?: number
}

/** Corpus location a host must name; there is no useful repository-independent default. */
const corpusDirField = z.string().required()

/** Attempts per score: three keeps one cold start from moving the median. */
const attemptsField = z.number().step(1).min(1).default(3)

/** Validated deployment choices; `corpusDir` is required. */
export const Config: z<Config> = z.object({
  corpusDir: corpusDirField,
  attempts: attemptsField,
})

/** Normalized configuration used by the scorer. */
export interface ResolvedConfig {
  corpusDir: string
  attempts: number
}

/**
 * Resolve defaults for the optional attempt count.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const { corpusDir, attempts = 3 } = config
  return { corpusDir, attempts }
}

/**
 * Recorded-session scorer. One score runs the scenario in `attempts` fresh
 * processes, measures each attempt's harvested sessions through
 * `ctx.tokenMeter`, and reduces the attempts to the metric triple. Nothing is
 * written: the runner's replay fixtures and the expected workspace are read-only
 * inputs.
 */
export class EvolutionScorer extends Service {
  static inject = ['tokenMeter']

  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - host context carrying the token meter.
   * @param config - corpus root and attempt count.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'evolutionScorer')
    this.resolved = resolveConfig(config)
  }

  /**
   * Score one scenario against its recorded fixtures.
   *
   * Every attempt boots a fresh process through the caller's runner in the
   * keyless replay tier, and is scored against `workspace.expected/` when the
   * scenario ships one, or against its own initial workspace otherwise.
   * @param request - scenario name plus the agent composition and runner to boot it with.
   * @returns the metric triple, or the reason the scenario could not be scored.
   * @throws when the configured corpus does not exist, a shipped fixture cannot be parsed,
   * or the runner fails; only an unknown scenario and an absent fixture are skips.
   */
  async score(request: ScoreRequest): Promise<ScoreOutcome> {
    const planned = await loadScenarioPlan(this.resolved.corpusDir, request.scenario)
    if (planned.status === 'skipped') return { status: 'skipped', scenario: request.scenario, reason: planned.reason }
    const { plan } = planned
    const expected = plan.expectedWorkspaceDir === undefined
      ? undefined
      : await captureExpectedWorkspaceSnapshot(plan.expectedWorkspaceDir)
    const attempts: ScoreAttempt[] = []
    for (let index = 0; index < this.resolved.attempts; index += 1) {
      const options: RunOptions = {
        agent: request.agent,
        mode: 'replay',
        fixtureFile: plan.fixtureFile,
        ...plan.overrideFile === undefined ? {} : { overrideFile: plan.overrideFile },
        ...plan.childFiles.length === 0 ? {} : { childFiles: [...plan.childFiles] },
        ...plan.workspaceDir === undefined ? {} : { workspaceDir: plan.workspaceDir },
      }
      const startedAt = Date.now()
      const result = await request.run(plan.script, options)
      attempts.push({
        initial: result.initialWorkspace,
        final: result.finalWorkspace,
        tokens: measureRunTokens(this.ctx.tokenMeter, result.sessionLogs),
        wallTimeMs: Date.now() - startedAt,
      })
    }
    return {
      status: 'scored',
      score: scoreRun({
        scenario: plan.scenario,
        ...expected === undefined ? {} : { expected },
        attempts,
      }),
    }
  }
}

export default EvolutionScorer
