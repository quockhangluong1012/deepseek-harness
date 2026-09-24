/**
 * The kernel-task Conversation Node: one durable Chat node per task contract,
 * folding the kernel's own records — status transitions, plan revisions,
 * verification results, checkpoints, open actions, unresolved failures, and
 * the research record — into the facts a reader needs without opening the log.
 *
 * The node is a VIEW. The kernel, the session log, and the completion gate stay
 * the owners of every fact it shows: a status a node renders is the last
 * transition the log recorded, not a second state machine.
 *
 * @module @deepseek-ai/dsh-client-ui-kernel-task/client
 */

import type {
  ConversationLocation, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-agent-kernel/src/types.ts'
import type {
  CriterionResult, EvidenceKind, FailureKind, Provenance, ResourceBudget, TaskClaimStatus, TaskStatus, TrustLabel,
} from '@deepseek-ai/dsh-agent-kernel/src/types.ts'

/** Final renderer data for one verification result. */
export interface KernelTaskVerificationData {
  /** Aggregate status the verifier reported. */
  readonly status: 'pass' | 'fail' | 'unknown'
  /** Per-criterion outcomes, in criterion order. */
  readonly criteria: readonly CriterionResult[]
  /** Verifier version that produced the result. */
  readonly verifierVersion: string
}

/** Final renderer data for one checkpoint. */
export interface KernelTaskCheckpointData {
  /** Checkpoint identity. */
  readonly checkpointId: string
  /** Why the kernel recorded it. */
  readonly reason: string
  /** Task revision the checkpoint covers. */
  readonly revision: number
  /** Session sequence the checkpoint covers. */
  readonly sessionSeq: number
}

/** One evidence record a claim's lineage cites (S1: evidence lineage). */
export interface KernelTaskEvidenceData {
  /** Evidence identity. */
  readonly evidenceId: string
  /** Family that observed it. */
  readonly kind: EvidenceKind
  /** Repository-relative path, URL, or tool call id locating the content. */
  readonly contentRef: string
  /** How far the observed content may be trusted. */
  readonly trust: TrustLabel
  /** Emitting subsystem or external boundary that produced the observation. */
  readonly source: Provenance['source']
}

/** One claim's current state, resolved with the evidence it cites (S1: evidence lineage). */
export interface KernelTaskClaimData {
  /** Claim identity. */
  readonly claimId: string
  /** The statement the task asserts. */
  readonly statement: string
  /** How far the evidence has established the statement. */
  readonly status: TaskClaimStatus
  /** Stated confidence in `[0, 1]`. */
  readonly confidence: number
  /** The evidence this claim cites, resolved from the session's recorded evidence. */
  readonly evidence: readonly KernelTaskEvidenceData[]
}

/** Final keyed Chat payload for one kernel task. */
export interface KernelTaskData {
  /** Objective the task was opened with. */
  readonly objective: string
  /** Status of the last transition the log recorded. */
  readonly status: TaskStatus
  /**
   * Whether the recorded run stopped without a terminal status inside a closed
   * turn or step: the log holds no more events, so the task cannot still be
   * progressing.
   */
  readonly interrupted: boolean
  /** Task revision the contract carried. */
  readonly revision: number
  /** Agent profile the task runs under. */
  readonly agentProfile: string
  /** Policy profile the task runs under. */
  readonly policyProfile: string
  /** Ceilings the task was created with; an absent field is unbounded. */
  readonly budget: ResourceBudget
  /** Latest plan revision number, when the kernel recorded a plan. */
  readonly planRevision?: number
  /** Ordered steps of that plan. */
  readonly planSteps: readonly string[]
  /** Actions proposed and not yet committed. */
  readonly openActions: number
  /** Failures with no accepted resolution, by kind. */
  readonly unresolvedFailures: readonly FailureKind[]
  /** Newest verification result, when the gate ran. */
  readonly verification?: KernelTaskVerificationData
  /** Newest checkpoint, when one was recorded. */
  readonly checkpoint?: KernelTaskCheckpointData
  /** Evidence records the session holds for this task. */
  readonly evidence: number
  /** Claims the session recorded for this task. */
  readonly claims: number
  /** Hypotheses the session recorded for this task. */
  readonly hypotheses: number
  /** Claims recorded for this task, each resolved with the evidence it cites (S1: evidence lineage). */
  readonly claimRecords: readonly KernelTaskClaimData[]
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One durable task contract and the records folded against it. */
    'kernel-task': KernelTaskData
  }
}

/** The folded state a node keeps between events; the projection narrows it. */
export interface KernelTaskState {
  readonly objective: string
  readonly agentProfile: string
  readonly policyProfile: string
  readonly budget: ResourceBudget
  readonly status: TaskStatus
  readonly revision: number
  readonly planSteps: readonly string[]
  readonly planRevision?: number
  readonly openActions: readonly string[]
  readonly failures: readonly FailureKind[]
  readonly verification?: KernelTaskVerificationData
  readonly checkpoint?: KernelTaskCheckpointData
  readonly evidence: number
  readonly claims: number
  readonly hypotheses: number
  /** Evidence recorded for this task, by identity. */
  readonly evidenceById: Readonly<Record<string, KernelTaskEvidenceData>>
  /** Claims recorded for this task, by identity, evidence unresolved until projection. */
  readonly claimById: Readonly<Record<string, {
    readonly claimId: string
    readonly statement: string
    readonly status: TaskClaimStatus
    readonly confidence: number
    readonly evidenceIds: readonly string[]
  }>>
}

/** Whether a location's turn or step has closed, so a live run is interrupted. */
function locationClosed(location: ConversationLocation): boolean {
  if (location.kind === 'step') {
    return location.step.status === 'closed' || location.turn.status === 'closed'
  }
  return location.kind === 'turn' && location.turn.status === 'closed'
}

