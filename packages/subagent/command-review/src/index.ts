/**
 * Human-facing `/review` command: delegates a diff to an independent reviewer subagent — a
 * fresh context and, where configured, a different model — and reports its structured findings
 * directly to the invoking user without sending anything to the parent's own model (§10.6).
 * @module @deepseek-ai/dsh-command-review
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'

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

const USAGE = 'Usage: /review [<ref>] — reviews the diff against <ref> (a branch or commit); omitted reviews uncommitted working-tree changes'

/** One reported finding, in the reviewer's own words. */
interface ReviewFinding {
  file: string
  line?: string
  severity: 'high' | 'medium' | 'low'
  message: string
}

/** The reviewer's complete structured report. */
interface ReviewReport {
  summary: string
  findings: ReviewFinding[]
}

/** Object-rooted JSON Schema the reviewer's final turn must satisfy. */
const REVIEW_OUTPUT_SCHEMA: ObjectJsonSchema = {
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

/** Build the reviewer's task prompt for one diff target. */
function reviewPrompt(ref: string): string {
  const target = ref.length === 0
    ? 'the uncommitted working-tree changes (run `git diff HEAD` yourself to see them)'
    : `the diff between the current working tree and ${JSON.stringify(ref)} (run \`git diff ${ref}\` yourself to see it)`
  return `You are an independent code reviewer with no context beyond this repository and this task. Review ${target}.\n\n`
    + 'Read only the changed lines and their immediate surrounding context — do not review unrelated code, and do not make any edits. '
    + 'Report every real defect, security issue, or correctness risk you find, each with the file path, a line number or range when applicable, '
    + 'a severity of "high", "medium", or "low", and a one-sentence description. Do not report style preferences or anything the diff does not touch. '
    + 'If the diff has no defects, return an empty findings list and say so in the summary.'
}

/** Render a settled reviewer result as the command's plain-text output. */
function renderReview(result: SubagentResult): CommandResult {
  if (result.stopReason !== 'completed') {
    const detail = result.diagnostic !== undefined ? ` — ${result.diagnostic}` : ''
    return { kind: 'error', text: `/review: the independent reviewer did not finish (${result.stopReason})${detail}` }
  }
  const report = result.structured as ReviewReport | undefined
  if (report === undefined) {
    return { kind: 'error', text: '/review: the reviewer finished without returning a structured report' }
  }
  const lines = [report.summary, '']
  if (report.findings.length === 0) {
    lines.push('No findings.')
  } else {
    const bySeverity = { high: [] as ReviewFinding[], medium: [] as ReviewFinding[], low: [] as ReviewFinding[] }
    for (const finding of report.findings) bySeverity[finding.severity].push(finding)
    for (const severity of ['high', 'medium', 'low'] as const) {
      for (const finding of bySeverity[severity]) {
        const location = finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file
        lines.push(`[${severity}] ${location} — ${finding.message}`)
      }
    }
  }
  return { kind: 'success', text: lines.join('\n') }
}

/** Execute one `/review` invocation: start the reviewer, await its report, render it. */
async function executeReview(ctx: Context, config: Config, invocation: CommandInvocation): Promise<CommandResult> {
  const ref = invocation.rawInput.trim()
  const agentOptions: AgentOptions = {
    ...config.provider === undefined ? {} : { provider: config.provider },
    ...config.model === undefined ? {} : { model: config.model },
  }
  const providerName = config.subagentProvider ?? 'spawn'
  let run: Awaited<ReturnType<Context['subagents']['start']>>
  try {
    run = await ctx.subagents.start(providerName, {
      label: 'review',
      prompt: [{ type: 'text', text: reviewPrompt(ref) }],
      parent: invocation.agent,
      signal: invocation.signal,
      outputSchema: REVIEW_OUTPUT_SCHEMA,
      ...Object.keys(agentOptions).length > 0 ? { agentOptions } : {},
    })
  } catch (error: unknown) {
    return { kind: 'error', text: `/review: could not start the reviewer (provider "${providerName}"): ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    return renderReview(await run.result)
  } finally {
    await run.dispose().catch(() => undefined)
  }
}

/** Register `/review` for every composed command adapter. */
export function apply(ctx: Context, config: Config): void {
  ctx.commands.register({
    name: 'review',
    description: 'Review a diff with an independent reviewer subagent',
    input: { hint: '[<ref>]' },
    recordInput: false,
    handler: invocation => invocation.rawInput.trim() === '--help'
      ? { kind: 'success', text: USAGE }
      : executeReview(ctx, config, invocation),
  })
}
