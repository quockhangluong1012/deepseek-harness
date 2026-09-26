/**
 * The independent-reviewer seam both review commands share: one spawn path
 * parameterized by label, prompt, and report schema; the report vocabulary
 * those schemas require; and the durable `review/report` event a client review
 * panel reads back (§10.6 Independent reviewer).
 * @module @deepseek-ai/dsh-command-review/reviewer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'

/** Which review produced a report. */
export type ReviewKind = 'code' | 'security'

/** How much a reported finding matters. */
export type ReviewSeverity = 'high' | 'medium' | 'low'

/** One reported finding, in the reviewer's own words. */
export interface ReviewFinding {
  /** Path of the file the finding is about, relative to the repository root. */
  readonly file: string
  /** Line number or range the finding is about, if applicable. */
  readonly line?: string
  /** How much the finding matters. */
  readonly severity: ReviewSeverity
  /** One sentence describing the concrete defect, security issue, or correctness risk. */
  readonly message: string
}

/** The reviewer's complete structured report. */
export interface ReviewReport {
  /** One or two sentences on what the diff does and the overall review verdict. */
  readonly summary: string
  /** Every finding the reviewer reported; empty when the diff is clean. */
  readonly findings: readonly ReviewFinding[]
}

/** Object-rooted JSON Schema every review variant's final turn must satisfy. */
export const REVIEW_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences on what the diff does and the overall review verdict.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path of the file the finding is about, relative to the repository root.' },
          line: { type: 'string', description: 'Line number or range the finding is about, if applicable.' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          message: { type: 'string', description: 'One sentence describing the concrete defect, security issue, or correctness risk.' },
        },
        required: ['file', 'severity', 'message'],
      },
    },
  },
  required: ['summary', 'findings'],
}

/**
 * One settled independent review as it is durably recorded for the Session.
 * Log-only: it never enters a model request. The client review panel renders
 * it, and the producing command's `command/done.sourceEventSeq` points back at
 * it. Required-on-read, like every in-repo event: a build that does not know
 * the type refuses the log rather than silently dropping a report the invoking
 * user is entitled to see.
 */
export interface ReviewReportEvent {
  /** The command invocation that produced this report. */
  readonly commandId: CommandId
  /** Which review variant produced it. */
  readonly kind: ReviewKind
  /** The reviewed diff target: empty for uncommitted changes, else the reference or commit. */
  readonly target: string
  /** One or two sentences on what the diff does and the overall review verdict. */
  readonly summary: string
  /** Every reported finding, in the reviewer's own order. */
  readonly findings: readonly ReviewFinding[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One settled independent review; log-only, with no surface effect. */
    'review/report': ReviewReportEvent
  }
}

/**
 * Name the diff a reviewer must inspect, in terms of the `git diff` invocation it runs itself.
 * @param ref - the reference or commit to compare against, or the empty string for uncommitted changes.
 * @returns the target phrase every review prompt embeds.
 */
function diffTarget(ref: string): string {
  return ref.length === 0
    ? 'the uncommitted working-tree changes (run `git diff HEAD` yourself to see them)'
    : `the diff between the current working tree and ${JSON.stringify(ref)} (run \`git diff ${ref}\` yourself to see it)`
}

/** Instruction every review kind shares: scope, and the no-edit rule. */
const REVIEW_SCOPE = 'Read only the changed lines and their immediate surrounding context — do not review unrelated code, and do not make any edits. '

/** How each review kind presents the reviewer's role to the model. */
const REVIEW_ROLE: Record<ReviewKind, string> = {
  code: 'code reviewer',
  security: 'security reviewer',
}

