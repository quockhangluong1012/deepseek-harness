/**
 * The verifier-first ladder (§12): five rungs, cheapest first, stopping at the
 * first rung that refuses. Levels 0 and 1 are deterministic and pure — the
 * frontmatter invariant `skill_manage edit` already enforces, then the name and
 * instruction invariants — so a candidate that fails them never spends a
 * simulator, a model, or a human, which is the spec's rule against an LLM judge
 * where a deterministic verifier exists.
 *
 * Levels 2 to 4 belong to the environment, so they are seams the caller mounts:
 * a domain simulator, an evaluator model, and a human decision. An absent seam
 * abstains, the ladder continues, and when nothing decides at all the verdict
 * is an abstention — never a fabricated pass.
 * @module @deepseek-ai/dsh-evolution-verifiers/src/ladder
 */

import { checkSkillName, splitFrontmatter, validateSkillHead } from '@deepseek-ai/dsh-evolution-skill-manage'
import type {
  VerifierJudgment,
  VerifierLevel,
  VerifierRequest,
  VerifierRungResult,
  VerifierSeam,
  VerifierVerdict,
} from './types.ts'

/** Display names of the five rungs, for verdict reasons and host logs. */
export const VERIFIER_LEVEL_NAMES: Readonly<Record<VerifierLevel, string>> = {
  0: 'schema',
  1: 'invariant',
  2: 'simulation',
  3: 'evaluator',
  4: 'human',
}

/** Level of the rung a full pass is credited to: the deepest one that ran. */
const HUMAN_REVIEW: VerifierLevel = 4

/**
 * Level 0 — schema: parseable frontmatter that still names this skill with a
 * routing description, the invariant the skill manager enforces on edit. A
 * body failing it would break the skill's discovery, so no higher rung runs.
 * @param name - skill name the body must keep.
 * @param body - candidate `SKILL.md` text.
 * @returns the schema judgment.
 */
export function verifySchema(name: string, body: string): VerifierJudgment {
  const split = splitFrontmatter(body)
  if (split === undefined) return { status: 'failed', reason: 'body has no frontmatter' }
  try {
    validateSkillHead(split.head, name)
  } catch (error) {
    /* v8 ignore next -- validateSkillHead throws Error exclusively; the String arm only guards a future throw shape. */
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
  return { status: 'passed', reason: `frontmatter parses and keeps name '${name}' with a description` }
}

/**
 * Level 1 — deterministic invariants: the skill name must be a legal catalog
 * name, and the text after the frontmatter must carry instructions. Both are
 * decided from the candidate alone, without a host.
 * @param name - skill name the candidate claims to be.
 * @param body - candidate `SKILL.md` text.
 * @returns the invariant judgment.
 */
export function verifyDeterministic(name: string, body: string): VerifierJudgment {
  try {
    checkSkillName(name)
  } catch (error) {
    /* v8 ignore next -- checkSkillName throws Error exclusively; the String arm only guards a future throw shape. */
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
  const split = splitFrontmatter(body)
  if (split === undefined) return { status: 'failed', reason: 'body has no frontmatter' }
  if (split.body.trim().length === 0) {
    return { status: 'failed', reason: 'body carries no instructions after its frontmatter' }
  }
  return { status: 'passed', reason: `'${name}' is a legal skill name with instructions to route on` }
}

/**
 * Consult one optional rung. An absent seam abstains with the reason naming
 * what the host did not mount; a mounted seam reports its own judgment,
 * including its own abstention when it cannot judge this candidate. A seam that
 * throws propagates: an unavailable simulator must fail the verification rather
 * than be counted as an abstention.
 * @param seam - the mounted rung, or undefined when the host mounts none.
 * @param absent - reason recorded when no seam is mounted.
 * @returns the rung's judgment.
 */
async function consult(seam: VerifierSeam | undefined, absent: string): Promise<VerifierJudgment> {
  if (seam === undefined) return { status: 'abstained', reason: absent }
  return await seam()
}

/**
 * Run the ladder over one candidate. Rungs run cheapest first; a rung that
 * refuses ends the run, so every rung above it is never consulted. A rung that
 * passes or abstains is recorded and the ladder continues.
 * @param request - candidate body plus the mounted seams for levels 2 to 4.
 * @returns the verdict, with every consulted rung and the level that decided.
 */
export async function runVerifierLadder(request: VerifierRequest): Promise<VerifierVerdict> {
  const names = VERIFIER_LEVEL_NAMES
  const rungs: VerifierRungResult[] = []
  const record = (level: VerifierLevel, judgment: VerifierJudgment): VerifierVerdict | undefined => {
    rungs.push({ level, ...judgment })
    if (judgment.status !== 'failed') return undefined
    return {
      name: request.name,
      status: 'failed',
      decidedBy: level,
      reason: `${names[level]}: ${judgment.reason}`,
      rungs: [...rungs],
    }
  }

  const schema = record(0, verifySchema(request.name, request.body))
  if (schema !== undefined) return schema
  const invariants = record(1, verifyDeterministic(request.name, request.body))
  if (invariants !== undefined) return invariants

  for (const rung of [
    { level: 2 as const, seam: request.simulation, absent: 'no domain simulator is mounted' },
    { level: 3 as const, seam: request.evaluator, absent: 'no evaluator model is mounted' },
    { level: 4 as const, seam: request.review, absent: 'no human review is recorded' },
  ]) {
    const verdict = record(rung.level, await consult(rung.seam, rung.absent))
    if (verdict !== undefined) return verdict
  }

  const abstained = rungs.filter(rung => rung.status === 'abstained')
  if (abstained.length === 0) {
    return {
      name: request.name,
      status: 'passed',
      decidedBy: HUMAN_REVIEW,
      reason: 'every rung of the ladder passed',
      rungs: [...rungs],
    }
  }
  return {
    name: request.name,
    status: 'abstained',
    decidedBy: null,
    reason: `nothing failed; ${abstained.length} of ${rungs.length} rungs abstained: ${
      abstained.map(rung => `${names[rung.level]} (${rung.reason})`).join('; ')
    }`,
    rungs: [...rungs],
  }
}
