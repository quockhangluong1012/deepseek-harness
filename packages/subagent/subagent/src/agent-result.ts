/**
 * The agent-result contract in code: the status vocabulary a settled child
 * result is classified into, the JSON Schema a delegation requests from a
 * child, the mapping from a settled run's stop reason to a status, and the gate
 * over the parent's consumption of the result.
 *
 * Nothing here writes to a session log. A contract reaches a model only through
 * the tool result of the delegation that asked for it, which the session
 * already records as that tool's result.
 *
 * @module @deepseek-ai/dsh-subagent/agent-result
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type {
  Action,
  AgentResult,
  AgentResultStatus,
  ArtifactRef,
  EvidenceRef,
  Finding,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from './types.ts'

/**
 * Every status, keyed for membership checks. The record is exhaustive over the
 * vocabulary, so a new status fails to compile until it is added here.
 */
const STATUS_NAMES: Record<AgentResultStatus, true> = {
  accepted: true,
  needs_more_evidence: true,
  invalid: true,
  contradictory: true,
  timeout: true,
}

/** Every status, for the contract schema. */
export const AGENT_RESULT_STATUSES: readonly AgentResultStatus[] = Object.keys(STATUS_NAMES) as readonly AgentResultStatus[]

/**
 * Object-rooted JSON Schema of `AgentResult`, for a delegation that wants a
 * child to answer in the contract. The payload members are required and may be
 * empty; `evidenceId` and the artifact `locator` name values the parent
 * resolves in the child's own session or workspace.
 */
export const AGENT_RESULT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: [...AGENT_RESULT_STATUSES],
      description: 'accepted when the result is complete, needs_more_evidence when it is incomplete, '
        + 'invalid when no usable result exists, contradictory when the findings conflict, timeout when the run ended without a result.',
    },
    findings: {
      type: 'array',
      description: 'Statements the child established, each with the observations behind it.',
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string', description: 'The statement the child established.' },
          evidence: {
            type: 'array',
            description: 'Observations the child cites for this statement.',
            items: { type: 'string', description: 'An evidenceId this result also lists in evidence.' },
          },
          confidence: { type: 'number', description: 'Confidence in the statement, from 0 to 1.' },
        },
        required: ['statement', 'evidence'],
      },
    },
    evidence: {
      type: 'array',
      description: 'Observations the child cites, each with its identity in the child\'s own session log.',
      items: {
        type: 'object',
        properties: {
          evidenceId: { type: 'string', description: 'Identity of the observation in the child\'s session log.' },
          kind: { type: 'string', description: 'Family that observed it: file, tool-result, web, mcp, test, user, or model.' },
          locator: { type: 'string', description: 'Repository-relative path, URL, or tool call id locating the content.' },
        },
        required: ['evidenceId', 'kind', 'locator'],
      },
    },
    artifacts: {
      type: 'array',
      description: 'Outputs the child produced for the parent to retrieve.',
      items: {
        type: 'object',
        properties: {
          locator: { type: 'string', description: 'Repository-relative path, URL, or attachment id locating the artifact.' },
          digest: { type: 'string', description: 'Digest of the artifact content, when the child computed one.' },
        },
        required: ['locator'],
      },
    },
    recommendedActions: {
      type: 'array',
      description: 'Actions the child recommends the parent take next.',
      items: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'What the parent is recommended to do.' },
          rationale: { type: 'string', description: 'Why the child recommends it.' },
        },
        required: ['instruction'],
      },
    },
    confidence: { type: 'number', description: 'Confidence in the whole result, from 0 to 1.' },
  },
  required: ['status', 'findings', 'evidence', 'artifacts', 'recommendedActions'],
}

/**
 * Classify a settled run's stop reason into the status vocabulary. A child that
 * reported no status of its own is classified by how its run ended:
 *
 * | stop reason | status | why |
 * |---|---|---|
 * | `completed` | `accepted` | the child finished its turn normally |
 * | `max-tokens` | `needs_more_evidence` | the child was cut off before it finished, so its answer is incomplete |
 * | `aborted` | `timeout` | the run was stopped from outside before it produced a result |
 * | `error` | `invalid` | a model or transport failure produced no usable answer |
 * | `refusal` | `invalid` | the child declined the task, so there is no result to consume |
 * | a backend-added reason | `invalid` | an unrecognized terminal reason is never success |
 *
 * `timeout` covers a run stopped by a limit rather than by its content, which
 * includes cancellation: neither leaves a result the parent may consume.
 * @param stopReason - how the child's run ended.
 * @returns the status the parent gates on.
 */
export function agentResultStatusFor(stopReason: SubagentStopReason): AgentResultStatus {
  switch (stopReason) {
    case 'completed':
      return 'accepted'
    case 'max-tokens':
      return 'needs_more_evidence'
    case 'aborted':
      return 'timeout'
    case 'error':
    case 'refusal':
      return 'invalid'
    // Merge-extensible union: a backend-added terminal reason is not success.
    default:
      return 'invalid'
  }
}

/** Whether one value names a status of the vocabulary. */
function isAgentResultStatus(value: unknown): value is AgentResultStatus {
  return typeof value === 'string' && STATUS_NAMES[value as AgentResultStatus] === true
}