/** Whether a task status ends the task's life. */
function terminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/**
 * Fold one kernel event into the node's state. Every event this node does not
 * fold leaves the state untouched, so the fold is independent of the rest of
 * the log.
 * @param state - the state before the event.
 * @param event - the matched event.
 * @returns the state after it.
 */
export function foldKernelTask(state: KernelTaskState, event: SessionEvent): KernelTaskState {
  switch (event.type) {
    case 'task/transitioned':
      return { ...state, status: event.data.to }
    case 'task/plan':
      return { ...state, planRevision: event.data.revision, planSteps: [...event.data.steps] }
    case 'action/decided':
      return { ...state, openActions: [...state.openActions, String(event.data.proposal.actionId)] }
    case 'action/committed':
      return {
        ...state,
        openActions: state.openActions.filter(actionId => actionId !== String(event.data.actionId)),
      }
    case 'failure/recorded':
      return { ...state, failures: [...state.failures, event.data.kind] }
    case 'verification/result':
      return {
        ...state,
        verification: {
          status: event.data.status,
          criteria: [...event.data.criterionResults],
          verifierVersion: event.data.verifierVersion,
        },
      }
    case 'checkpoint/created':
      return {
        ...state,
        checkpoint: {
          checkpointId: String(event.data.checkpointId),
          reason: event.data.reason,
          revision: event.data.revision,
          sessionSeq: event.data.sessionSeq,
        },
      }
    case 'evidence/recorded': {
      const evidenceId = String(event.data.evidenceId)
      return {
        ...state,
        evidence: state.evidence + 1,
        evidenceById: {
          ...state.evidenceById,
          [evidenceId]: {
            evidenceId,
            kind: event.data.kind,
            contentRef: event.data.contentRef,
            trust: event.data.trust,
            source: event.data.provenance.source,
          },
        },
      }
    }
    case 'claim/updated': {
      const claimId = String(event.data.claimId)
      return {
        ...state,
        claims: state.claims + 1,
        claimById: {
          ...state.claimById,
          [claimId]: {
            claimId,
            statement: event.data.statement,
            status: event.data.status,
            confidence: event.data.confidence,
            evidenceIds: event.data.evidence.map(String),
          },
        },
      }
    }
    case 'hypothesis/updated':
      return { ...state, hypotheses: state.hypotheses + 1 }
    default:
      return state
  }
}

/**
 * Project the folded state into the facts the renderer shows.
 * @param context - the node context carrying the folded state and its start.
 * @returns the renderer data.
 */
export function projectKernelTask(context: ConversationNodeContext<KernelTaskState>): KernelTaskData {
  // A node with a start has a folded state; the framework types both as
  // optional on the shared context shape.
  const state = context.state as KernelTaskState
  const start = context.start
  const interrupted = start !== undefined && !terminal(state.status) && locationClosed(start.location)
  return {
    objective: state.objective,
    status: state.status,
    interrupted,
    revision: state.revision,
    agentProfile: state.agentProfile,
    policyProfile: state.policyProfile,
    budget: state.budget,
    ...state.planRevision === undefined ? {} : { planRevision: state.planRevision },
    planSteps: state.planSteps,
    openActions: state.openActions.length,
    unresolvedFailures: state.failures,
    ...state.verification === undefined ? {} : { verification: state.verification },
    ...state.checkpoint === undefined ? {} : { checkpoint: state.checkpoint },
    evidence: state.evidence,
    claims: state.claims,
    hypotheses: state.hypotheses,
    claimRecords: Object.values(state.claimById).map(claim => ({
      claimId: claim.claimId,
      statement: claim.statement,
      status: claim.status,
      confidence: claim.confidence,
      // Evidence recorded after the claim that cites it (or in a prefix this
      // node cannot see) resolves as an id-only, untrusted stub rather than
      // silently dropping the citation.
      evidence: claim.evidenceIds.map(evidenceId => state.evidenceById[evidenceId] ?? {
        evidenceId, kind: 'model', contentRef: '', trust: 'unknown', source: 'kernel',
      }),
    })),
  }
}

/** Durable kernel task records folded into one keyed Chat node. */
export const kernelTaskDefinition: ConversationNodeDefinition<KernelTaskState> = {
  kind: 'kernel-task',
  target: 'chat',
  match: (event) => {
    switch (event.type) {
      case 'task/created':
        return { id: String(event.data.taskId), role: 'start' }
      case 'task/transitioned':
      case 'task/plan':
      case 'action/decided':
      case 'action/committed':
      case 'failure/recorded':
      case 'verification/result':
      case 'checkpoint/created':
      case 'evidence/recorded':
      case 'claim/updated':
      case 'hypothesis/updated': {
        const taskId = event.data.metadata?.taskId
        return taskId === undefined ? null : { id: String(taskId), role: 'update' }
      }
      default:
        return null
    }
  },
  start: (_context, match) => {
    if (match.event.type !== 'task/created') {
      throw new Error('kernel-task start requires task/created')
    }
    const task = match.event.data
    return {
      objective: task.objective,
      agentProfile: task.agentProfile,
      policyProfile: task.policyProfile,
      budget: task.budget,
      status: task.status,
      revision: task.revision,
      planSteps: [],
      openActions: [],
      failures: [],
      evidence: 0,
      claims: 0,
      hypotheses: 0,
      evidenceById: {},
      claimById: {},
    }
  },
  // The matcher admitted only the kernel events above; the fold reads those.
  update: (context, match) => foldKernelTask(context.state as KernelTaskState, match.event as SessionEvent),
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    return {
      key: context.key,
      kind: 'kernel-task',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: projectKernelTask(context),
    }
  },
}