/** What each review kind reports, and what it deliberately leaves to the other. */
const REVIEW_FOCUS: Record<ReviewKind, string> = {
  code: 'Report every real defect, security issue, or correctness risk you find, each with the file path, a line number or range when applicable, '
    + 'a severity of "high", "medium", or "low", and a one-sentence description. Do not report style preferences or anything the diff does not touch. '
    + 'If the diff has no defects, return an empty findings list and say so in the summary.',
  security: 'Report only security defects the changed lines introduce or expose: injection (SQL, command, template, or path), '
    + 'broken authentication or authorization, missing validation at a trust boundary, exposed secrets or credentials, unsafe deserialization, '
    + 'path traversal, server-side request forgery, cross-site scripting, unsafe cryptography or randomness, permissive CORS, and unsafe defaults. '
    + 'Name the vulnerability class in each message, with the file path, a line number or range when applicable, and a severity of "high", "medium", or "low". '
    + 'Do not report style, performance, or general correctness issues unless they are exploitable. '
    + 'If the diff has no security defects, return an empty findings list and say so in the summary.',
}

/**
 * Build the task prompt one independent reviewer receives for a review kind
 * and diff target. Every review caller — the two commands and the composition
 * that supplies the agent kernel's reviewer port — asks the same question
 * through this one builder.
 * @param kind - which review is asking.
 * @param ref - the reference or commit to compare against, or the empty string for uncommitted changes.
 * @returns the reviewer's complete task prompt.
 */
export function reviewPrompt(kind: ReviewKind, ref: string): string {
  return `You are an independent ${REVIEW_ROLE[kind]} with no context beyond this repository and this task. `
    + `Review ${diffTarget(ref)}.\n\n${REVIEW_SCOPE}${REVIEW_FOCUS[kind]}`
}

/**
 * Which delegation backend and model an independent reviewer child runs under.
 */
export interface ReviewerConfig {
  /** `ctx.subagents` provider name to delegate to. Defaults to `spawn` (a fresh, unrelated context). */
  readonly subagentProvider?: string
  /** Provider route override for the reviewer child; omitted inherits the parent's route. */
  readonly provider?: string
  /** Model id override for the reviewer child; omitted inherits the parent's model. */
  readonly model?: string
}

/** One independent-review task: the child's label, its prompt, and its required report shape. */
export interface ReviewerTask {
  /** Subagent run label persisted with a session-backed reviewer child. */
  readonly label: string
  /** The reviewer's full task prompt. */
  readonly prompt: string
  /** Object-rooted JSON Schema the reviewer's final turn must satisfy. */
  readonly outputSchema: ObjectJsonSchema
}

/** Where an independent reviewer is started from. */
export interface ReviewerCaller {
  /** The invoking agent; the child inherits its workspace, lineage, and route. */
  readonly parent: Agent
  /** Cancellation owned by the caller's request. */
  readonly signal: AbortSignal
}

/**
 * Run one independent reviewer to completion and return its settled result.
 * Every review variant shares this single spawn path: it starts the configured
 * provider with the task's prompt and output schema, awaits the run, and
 * always disposes it.
 * @param ctx - context carrying the subagent service.
 * @param config - delegation backend and route overrides.
 * @param task - child label, task prompt, and required report schema.
 * @param caller - the invoking agent and its cancellation signal.
 * @returns the reviewer's settled result; a child-level failure resolves with a stop reason other than `completed`.
 * @throws when the configured provider cannot start the child.
 */
export async function runReviewer(
  ctx: Context,
  config: ReviewerConfig,
  task: ReviewerTask,
  caller: ReviewerCaller,
): Promise<SubagentResult> {
  const providerName = config.subagentProvider ?? 'spawn'
  const agentOptions: AgentOptions = {
    ...config.provider === undefined ? {} : { provider: config.provider },
    ...config.model === undefined ? {} : { model: config.model },
  }
  let run: SubagentRun
  try {
    run = await ctx.subagents.start(providerName, {
      label: task.label,
      prompt: [{ type: 'text', text: task.prompt }],
      parent: caller.parent,
      signal: caller.signal,
      outputSchema: task.outputSchema,
      ...Object.keys(agentOptions).length > 0 ? { agentOptions } : {},
    })
  } catch (error: unknown) {
    throw new Error(`could not start the reviewer (provider "${providerName}"): ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return await run.result
  } finally {
    await run.dispose().catch(() => undefined)
  }
}
