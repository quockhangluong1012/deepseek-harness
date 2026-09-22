/**
 * Pure helpers for retrieval-aware evolution: the canonical configuration key,
 * the sample-confidence-adjusted score, the join that grades sessions from the
 * evidence stores, the per-class effectiveness fold, and the ranked
 * configuration recommendation. No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-retrieval/src/retrieval
 */

import type {
  RetrievalAttribution,
  RetrievalConfiguration,
  RetrievalEffectiveness,
  RetrievalRankingEntry,
  RetrievalTaskClass,
  SessionGrade,
  SkillEvidenceEntry,
} from './types.ts'

/**
 * The canonical key of one retrieval configuration: every dimension in a fixed
 * order, so two callers that build the same configuration in different key
 * order still name one configuration.
 * @param configuration - the configuration to key.
 * @returns the canonical key.
 */
export function configurationKey(configuration: RetrievalConfiguration): string {
  const { source, queryExpansion, weights, reranker, mmr, memoryScope, graphDepth, threshold } = configuration
  return JSON.stringify([
    source,
    queryExpansion,
    weights.vector,
    weights.graph,
    reranker,
    mmr.enabled,
    mmr.lambda,
    memoryScope,
    graphDepth,
    threshold,
  ])
}

/**
 * Grade the sessions the evidence stores already graded. A skill's graded
 * session outcome names both the task class and the outcome; a session that
 * loaded a skill without a graded outcome is graded `failed` on that class when
 * the feedback store attributed a failure to a tool in it, and is not counted
 * at all otherwise.
 * @param sessions - the attributed sessions to grade.
 * @param skills - every skill's session evidence, from the telemetry store.
 * @param failed - sessions the feedback store graded with an attributable failure.
 * @returns one grade per session and task class, in session then skill order.
 */
export function gradesOf(
  sessions: readonly string[],
  skills: readonly SkillEvidenceEntry[],
  failed: ReadonlySet<string>,
): SessionGrade[] {
  const grades: SessionGrade[] = []
  for (const sessionId of [...new Set(sessions)]) {
    for (const skill of skills) {
      const graded = skill.usage.sessionOutcomes.find(outcome => outcome.sessionId === sessionId)
      if (graded !== undefined) {
        grades.push({ sessionId, taskClass: skill.name, outcome: graded.outcome })
        continue
      }
      if (skill.usage.sessionIds.includes(sessionId) && failed.has(sessionId)) {
        grades.push({ sessionId, taskClass: skill.name, outcome: 'failed' })
      }
    }
  }
  return grades
}

/**
 * Advance one configuration's effectiveness on one task class with one graded
 * session, keeping the newest attribution instant.
 * @param current - the effectiveness to advance, or undefined for the first grade.
 * @param attribution - the attribution the grade belongs to.
 * @param grade - the graded session to fold in.
 * @returns the advanced effectiveness.
 */
export function updatedEffectiveness(
  current: RetrievalEffectiveness | undefined,
  attribution: RetrievalAttribution,
  grade: SessionGrade,
): RetrievalEffectiveness {
  const samples = (current?.samples ?? 0) + 1
  const passes = (current?.passes ?? 0) + (grade.outcome === 'ok' ? 1 : 0)
  return {
    configKey: attribution.configKey,
    configuration: attribution.configuration,
    taskClass: grade.taskClass,
    samples,
    passes,
    successRate: passes / samples,
    lastAt: current === undefined || attribution.at > current.lastAt ? attribution.at : current.lastAt,
  }
}

/**
 * Fold the recorded attributions and the graded sessions into one effectiveness
 * row per configuration and task class. A session that ran under two
 * configurations contributes its grade to both: the outcome is the session's,
 * and the store cannot split it between the configurations that served it.
 * @param attributions - every recorded attribution.
 * @param grades - every graded session, from {@link gradesOf}.
 * @returns the effectiveness rows, task-class then configuration-key order.
 */
export function effectivenessRows(
  attributions: readonly RetrievalAttribution[],
  grades: readonly SessionGrade[],
): RetrievalEffectiveness[] {
  const bySession = new Map<string, SessionGrade[]>()
  for (const grade of grades) {
    const entries = bySession.get(grade.sessionId)
    if (entries === undefined) bySession.set(grade.sessionId, [grade])
    else entries.push(grade)
  }
  const grouped = new Map<string, RetrievalEffectiveness>()
  for (const attribution of attributions) {
    for (const grade of bySession.get(attribution.sessionId) ?? []) {
      const key = `${attribution.configKey}\0${grade.taskClass}`
      grouped.set(key, updatedEffectiveness(grouped.get(key), attribution, grade))
    }
  }
  return [...grouped.values()].sort((left, right) =>
    left.taskClass.localeCompare(right.taskClass) || left.configKey.localeCompare(right.configKey))
}

/**
 * The sample-confidence-adjusted score of one configuration's success rate: a
 * beta-prior smoothed rate scaled by how close the graded-session count is to
 * the minimum, so a configuration with few graded sessions cannot outrank a
 * well-measured one.
 * @param passes - graded sessions that came out clean.
 * @param samples - graded sessions measured.
 * @param minimumSessions - graded-session count at which confidence is full.
 * @returns the score.
 */
export function scoreOf(passes: number, samples: number, minimumSessions: number): number {
  const smoothed = (passes + 1) / (samples + 2)
  const confidence = Math.min(1, samples / minimumSessions)
  return smoothed * confidence
}

/**
 * Rank one task class's configurations by the sample-confidence-adjusted score,
 * score descending with configuration-key ascending as the tie-break.
 * @param rows - every derived effectiveness row.
 * @param taskClass - the task class to rank configurations for.
 * @param minimumSessions - graded-session count at which confidence is full.
 * @returns the ranked configurations, best first.
 */
export function rankConfigurations(
  rows: readonly RetrievalEffectiveness[],
  taskClass: RetrievalTaskClass,
  minimumSessions: number,
): RetrievalRankingEntry[] {
  return rows
    .filter(row => row.taskClass === taskClass)
    .map((row) => {
      const score = scoreOf(row.passes, row.samples, minimumSessions)
      return {
        configKey: row.configKey,
        configuration: row.configuration,
        samples: row.samples,
        passes: row.passes,
        successRate: row.successRate,
        score,
        reason: describeRanking(row, score),
      }
    })
    .sort((left, right) =>
      right.score - left.score || left.configKey.localeCompare(right.configKey))
}

/**
 * The configuration to run for one task class: the best-ranked configuration
 * with at least the minimum number of graded sessions. Yields undefined while
 * no configuration has that much evidence.
 * @param rankings - the ranked configurations, best first.
 * @param minimumSessions - graded sessions a configuration needs before it may be recommended.
 * @returns the recommended configuration, or undefined.
 */
export function recommendConfiguration(
  rankings: readonly RetrievalRankingEntry[],
  minimumSessions: number,
): RetrievalRankingEntry | undefined {
  return rankings.find(entry => entry.samples >= minimumSessions)
}

/**
 * Render why one configuration ranks as it does, naming the numbers.
 * @param row - the effectiveness to describe.
 * @param score - the score the configuration received.
 * @returns the reason sentence.
 */
function describeRanking(row: RetrievalEffectiveness, score: number): string {
  return `${row.passes}/${row.samples} graded sessions succeeded (${row.successRate.toFixed(2)}), score ${score.toFixed(3)}`
}
