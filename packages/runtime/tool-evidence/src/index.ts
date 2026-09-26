/**
 * Model-facing research recording: the three tools a task uses to state what it
 * observed, what it now asserts, and what it is still testing, so the knowledge
 * plane is written through the kernel's own API instead of being inferred from
 * transcript text.
 *
 * `record_evidence` writes one {@link EvidenceInput}; `record_claim` writes one
 * {@link TaskClaimInput} citing the evidence this session already recorded;
 * `record_hypothesis` writes one {@link TaskHypothesisInput} citing the claims
 * that bear on its question. All are refused when no kernel is mounted or the
 * caller names no task, because a record nobody owns would be a durable fact
 * without a task to answer to.
 *
 * @module @deepseek-ai/dsh-tool-evidence
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  EvidenceId, EvidenceKind, TaskClaimId,
} from '@deepseek-ai/dsh-agent-kernel'

export const name = 'tool-evidence'
export const inject = ['tools']

/** The evidence families a model may record. */
const EVIDENCE_KINDS = ['file', 'tool-result', 'web', 'mcp', 'test', 'user', 'model'] as const
/** The claim statuses a model may state. */
const CLAIM_STATUSES = ['proposed', 'supported', 'contradicted', 'stale', 'rejected'] as const
/** The hypothesis statuses a model may state. */
const HYPOTHESIS_STATUSES = ['open', 'supported', 'refuted', 'inconclusive'] as const
/** The trust labels a model may attach to what it read. */
const TRUST_LABELS = ['trusted', 'untrusted', 'unknown'] as const

/** Model-facing research tool configuration. */
export interface Config {
  /** Maximum characters accepted in one evidence locator, claim statement, or hypothesis question. */
  maxTextChars?: number
}

/**
 * Register the research tools on this context.
 * @param ctx - the plugin context, providing `tools`.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxTextChars = config.maxTextChars ?? 2_000
  ctx.tools.register(defineTool({
    name: 'record_evidence',
    description:
      'Record one observation as evidence the task can later cite: what kind it is, where the content is, and how far it may be trusted. '
      + 'Record evidence when you read a file, run a check, or receive a result you intend to reason from.',
    parameters: {
      kind: { type: 'string', description: 'Where the observation came from.', enum: [...EVIDENCE_KINDS] },
      contentRef: { type: 'string', required: true, description: 'Repository-relative path, URL, or tool call id locating the content.' },
      digest: { type: 'string', description: 'Digest of the observed content, when you computed one.' },
      trust: { type: 'string', description: 'How far the content may be trusted.', enum: [...TRUST_LABELS] },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { evidenceId: { type: 'string' }, kind: { type: 'string' }, contentRef: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Recorded evidence ${value.evidenceId} (${value.kind}) for ${value.contentRef}` }],
    },
    async execute(args, exec) {
      const kernel = ctx.get('agentKernel')
      const agent = exec.agent
      if (kernel === undefined || agent === undefined) {
        throw new Error('record_evidence requires an agent running under an agent kernel')
      }
      const contentRef = bounded(args.contentRef, maxTextChars)
      const evidence = kernel.recordEvidence(agent, {
        kind: args.kind as EvidenceKind,
        contentRef,
        ...args.digest === undefined ? {} : { digest: bounded(args.digest, maxTextChars) },
        sourceRef: { source: 'model', locator: String(exec.callId) },
        trust: (args.trust ?? 'unknown'),
      })
      return await Promise.resolve({ evidenceId: String(evidence.evidenceId), kind: evidence.kind, contentRef: evidence.contentRef })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'record_claim',
    description:
      'Record what the task now asserts, citing the evidence you recorded, with your confidence and how well the evidence establishes it. '
      + 'A claim without evidence is a proposal, not a finding.',
    parameters: {
      statement: { type: 'string', required: true, description: 'The statement the task asserts.' },
      evidenceIds: { type: 'array', items: { type: 'string' }, description: 'Evidence identities this claim cites.' },
      confidence: { type: 'number', required: true, description: 'Confidence in [0, 1].' },
      status: { type: 'string', description: 'How far the evidence establishes the statement.', enum: [...CLAIM_STATUSES] },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { claimId: { type: 'string' }, statement: { type: 'string' }, status: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Recorded claim ${value.claimId} (${value.status}): ${value.statement}` }],
    },
    async execute(args, exec) {
      const kernel = ctx.get('agentKernel')
      const agent = exec.agent
      if (kernel === undefined || agent === undefined) {
        throw new Error('record_claim requires an agent running under an agent kernel')
      }
      const claim = kernel.recordClaim(agent, {
        statement: bounded(args.statement, maxTextChars),
        ...args.evidenceIds === undefined ? {} : { evidence: args.evidenceIds.map(id => brandString<EvidenceId>(id)) },
        confidence: clampConfidence(args.confidence),
        ...args.status === undefined ? {} : { status: args.status },
      })
      return await Promise.resolve({ claimId: String(claim.claimId), statement: claim.statement, status: claim.status })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'record_hypothesis',
    description:
      'Record the question the task is testing, citing the claims that bear on it and how far they have settled it. '
      + 'Record a hypothesis when the task is investigating rather than asserting, so the question it is still answering stays durable.',
    parameters: {
      question: { type: 'string', required: true, description: 'The question being tested.' },
      claimIds: { type: 'array', items: { type: 'string' }, description: 'Claim identities that bear on the question.' },
      status: { type: 'string', description: 'How far the recorded claims have settled the question.', enum: [...HYPOTHESIS_STATUSES] },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { hypothesisId: { type: 'string' }, question: { type: 'string' }, status: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Recorded hypothesis ${value.hypothesisId} (${value.status}): ${value.question}` }],
    },
    async execute(args, exec) {
      const kernel = ctx.get('agentKernel')
      const agent = exec.agent
      if (kernel === undefined || agent === undefined) {
        throw new Error('record_hypothesis requires an agent running under an agent kernel')
      }
      const hypothesis = kernel.recordHypothesis(agent, {
        question: bounded(args.question, maxTextChars),
        ...args.claimIds === undefined ? {} : { claims: args.claimIds.map(id => brandString<TaskClaimId>(id)) },
        ...args.status === undefined ? {} : { status: args.status },
      })
      return await Promise.resolve({
        hypothesisId: String(hypothesis.hypothesisId), question: hypothesis.question, status: hypothesis.status,
      })
    },
  }))
}

/**
 * Trim model-supplied text to the configured ceiling.
 * @param text - the supplied text.
 * @param maxChars - the ceiling in UTF-16 characters.
 * @returns the text, truncated at the ceiling.
 */
function bounded(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

/**
 * Clamp a stated confidence into `[0, 1]`.
 * @param confidence - the stated confidence.
 * @returns the clamped value.
 */
function clampConfidence(confidence: number): number {
  return Math.min(1, Math.max(0, confidence))
}
