/**
 * Rendering of one session's kernel record for the command line: a stable
 * text form for people and a JSON projection for scripts. Both read the same
 * folded record, so the two surfaces cannot disagree.
 * @module @deepseek-ai/dsh-kernel-ops/report
 */

import type { KernelMetrics, KernelRecord } from '@deepseek-ai/dsh-agent-kernel'
import type { ActionId, VerificationResult } from '@deepseek-ai/dsh-agent-kernel'
import type { ExperimentEnvelope } from '@deepseek-ai/dsh-evolution-lineage'

/** One `key: value` line, skipping values a record does not carry. */
function line(label: string, value: string | number | undefined): string[] {
  return value === undefined ? [] : [`${label}: ${String(value)}`]
}

/**
 * Human-readable summary of one session's kernel metrics.
 * @param metrics - the folded metrics.
 * @returns one line per printed fact.
 */
export function metricsLines(metrics: KernelMetrics): string[] {
  const pairs = (record: Readonly<Partial<Record<string, number>>>): string =>
    Object.entries(record).map(([key, value]) => `${key}=${String(value)}`).join(', ') || 'none'
  return [
    `tasksCreated: ${String(metrics.tasksCreated)}`,
    `taskOutcomes: ${pairs(metrics.taskOutcomes)}`,
    ...line('taskSuccessRate', metrics.taskSuccessRate),
    `verifications: ${String(metrics.verifications)} (${String(metrics.verificationsPassed)} passed)`,
    ...line('verificationPassRate', metrics.verificationPassRate),
    `steps: ${String(metrics.steps)}`,
    `toolCalls: ${String(metrics.toolCalls)}`,
    `actions: proposed=${String(metrics.actionsProposed)} succeeded=${String(metrics.actionsSucceeded)} failed=${String(metrics.actionsFailed)} denied=${String(metrics.actionsDenied)}`,
    `policyDenied: ${String(metrics.policyDenied)}`,
    `policyAsked: ${String(metrics.policyAsked)}`,
    `approvalsRejected: ${String(metrics.approvalsRejected)}`,
    `failures: ${pairs(metrics.failuresByKind)}`,
    `recovery: ${pairs(metrics.recoveryByAction)}`,
    `failuresWithoutRecovery: ${String(metrics.failuresWithoutRecovery)}`,
    `checkpoints: ${String(metrics.checkpoints)} (resumed ${String(metrics.checkpointResumes)})`,
    `retriedActions: ${String(metrics.retriedActions)}`,
    `unfinishedActions: ${String(metrics.unfinishedActions)}`,
  ]
}

/**
 * Human-readable summary of one task record.
 * @param record - the folded kernel record.
 * @returns one line per printed fact.
 */
export function taskLines(record: KernelRecord): string[] {
  const { task } = record
  return [
    ...line('session', task.runId),
    ...line('task', task.taskId),
    ...line('objective', task.objective),
    ...line('status', task.status),
    ...line('revision', task.revision),
    ...line('agentProfile', task.agentProfile),
    ...line('policyProfile', task.policyProfile),
    ...line('workspace', task.workspace?.root),
    ...line('parentTask', task.parentTaskId),
    ...line('budget', Object.keys(task.budget).length === 0 ? 'unbounded' : JSON.stringify(task.budget)),
    ...line('acceptance', task.acceptance.length === 0 ? 'none declared' : String(task.acceptance.length)),
    ...line('constraints', String(task.constraints.length)),
    ...line('planRevision', record.plan?.revision),
    ...line('planSteps', record.plan?.steps.length),
    ...line('steps', record.steps),
    ...line('toolCalls', record.toolCalls),
    ...line('wallMs', record.wallMs),
    ...line('openActions', record.openActionIds.join(', ') || 'none'),
    ...line('unresolvedFailures', record.unresolvedFailures.map(failure => failure.kind).join(', ') || 'none'),
    ...line('evidence', String(record.evidence.length)),
    ...line('claims', String(record.claims.length)),
    ...line('hypotheses', String(record.hypotheses.length)),
    ...line('checkpoint', record.checkpoint?.checkpointId),
    ...line('checkpointReason', record.checkpoint?.reason),
    ...line('delegation', record.delegation?.delegationId),
  ]
}

/**
 * Human-readable verification report for one task record.
 * @param record - the folded kernel record.
 * @param results - the recorded verification results, in log order.
 * @returns one line per printed fact.
 */
export function verificationLines(record: KernelRecord, results: readonly VerificationResult[]): string[] {
  const lines = [...line('task', record.task.taskId), ...line('revision', record.task.revision)]
  const latest = results.at(-1)
  if (latest === undefined) {
    return [...lines, 'verification: never run', `criteria: ${String(record.task.acceptance.length)} declared`, 'gate: unknown']
  }
  const failed = record.unresolvedFailures.map(failure => failure.kind)
  const blocked = failed.length > 0
  return [
    ...lines,
    `verification: ${latest.status}`,
    `verifier: ${latest.verifierVersion}`,
    ...latest.commands.length === 0 ? [] : [`commands: ${latest.commands.join(', ')}`],
    ...latest.criterionResults.map(result => `criterion ${result.criterionId}: ${result.status}${result.detail === undefined ? '' : ` — ${result.detail}`}`),
    `unresolvedFailures: ${failed.join(', ') || 'none'}`,
    `gate: ${latest.status === 'pass' && !blocked ? 'pass' : 'blocked'}`,
  ]
}

