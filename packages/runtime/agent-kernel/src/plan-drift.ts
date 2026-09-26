/**
 * Plan-drift detection: whether the actions a task observed still follow the
 * plan it recorded.
 *
 * A plan step is prose and an action is a tool call whose arguments are JSON,
 * so the two are compared by the words they share rather than by identity: a
 * step follows an action when the two share one token that carries meaning on
 * its own. Drift is the length of the trailing run of actions matching no step,
 * because a task that returns to its plan has repaired itself, and only a run
 * that keeps growing is the signal worth escalating.
 *
 * @module @deepseek-ai/dsh-agent-kernel/plan-drift
 */

/**
 * Tokens too common to mean anything on their own: a shared `the` is not
 * evidence that a step and an action are the same work.
 */
const STOP_WORDS: Readonly<Record<string, true>> = {
  all: true,
  and: true,
  any: true,
  are: true,
  can: true,
  each: true,
  for: true,
  from: true,
  has: true,
  have: true,
  into: true,
  its: true,
  must: true,
  not: true,
  only: true,
  should: true,
  than: true,
  that: true,
  the: true,
  their: true,
  then: true,
  this: true,
  use: true,
  using: true,
  was: true,
  were: true,
  when: true,
  which: true,
  while: true,
  will: true,
  with: true,
  you: true,
  your: true,
}

/** The tokens one plan step or one observed action contributes to the comparison. */
function tokensOf(text: string): ReadonlySet<string> {
  const tokens = new Set<string>()
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 3 || STOP_WORDS[word] === true) continue
    tokens.add(word)
  }
  return tokens
}

/** Whether one observed action shares a meaningful token with one plan step. */
function followsStep(step: ReadonlySet<string>, action: ReadonlySet<string>): boolean {
  for (const token of action) {
    if (step.has(token)) return true
  }
  return false
}

/**
 * Count the observed actions at the end of a sequence that follow no step of
 * one plan revision.
 * @param steps - the revision's ordered work items.
 * @param actionTexts - the actions observed since that revision, in log order.
 * @returns the trailing run matching no step; zero for a revision with no steps, which states nothing to follow.
 */
export function planDriftRun(steps: readonly string[], actionTexts: readonly string[]): number {
  const stepTokens = steps.map(tokensOf)
  if (stepTokens.length === 0) return 0
  let drift = 0
  for (const text of actionTexts) {
    const action = tokensOf(text)
    drift = stepTokens.some(step => followsStep(step, action)) ? 0 : drift + 1
  }
  return drift
}
