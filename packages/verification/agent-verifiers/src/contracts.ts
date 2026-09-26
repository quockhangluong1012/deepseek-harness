/**
 * What each supported family asks its reviewer and what shape of report it
 * requires back. The `security` and `review` families ask the review commands'
 * own question through the shared prompt builder, and the `browser` family
 * carries the one prompt this package owns; every family appends the criterion's
 * identity and statement.
 *
 * @module @deepseek-ai/dsh-agent-verifiers/contracts
 */

import type { AcceptanceCriterion } from '@deepseek-ai/dsh-agent-kernel'
import { REVIEW_OUTPUT_SCHEMA, reviewPrompt } from '@deepseek-ai/dsh-command-review'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { Config } from './index.ts'
import type { AgentVerifierFamily } from './types.ts'

/** How one family's reviewer is prompted and what it must return. */
export interface FamilyContract {
  /** Label persisted on the child run, so a reader of the log can tell the family. */
  readonly label: string
  /**
   * The family's task prompt for one criterion.
   * @param criterion - the criterion the reviewer must reach a verdict on.
   * @param config - the deployment's reviewer route, severity floor, and review ref.
   * @returns the prompt delivered as the child's user message.
   */
  readonly prompt: (criterion: AcceptanceCriterion, config: Config) => string
  /** Object-rooted JSON Schema the child's final turn must satisfy. */
  readonly outputSchema: ObjectJsonSchema
}

/** What the `browser` family's reviewer returns: whether the scenario held. */
const SCENARIO_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    passed: { type: 'boolean', description: 'Whether the scenario the criterion describes held when you exercised it.' },
    detail: { type: 'string', description: 'One or two sentences on what you did and what you observed.' },
    evidence: {
      type: 'array',
      items: { type: 'string', description: 'A path, URL, or tool call id locating what you observed.' },
      description: 'References locating the observations your verdict rests on.',
    },
  },
  required: ['passed', 'detail'],
}

/** The criterion's own statement, appended to every family prompt. */
function criterionClause(criterion: AcceptanceCriterion): string {
  return `\n\nAcceptance criterion "${criterion.id}": ${criterion.description}\n`
    + 'Reach a verdict on that criterion alone, and report nothing that does not bear on it.'
}

/** How each supported family is prompted and validated. */
export const FAMILY_CONTRACTS: Readonly<Record<AgentVerifierFamily, FamilyContract>> = {
  // The two findings families ask the question `/review` and `/security-review`
  // already ask, so a criterion and a command can never disagree about what a
  // reviewer was told to look for.
  security: {
    label: 'security-review',
    outputSchema: REVIEW_OUTPUT_SCHEMA,
    prompt: (criterion, config) => reviewPrompt('security', config.reviewRef ?? 'HEAD') + criterionClause(criterion),
  },
  browser: {
    label: 'browser-check',
    outputSchema: SCENARIO_OUTPUT_SCHEMA,
    prompt: (criterion, config) => 'You are an independent verifier whose job is to exercise a user-facing scenario in a real browser and report whether it held.\n\n'
      + 'Use the browser tools available to you to reach the application the criterion names — the URL, command, or fixture it mentions, or the one the repository '
      + `documents — and perform exactly the interaction it describes. Review the working tree as it is now (run \`git diff ${config.reviewRef ?? 'HEAD'}\` yourself to see what changed).\n\n`
      + 'Report `passed: true` only when you observed the criterion hold. Report `passed: false` with the observed failure when it did not, and with the reason you '
      + 'could not reach or exercise the application when that is why you could not confirm it. Put what you did and observed in `detail`, and every page URL, file '
      + 'path, or tool call id your verdict rests on in `evidence`. Make no edits.'
      + criterionClause(criterion),
  },
  review: {
    label: 'review',
    outputSchema: REVIEW_OUTPUT_SCHEMA,
    prompt: (criterion, config) => reviewPrompt('code', config.reviewRef ?? 'HEAD') + criterionClause(criterion),
  },
}
