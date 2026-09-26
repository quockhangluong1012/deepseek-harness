/**
 * The §13.4 mentor metric set over the records the mentor loop already wrote:
 * what one learner's durable record and the misconception cycles recorded for
 * them show about detecting the trouble, teaching it, aiming the practice, and
 * whether the learning held (§13.4 Misconception Detection, Explanation
 * Quality, Exercise Relevance, Learning Improvement, Retention, Repeated
 * Mistake Reduction).
 *
 * The learner record is `ctx.learnerModel`, read by learner id; the cycles are
 * `ctx.misconception`, the engine that owns the teach-and-reassess pipeline.
 * Nothing here writes and nothing calls a model.
 * @module @deepseek-ai/dsh-evolution-metrics/src/mentor
 */

import type { CaseImpact, LearnerRecord } from '@deepseek-ai/dsh-learner-model'
import type { MisconceptionPipeline } from '@deepseek-ai/dsh-misconception'
import { rate, unavailable } from './metrics.ts'
import type { MetricValue } from './types.ts'

/** The learner record every record-derived reading comes from. */
const LEARNER_INPUT = 'ctx.learnerModel.read(learnerId): LearnerRecord.misconceptions / caseHistory'

/** The cycles the pipeline-derived readings come from. */
const PIPELINE_INPUT = 'ctx.misconception.pipelines(learnerId): MisconceptionPipeline.stage / exercise / evidence'

/** Why every learner-record reading has no population. */
const NO_LEARNER = 'the learner model is not mounted, so no learner record is read'

/** Why every pipeline reading has no population. */
const NO_PIPELINES = 'the misconception engine is not mounted, so no recorded cycle is read'

/** Why a case-derived reading has no population. */
const NO_CASES = 'no reviewed case is recorded for the learner: `LearnerRecord.caseHistory` is empty'

/** The learner record and cycles one mentor report is computed from. */
export interface MentorFacts {
  /** The learner's durable record, or undefined when the learner model is not mounted. */
  readonly learner: LearnerRecord | undefined
  /** The learner's recorded cycles, or undefined when the misconception engine is not mounted. */
  readonly pipelines: readonly MisconceptionPipeline[] | undefined
}

/**
 * How many judgements held after a concept was strengthened: for each concept,
 * the judgement that follows each strengthening, oldest first, counted as held
 * unless it weakened the concept.
 * @param impacts - every recorded per-concept judgement, in any order.
 * @returns the judgements that held and the ones that lost the concept.
 */
function retention(impacts: readonly CaseImpact[]): { readonly held: number; readonly lost: number } {
  const byConcept = new Map<string, CaseImpact[]>()
  for (const impact of impacts) {
    const judgements = byConcept.get(String(impact.conceptId))
    if (judgements === undefined) byConcept.set(String(impact.conceptId), [impact])
    else judgements.push(impact)
  }
  let held = 0
  let lost = 0
  for (const judgements of byConcept.values()) {
    judgements.sort((left, right) => left.at.localeCompare(right.at))
    for (let index = 0; index < judgements.length - 1; index += 1) {
      const current = judgements[index]
      const next = judgements[index + 1]
      if (current?.impact !== 'strengthened') continue
      if (next?.impact === 'weakened') lost += 1
      else held += 1
    }
  }
  return { held, lost }
}

/** Whether the learner's record counts this cycle's misconception as one that recurred. */
function recurs(learner: LearnerRecord | undefined, pipeline: MisconceptionPipeline): boolean {
  const id = String(pipeline.misconceptionId)
  return (learner?.misconceptions ?? []).some(entry => entry.misconceptionId === id && entry.recurrences > 1)
}

/**
 * The share of the assigned exercises that serve a belief the record counts as
 * recurring. Unmeasurable when either store is missing: without the cycles
 * there are no assignments to read, and without the learner record nothing
 * says whether a belief recurred, which a zero would misreport as "not
 * relevant".
 * @param facts - the learner's record and cycles, each absent when its store is not mounted.
 * @param assignments - the recorded cycles that assigned an exercise.
 * @param relevant - how many of them serve a recurring belief.
 * @returns the measured share, or the reading naming the missing store.
 */
