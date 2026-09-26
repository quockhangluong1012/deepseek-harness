/**
 * The pure generation rules behind §45's adversarial loop: which §45 weakness
 * family a recorded observation targets, the probe that observation becomes,
 * and the §14 benchmark task that probe is admitted as. No I/O.
 * @module @deepseek-ai/dsh-evolution-actuator/src/probe
 */

import { createHash } from 'node:crypto'
import type { AdversarialCategory, ProbeInput } from '@deepseek-ai/dsh-evolution-adversary'
import type { BenchmarkInput } from '@deepseek-ai/dsh-evolution-benchmark'
import { MINED_TASK } from '@deepseek-ai/dsh-evolution-benchmark'
import type { RegressionDebt } from '@deepseek-ai/dsh-evolution-curator'
import type { UncertaintyKind, UncertaintySignal } from '@deepseek-ai/dsh-evolution-uncertainty'

/**
 * The §45 weakness family each recorded §43 uncertainty kind targets. §43
 * records where the system is uncertain and §45 names the family an adversarial
 * probe should exercise, so the two vocabularies line up kind by kind:
 * retrieval ambiguity is a retrieval trap, conflicting evidence is
 * contradictory evidence, an evaluator disagreement questions the evaluator it
 * came from, an unstable output sits on a case boundary, and a low-confidence
 * result is what an ambiguous instruction produces. The table is total, so
 * every recorded kind reaches a family and this loop never invents one.
 */
const FAMILY_BY_KIND: Readonly<Record<UncertaintyKind, AdversarialCategory>> = {
  disagreement: 'evaluator-gaming',
  'low-confidence': 'ambiguous-instruction',
  instability: 'edge-case',
  'retrieval-ambiguity': 'retrieval-trap',
  'conflicting-evidence': 'contradictory-evidence',
}

/** One generated probe with the recorded observation it was built from. */
export interface GeneratedProbe {
  /** The probe to record through the adversary store's `probe` path. */
  readonly probe: ProbeInput
  /** The recorded observation the probe text carries, as the benchmark gist. */
  readonly evidence: string
}

/**
 * Build the probe record for one recorded observation.
 *
 * Only the `Probe … for the recorded … weakness: '…'` template is this
 * package's wording: the family comes from the adversary store's closed
 * vocabulary and the observation is the recorded text verbatim, so a generated
 * probe cannot assert anything nothing recorded. The identity is sha256-hex over
 * the skill, the family, and the text, so the same recorded weakness is one
 * identity however often a pass reaches it and no identity this package mints
 * can carry a character a record key cannot. A generated probe reports
 * `foundWeakness: false`: the recorded evidence is what exposes the weakness,
 * and this probe has not been executed against a candidate, so claiming it found
 * one would report a run that never happened.
 * @param skill - the skill the probe targets.
 * @param category - the weakness family the probe exercises.
 * @param observation - the recorded observation, verbatim.
 * @returns the probe and the observation it was built from.
 */
function generated(skill: string, category: AdversarialCategory, observation: string): GeneratedProbe {
  const text = `Probe ${skill} for the recorded ${category} weakness: '${observation}'.`
  const digest = createHash('sha256').update(`${skill}\u0000${category}\u0000${text}`).digest('hex')
  return {
    probe: {
      probeId: `adversarial-${digest.slice(0, 32)}`,
      skill,
      category,
      probe: text,
      foundWeakness: false,
    },
    evidence: observation,
  }
}

/**
 * The adversarial probe one recorded §43 uncertainty signal grounds (§45). The
 * family is the one its kind targets and the probe carries the signal's own
 * note, so a probe traces to the observed uncertainty rather than to a prompt
 * this package made up. §43's signals become high-value evaluation targets, and
 * an adversarial probe is the sharpest form of one: the note names where the
 * system was unsure, and the probe asks a candidate to withstand that case.
 * @param signal - the recorded uncertainty signal.
 * @returns the probe and the note it was built from.
 */
export function signalProbe(signal: UncertaintySignal): GeneratedProbe {
  return generated(signal.skill, FAMILY_BY_KIND[signal.kind], signal.detail)
}

/**
 * The adversarial probe one open regression debt grounds (§45). A failure a
 * skill still owes an answer for is the harness's record of a failing tool
 * call — the debt's merge key is the tool and the message — so it targets the
 * `tool-failure` family, and the probe carries the failing result text.
 * @param debt - the open regression debt.
 * @returns the probe and the failure text it was built from.
 */
export function debtProbe(debt: RegressionDebt): GeneratedProbe {
  return generated(debt.name, 'tool-failure', debt.message)
}

/**
 * The §14 benchmark task one generated probe is admitted as. The probe's own
 * text is the task, so the benchmark store's content address deduplicates it
 * and the adversary store's probe and the evaluation task stay one scenario.
 * Sessions stay empty because neither source records which sessions saw the
 * failure, only how many, and the gist is the recorded observation the probe
 * was built from rather than the probe text built from it.
 * @param probe - the generated probe.
 * @returns the benchmark task to admit.
 */
export function probeTask(probe: GeneratedProbe): BenchmarkInput {
  return {
    capability: probe.probe.skill,
    task: probe.probe.probe,
    gists: [probe.evidence],
    sourceSessions: [],
    ...MINED_TASK,
  }
}
