/**
 * Human-facing review commands: `/review` and `/security-review` delegate a
 * diff to an independent reviewer subagent — a fresh context and, where
 * configured, a different model — and report its structured findings directly
 * to the invoking user without sending anything to the parent's own model
 * (§10.6). Both commands are ONE implementation: the reviewer spawn path, the
 * report schema, the durable `review/report` record, and the rendering are
 * shared, and the variants differ only in their prompt.
 * @module @deepseek-ai/dsh-command-review
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { REVIEW_OUTPUT_SCHEMA, reviewPrompt, runReviewer } from './reviewer.ts'
import type { ReviewFinding, ReviewKind, ReviewReport } from './reviewer.ts'

export { REVIEW_OUTPUT_SCHEMA, reviewPrompt, runReviewer }
export type {
  ReviewFinding, ReviewKind, ReviewReport, ReviewReportEvent, ReviewSeverity,
  ReviewerCaller, ReviewerConfig, ReviewerTask,
} from './reviewer.ts'

export const name = 'command-review'
export const inject = ['commands', 'subagents']

/** Plugin config: which delegation backend and model the reviewer runs under. */
export interface Config {
  /** `ctx.subagents` provider name the review delegates to. Defaults to `spawn` (a fresh, unrelated context). */
  subagentProvider?: string
  /** Provider route override for the reviewer child; omitted inherits the parent's route. */
  provider?: string
  /** Model id override for the reviewer child; omitted inherits the parent's model. */
  model?: string
}

export const Config: Schema<Config> = z.object({
  subagentProvider: z.string().min(1).default('spawn'),
  provider: z.string(),
  model: z.string(),
})

/** One review command: its identity, the diff it reviews, and its reviewer prompt kind. */
interface ReviewVariant {
  /** Lowercase command name without the leading slash. */
  readonly command: string
  /** Subagent run label persisted with a session-backed reviewer child. */
  readonly label: string
  /** Which review the shared prompt builder and the durable event resolve. */
  readonly kind: ReviewKind
  /** Registry description shown in discovery UI. */
  readonly description: string
  /** Usage text returned for `--help`. */
  readonly usage: string
}

/** Every registered review command, in registration order. */
const REVIEW_VARIANTS: readonly ReviewVariant[] = [
  {
    command: 'review',
    label: 'review',
    kind: 'code',
    description: 'Review a diff with an independent reviewer subagent',
    usage: 'Usage: /review [<ref>] — reviews the diff against <ref> (a branch or commit); omitted reviews uncommitted working-tree changes',
  },
  {
    command: 'security-review',
    label: 'security-review',
    kind: 'security',
    description: 'Review a diff for security defects with an independent reviewer subagent',
    usage: 'Usage: /security-review [<ref>] — reviews the diff against <ref> (a branch or commit) for security defects; omitted reviews uncommitted working-tree changes',
  },
]

/**
 * Render one settled report as the command's plain-text output: the summary,
 * then every finding grouped `high`, `medium`, `low`.
 * @param report - the reviewer's validated report.
 * @returns the plain-text rendering both adapters and users read.
 */
function renderReport(report: ReviewReport): string {
  const lines = [report.summary, '']
  if (report.findings.length === 0) {
    lines.push('No findings.')
    return lines.join('\n')
  }
  const bySeverity: Record<ReviewFinding['severity'], ReviewFinding[]> = { high: [], medium: [], low: [] }
  for (const finding of report.findings) bySeverity[finding.severity].push(finding)
  for (const severity of ['high', 'medium', 'low'] as const) {
    for (const finding of bySeverity[severity]) {
      const location = finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file
      lines.push(`[${severity}] ${location} — ${finding.message}`)
    }
  }
  return lines.join('\n')
}

/**
 * Execute one review invocation: start the reviewer, await its report, record it, render it.
 * @param ctx - context carrying the subagent service.
 * @param config - resolved plugin config: delegation backend and route overrides.
 * @param invocation - the dispatching UI's invocation.
 * @param variant - which review to run.
 * @returns the command outcome: the rendered report on success, a named failure otherwise.
 */
async function executeReview(
  ctx: Context,
  config: Config,
  invocation: CommandInvocation,
  variant: ReviewVariant,
): Promise<CommandResult> {
  const ref = invocation.rawInput.trim()
  let result: SubagentResult
  try {
    result = await runReviewer(ctx, config, {
      label: variant.label,
      prompt: reviewPrompt(variant.kind, ref),
      outputSchema: REVIEW_OUTPUT_SCHEMA,
    }, { parent: invocation.agent, signal: invocation.signal })
  } catch (error: unknown) {
    return { kind: 'error', text: `/${variant.command}: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (result.stopReason !== 'completed') {
    const detail = result.diagnostic !== undefined ? ` — ${result.diagnostic}` : ''
    return { kind: 'error', text: `/${variant.command}: the independent reviewer did not finish (${result.stopReason})${detail}` }
  }
  const report = result.structured as ReviewReport | undefined
  if (report === undefined) {
    return { kind: 'error', text: `/${variant.command}: the reviewer finished without returning a structured report` }
  }
  const recorded = invocation.agent.session.append('review/report', {
    commandId: invocation.commandId,
    kind: variant.kind,
    target: ref,
    summary: report.summary,
    findings: report.findings,
  })
  return { kind: 'success', text: renderReport(report), sourceEventSeq: recorded.seq }
}

/**
 * Register every review command for every composed command adapter.
 * @param ctx - context carrying the command registry and the subagent service.
 * @param config - resolved plugin config: delegation backend and route overrides.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(function* () {
    for (const variant of REVIEW_VARIANTS) {
      yield ctx.commands.register({
        name: variant.command,
        description: variant.description,
        input: { hint: '[<ref>]' },
        recordInput: false,
        handler: invocation => invocation.rawInput.trim() === '--help'
          ? { kind: 'success', text: variant.usage }
          : executeReview(ctx, config, invocation, variant),
      })
    }
  }, 'command-review registrations')
}