function exerciseRelevance(
  facts: MentorFacts,
  assignments: readonly MisconceptionPipeline[],
  relevant: number,
): MetricValue {
  const inputs = [PIPELINE_INPUT, LEARNER_INPUT]
  if (facts.pipelines === undefined) return unavailable('exercise-relevance', 'share', inputs, NO_PIPELINES)
  if (facts.learner === undefined) return unavailable('exercise-relevance', 'share', inputs, NO_LEARNER)
  return rate(
    'exercise-relevance',
    'share',
    relevant,
    assignments.length,
    inputs,
    'no recorded cycle assigned an exercise: `MisconceptionPipeline.exercise` is set at the exercise stage',
    'relevance is read as the practice serving a misconception the learner kept showing; nothing records whether the'
    + ' exercise prompt matches the objective it states, so a first-time misconception\'s exercise counts as'
    + ' irrelevant',
  )
}

/**
 * The six §13.4 mentor metrics over one learner's recorded work. A metric
 * whose records are absent is returned unmeasurable with the missing record
 * named, so a reader can tell "the mentor taught well" from "nothing was
 * recorded".
 * @param facts - the learner's record and cycles, each absent when its store is not mounted.
 * @returns the six readings, in spec order.
 */
export function mentorMetrics(facts: MentorFacts): readonly MetricValue[] {
  const learner = facts.learner
  const pipelines = facts.pipelines
  const cases = learner?.caseHistory ?? []
  const misconceptions = learner?.misconceptions ?? []
  const impacts = cases.flatMap(entry => entry.impacts)
  const detected = new Set(misconceptions.flatMap(entry => entry.caseIds.map(String)))
  const found = cases.filter(entry => detected.has(String(entry.caseId)))
  const explained = (pipelines ?? []).filter(pipeline => pipeline.stage !== 'explain')
  const exercises = (pipelines ?? []).filter(pipeline => pipeline.exercise !== undefined)
  const relevant = exercises.filter(pipeline => recurs(learner, pipeline))
  const strengthened = impacts.filter(impact => impact.impact === 'strengthened')
  const retained = retention(impacts)
  const repeated = misconceptions.filter(entry => entry.recurrences > 1)
  const resolved = repeated.filter(entry => entry.status === 'resolved')
  const onLearner = (empty: string): string => (learner === undefined ? NO_LEARNER : empty)

  return [
    rate(
      'misconception-detection',
      'share',
      found.length,
      cases.length,
      [LEARNER_INPUT],
      onLearner(NO_CASES),
      'a case the mentor found nothing in counts as a miss, and a detection that recorded no case reference credits'
      + ' none, so the reading moves with how cases are referenced as well as with what was detected',
    ),
    rate(
      'explanation-quality',
      'share',
      explained.length,
      (pipelines ?? []).length,
      [PIPELINE_INPUT],
      pipelines === undefined
        ? NO_PIPELINES
        : 'no cycle is recorded for the learner: `ctx.misconception.pipelines(learnerId)` is empty',
      'the only recorded completion of the explain stage is a caller\'s `delivered` observation, so this reads that'
      + ' the explanation reached the learner, not whether it was understood or whether its text fit the misconception',
    ),
    exerciseRelevance(facts, exercises, relevant.length),
    rate(
      'learning-improvement',
      'share',
      strengthened.length,
      impacts.length,
      [LEARNER_INPUT],
      onLearner('no reviewed case judged how the learner moved: `CaseHistoryEntry.impacts` is empty'),
      'an impact is a reviewer\'s judgement recorded with the case, not a measured score, and `unchanged` and'
      + ' `weakened` count against the reading',
    ),
    rate(
      'retention',
      'share',
      retained.held,
      retained.held + retained.lost,
      [LEARNER_INPUT],
      onLearner('no concept was judged strengthened and then judged again: `CaseHistoryEntry.impacts` holds one'
        + ' judgement per concept per case'),
      'a concept is retained when the judgement that follows its strengthening does not weaken it; the record holds one'
      + ' judgement per concept per case, so a re-test inside one case is not seen',
    ),
    rate(
      'repeated-mistake-reduction',
      'share',
      resolved.length,
      repeated.length,
      [LEARNER_INPUT],
      onLearner('no misconception the learner showed more than once is recorded: `Misconception.recurrences` counts'
        + ' the detections'),
      'a mistake entry counts occurrences and carries no status, so what is read is the resolved state of the repeated'
      + ' misconception behind it; the record keeps a resolved entry forever, so the share is over everything ever'
      + ' recorded rather than a period',
    ),
  ]
}