/**
 * Human-readable explanation of one action's recorded decision.
 * @param record - the folded kernel record.
 * @param rawActionId - the action id the caller asked about.
 * @returns one line per printed fact.
 * @throws When the log holds no proposal for that action id.
 */
export function policyLines(record: KernelRecord, rawActionId: string): string[] {
  const actionId = rawActionId as ActionId
  const proposal = record.proposals.get(actionId)
  if (proposal === undefined) {
    throw new Error(`no action ${JSON.stringify(rawActionId)} in this session log`)
  }
  const decision = record.authorizations.get(actionId)
  return [
    ...line('action', actionId),
    ...line('tool', proposal.toolName),
    ...line('source', proposal.source),
    ...line('trust', proposal.trust),
    ...line('taskRevision', proposal.taskRevision),
    ...line('attempts', record.attempts.get(actionId)),
    ...line('effect', decision?.effect),
    ...line('enforced', decision === undefined ? undefined : String(decision.enforced)),
    ...line('capabilities', decision?.capabilityGrants.join(', ')),
    ...line('sandboxMode', decision?.sandbox.mode),
    ...line('workspaceRoot', decision?.sandbox.workspaceRoot),
    ...line('delegation', decision?.delegationId),
    ...line('approval', record.approvals.get(actionId)),
    ...line('open', String(record.openActionIds.includes(actionId))),
    ...decision === undefined ? [] : decision.reasons.map(reason => `reason: ${reason}`),
    `arguments: ${JSON.stringify(proposal.arguments)}`,
  ]
}

/**
 * JSON projection of one session's kernel metrics.
 * @param metrics - the folded metrics.
 * @returns the metrics as plain JSON data.
 */
export function metricsJson(metrics: KernelMetrics): unknown {
  return { ...metrics }
}

/**
 * JSON projection of one task record.
 * @param record - the folded kernel record.
 * @returns plain JSON data, with the record's maps flattened to arrays.
 */
export function taskJson(record: KernelRecord): unknown {
  return {
    task: record.task,
    steps: record.steps,
    toolCalls: record.toolCalls,
    wallMs: record.wallMs,
    evidence: record.evidence,
    claims: record.claims,
    hypotheses: record.hypotheses,
    openActionIds: record.openActionIds,
    unresolvedFailures: record.unresolvedFailures,
    ...record.plan === undefined ? {} : { plan: record.plan },
    ...record.checkpoint === undefined ? {} : { checkpoint: record.checkpoint },
    ...record.delegation === undefined ? {} : { delegation: record.delegation },
  }
}

/**
 * JSON projection of one action's recorded decision.
 * @param record - the folded kernel record.
 * @param rawActionId - the action id the caller asked about.
 * @returns plain JSON data.
 * @throws When the log holds no proposal for that action id.
 */
export function policyJson(record: KernelRecord, rawActionId: string): unknown {
  const actionId = rawActionId as ActionId
  const proposal = record.proposals.get(actionId)
  if (proposal === undefined) {
    throw new Error(`no action ${JSON.stringify(rawActionId)} in this session log`)
  }
  return {
    proposal,
    ...record.authorizations.get(actionId) === undefined ? {} : { decision: record.authorizations.get(actionId) },
    attempts: record.attempts.get(actionId) ?? 0,
    ...record.approvals.get(actionId) === undefined ? {} : { approvalOutcome: record.approvals.get(actionId) },
    open: record.openActionIds.includes(actionId),
  }
}

/**
 * Human-readable summary of one recorded experiment envelope.
 * @param envelope - the envelope `evolutionLineage.replay()` returned.
 * @returns one line per printed fact.
 */
export function lineageLines(envelope: ExperimentEnvelope): string[] {
  return [
    `experiment: ${envelope.experimentId}`,
    `skill: ${envelope.skill}`,
    `outcome: ${envelope.outcome}`,
    ...line('operator', envelope.operator),
    ...line('hypothesis', envelope.hypothesis),
    `candidate: ${envelope.candidate}`,
    `tasks: ${envelope.tasks.join(', ') || 'none'}`,
    `metrics: pass ${String(envelope.metrics.pass)}, ${envelope.metrics.tokens} tokens, ${envelope.metrics.wallTimeMs}ms`,
    `regressions: ${envelope.regressions.join(', ') || 'none'}`,
    ...line('rejectedReason', envelope.rejectedReason),
    ...line('lessons', envelope.lessons),
    `dependencies: ${Object.entries(envelope.dependencies).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${String(value)}`).join(', ') || 'none'}`,
    `seeds: ${envelope.seeds.join(', ') || 'none'}`,
    `at: ${envelope.at}`,
  ]
}

/**
 * JSON projection of one recorded experiment envelope.
 * @param envelope - the envelope `evolutionLineage.replay()` returned.
 * @returns the envelope as plain JSON data.
 */
export function lineageJson(envelope: ExperimentEnvelope): unknown {
  return { ...envelope }
}
