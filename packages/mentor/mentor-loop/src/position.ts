/**
 * The §20 mentor loop state machine. It is a pure derivation: every position
 * is computed from what the session, the kernel, the misconception engine, and
 * the learner record already hold, so a resumed or replayed session reaches
 * the same stage. A stage that cannot advance names what it waits for.
 * @module @deepseek-ai/dsh-mentor-loop/src/position
 */

import type { MisconceptionStage } from '@deepseek-ai/dsh-misconception'
import type { MentorLoopPosition, MentorStage } from './types.ts'

/**
 * Every §20 stage in loop order. The loop runs observe → evaluate →
 * devil-advocate → misconception-detection → teach → exercise → reassess →
 * learner-model-update, then starts again at observe for the learner's next
 * thesis. One step performs one stage's action; a turn cannot run the whole
 * loop, because every teaching stage waits for the learner to speak again.
 */
export const MENTOR_STAGES = [
  'observe',
  'evaluate',
  'devil-advocate',
  'misconception-detection',
  'teach',
  'exercise',
  'reassess',
  'learner-model-update',
] as const satisfies readonly MentorStage[]

/** The §20 stage each pipeline stage serves. */
const MENTOR_STAGE_OF: Record<MisconceptionStage, MentorStage> = {
  explain: 'teach',
  counterexample: 'teach',
  exercise: 'exercise',
  'new-case': 'reassess',
  reassess: 'reassess',
  complete: 'learner-model-update',
}

/** How the loop names, to a mentor or a maintainer, the learner turn it waits for. */
const STAGE_NOUN: Record<MisconceptionStage, string> = {
  explain: 'explanation',
  counterexample: 'counterexample',
  exercise: 'exercise',
  'new-case': 'case assignment',
  reassess: 'reassessment request',
  complete: 'cycle',
}

/** The pipeline fields the loop's derivation reads. */
export interface MentorLoopPipeline {
  /** The stage that has not completed yet. */
  readonly stage: MisconceptionStage
  /** What that stage waits for. */
  readonly waitingFor?: string
  /** The misconception named by the pattern, used in the wait the loop reports. */
  readonly misconception: string
}

/** Everything one derivation reads, already resolved from its owner. */
export interface MentorLoopInputs {
  /** The learner's newest message, as stated; absent before the learner says anything. */
  readonly analysis?: string
  /** Whether the deployment's catalogue recognizes that thesis. */
  readonly matched: boolean
  /** Whether the session recorded any claim about the analysis. */
  readonly claimed: boolean
  /** Evidence identities the session recorded. */
  readonly recordedEvidence: readonly string[]
  /** Evidence identities the session's claims cite. */
  readonly citedEvidence: readonly string[]
  /**
   * The occurrence the session judges against: the one its newest delivered directive names, else the
   * matched pattern's, once one exists.
   */
  readonly pipeline?: MentorLoopPipeline
  /** Whether the current stage's directive is already in the log. */
  readonly directiveDelivered: boolean
  /** Whether a learner message follows the newest directive this loop injected. */
  readonly learnerSpokeAfterDirective: boolean
  /** Whether the learner's case history holds a case this cycle has not used. */
  readonly caseAvailable: boolean
}

/**
 * The observations a detection cites: the ones the session's claims do not
 * rest on, because those are the ones that can contradict the stated thesis.
 * When every recorded observation is already cited, the session holds no newer
 * counter-evidence, and the recorded ones are returned again — they are what
 * contradicted the earlier statement of the same thesis.
 * @param recorded - evidence identities the session recorded, in log order.
 * @param cited - evidence identities the session's claims cite.
 * @returns the identities the detection cites.
 */
export function contradictingEvidence(recorded: readonly string[], cited: readonly string[]): readonly string[] {
  const uncited = recorded.filter(evidenceId => !cited.includes(evidenceId))
  return uncited.length === 0 ? recorded : uncited
}

/**
 * Where one learner session stands in the §20 loop, and what the loop does now.
 * A pipeline the session is already working on decides the position even when
 * the newest message is a reply rather than a restated thesis; the catalogue
 * only has to recognize a thesis that starts a new occurrence.
 * @param inputs - the resolved observations, pipeline, and learner record.
 * @returns the position: the §20 stage, the single action, and the named wait when nothing can advance.
 */
export function deriveMentorPosition(inputs: MentorLoopInputs): MentorLoopPosition {
  const { analysis, pipeline } = inputs
  if (analysis === undefined) {
    return { stage: 'observe', action: 'none', waitingFor: 'a learner message in this session' }
  }
  if (pipeline !== undefined && pipeline.stage !== 'complete') {
    return pipelinePosition(inputs, pipeline, analysis)
  }
  if (!inputs.matched) {
    return {
      stage: 'evaluate',
      action: 'none',
      waitingFor: 'a catalogued misconception pattern matching the stated thesis',
      thesis: analysis,
    }
  }
  if (pipeline?.stage === 'complete') {
    return { stage: 'misconception-detection', action: 'detect', thesis: analysis }
  }
  if (!inputs.claimed || inputs.recordedEvidence.length === 0) {
    return {
      stage: 'devil-advocate',
      action: 'none',
      waitingFor: 'the mentor\'s recorded claim and observations about the analysis',
      thesis: analysis,
    }
  }
  return { stage: 'misconception-detection', action: 'detect', thesis: analysis }
}

/**
 * Where one existing pipeline stands in the loop, and what the loop does now.
 * A stage advances only once a learner message follows the directive it
 * delivered, so one turn cannot run the whole cycle without the learner.
 */
function pipelinePosition(
  inputs: MentorLoopInputs,
  pipeline: MentorLoopPipeline,
  thesis: string,
): MentorLoopPosition {
  const stage = MENTOR_STAGE_OF[pipeline.stage]
  const base = { thesis, pipelineStage: pipeline.stage }
  if (pipeline.stage === 'new-case' && !inputs.caseAvailable) {
    return { stage, action: 'none', waitingFor: `a case artifact for ${pipeline.misconception}`, ...base }
  }
  if (!inputs.directiveDelivered) {
    return {
      stage,
      action: 'deliver',
      ...(pipeline.waitingFor === undefined ? {} : { waitingFor: pipeline.waitingFor }),
      ...base,
    }
  }
  if (inputs.learnerSpokeAfterDirective) return { stage, action: 'advance', ...base }
  return { stage, action: 'none', waitingFor: `a learner message after the ${STAGE_NOUN[pipeline.stage]}`, ...base }
}