/**
 * Read the contract from a settled child's structured value, or `undefined`
 * when the value is not one. The status and the four payload members are
 * checked here; the members' contents are carried as the child returned them,
 * because the structured-output tool of the delegation that requested the
 * contract already validated them against the schema it requested.
 * @param value - a settled result's `structured` value.
 * @returns the contract, or `undefined` when the value is not one.
 */
export function readAgentResult(value: unknown): AgentResult | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const status = record.status
  if (!isAgentResultStatus(status)) return undefined
  const findings = record.findings
  const evidence = record.evidence
  const artifacts = record.artifacts
  const recommendedActions = record.recommendedActions
  if (!Array.isArray(findings) || !Array.isArray(evidence)
    || !Array.isArray(artifacts) || !Array.isArray(recommendedActions)) return undefined
  const confidence = record.confidence
  if (confidence !== undefined && typeof confidence !== 'number') return undefined
  return {
    status,
    findings: findings as readonly Finding[],
    evidence: evidence as readonly EvidenceRef[],
    artifacts: artifacts as readonly ArtifactRef[],
    recommendedActions: recommendedActions as readonly Action[],
    ...confidence === undefined ? {} : { confidence },
  }
}

/**
 * The contract of one settled run: the status the child reported when it
 * returned the contract shape, otherwise the status its stop reason classifies
 * to; the child's reported payload rides along either way.
 *
 * A run that did not end `completed` is never `accepted` — the run's own
 * outcome dominates any status a child reported, so a child cannot report
 * success out of a failed run.
 * @param result - the terminal result of a one-shot run.
 * @returns the contract a parent consumes, the attached one when present.
 */
export function agentResultOf(result: SubagentResult): AgentResult {
  if (result.agentResult !== undefined) return result.agentResult
  const reported = readAgentResult(result.structured)
  return {
    status: result.stopReason === 'completed'
      ? reported?.status ?? 'accepted'
      : agentResultStatusFor(result.stopReason),
    findings: reported?.findings ?? [],
    evidence: reported?.evidence ?? [],
    artifacts: reported?.artifacts ?? [],
    recommendedActions: reported?.recommendedActions ?? [],
    ...reported?.confidence === undefined ? {} : { confidence: reported.confidence },
  }
}

/**
 * Settle one published run with its contract attached, so every consumer reads
 * one derivation from one place instead of classifying a stop reason itself.
 * @param run - the run the seam hands a caller.
 * @returns the same run, whose result carries {@link AgentResult}.
 */
export function withAgentResult(run: SubagentRun): SubagentRun {
  return {
    id: run.id,
    localAgent: run.localAgent,
    result: run.result.then(result => ({ ...result, agentResult: agentResultOf(result) })),
    dispose: () => run.dispose(),
  }
}

/** The follow-up allowance one delegation still has for a non-accepted result. */
export interface AgentResultFollowUp {
  /** Follow-up runs already started for this delegation. */
  readonly used: number
  /** Follow-up runs this delegation's configuration allows; `0` forbids them. */
  readonly limit: number
  /** Whether the parent can still afford one more child run. */
  readonly affordable: boolean
}

/** The follow-up allowance of a consumer that starts no follow-up run of its own. */
export const NO_FOLLOW_UP: AgentResultFollowUp = { used: 0, limit: 0, affordable: false }

/** What a parent may do with one settled result. */
export type AgentResultGate =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'follow-up'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string }

/** Why one non-accepted status must not be consumed, in the parent's terms. */
const REFUSAL_REASONS = {
  invalid: 'the child reported that it could not produce a usable result',
  contradictory: 'the child reported findings that contradict each other',
  timeout: 'the run ended without producing a result',
} as const satisfies Record<Exclude<AgentResultStatus, 'accepted' | 'needs_more_evidence'>, string>

/**
 * Decide whether a parent may consume one settled result. `accepted` is
 * consumed as it stands; `needs_more_evidence` asks for one more child run
 * while the delegation's follow-up allowance and the parent's budget both
 * permit it; `invalid`, `contradictory`, and `timeout` are refused with the
 * reason the parent reports in place of a result.
 * @param result - the contract the settled result carries.
 * @param followUp - follow-ups already used, allowed, and affordable.
 * @returns the decision over the parent's consumption.
 */
export function gateAgentResult(result: AgentResult, followUp: AgentResultFollowUp): AgentResultGate {
  switch (result.status) {
    case 'accepted':
      return { kind: 'accepted' }
    case 'needs_more_evidence':
      if (followUp.limit - followUp.used <= 0) {
        return {
          kind: 'rejected',
          reason: 'subagent result needs more evidence and the delegation\'s follow-up allowance is spent'
            + ` (${String(followUp.used)} of ${String(followUp.limit)})`,
        }
      }
      if (!followUp.affordable) {
        return { kind: 'rejected', reason: 'subagent result needs more evidence and the parent has no budget left for another child run' }
      }
      return { kind: 'follow-up', reason: 'subagent result needs more evidence' }
    case 'invalid':
    case 'contradictory':
    case 'timeout':
      return { kind: 'rejected', reason: `subagent result is ${result.status}: ${REFUSAL_REASONS[result.status]}` }
    default:
      return assertNever(result.status, 'AgentResultStatus')
  }
}
