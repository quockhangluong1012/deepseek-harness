/**
 * The criterion verifier itself: it claims the families an independent agent
 * decides and answers each criterion from one reviewer's structured report.
 *
 * @module @deepseek-ai/dsh-agent-verifiers/verifier
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AcceptanceCriterion, CriterionVerdict, CriterionVerifier, VerificationRequest } from '@deepseek-ai/dsh-agent-kernel'
import { runReviewer } from '@deepseek-ai/dsh-command-review'
import type { ReviewFinding, ReviewReport, ReviewSeverity } from '@deepseek-ai/dsh-command-review'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { FAMILY_CONTRACTS } from './contracts.ts'
import { isAgentVerifierFamily } from './families.ts'
import type { Config } from './index.ts'
import type { ScenarioReport } from './types.ts'

/** Stable verifier identity the kernel records for every result this package produces. */
export const VERIFIER_ID = 'agent-verifiers'

/** How serious each severity is, so the configured floor is one comparison. */
const SEVERITY_RANK: Readonly<Record<ReviewSeverity, number>> = { low: 0, medium: 1, high: 2 }

/** The criterion verifier over the shared reviewer helper and one subagent per criterion. */
export class AgentCriterionVerifier implements CriterionVerifier {
  readonly id = VERIFIER_ID

  /**
   * @param ctx - the context whose `agents` supplies the reviewer's parent and whose `subagents` starts it.
   * @param config - the deployment's reviewer route, severity floor, and review ref.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  /**
   * Whether this deployment answers the criterion's family with an independent reviewer.
   * @param criterion - the criterion to test.
   * @returns true when this verifier ships a reviewer for the family.
   */
  supports(criterion: AcceptanceCriterion): boolean {
    return isAgentVerifierFamily(criterion.verifier)
  }

  /**
   * Start exactly one independent reviewer for the criterion and decide it from
   * the report. A reviewer that cannot start, does not finish, or returns no
   * report answers `fail`: a criterion is never left unresolved by a verifier
   * that claimed it.
   * @param request - the request the criterion belongs to.
   * @param criterion - the criterion to evaluate.
   * @returns the verdict, or undefined when the family is not this verifier's.
   */
  async verify(request: VerificationRequest, criterion: AcceptanceCriterion): Promise<CriterionVerdict | undefined> {
    if (!isAgentVerifierFamily(criterion.verifier)) return undefined
    const contract = FAMILY_CONTRACTS[criterion.verifier]
    const parent = this.ctx.agents.currentInitiator()
    if (parent === undefined) {
      return fail(criterion, [], 'no initiating agent is active, so no independent reviewer could be started for this criterion')
    }
    let result: SubagentResult
    try {
      result = await runReviewer(
        this.ctx,
        this.config,
        { label: contract.label, prompt: contract.prompt(criterion, this.config), outputSchema: contract.outputSchema },
        // The verification seam carries no cancellation channel of its own, so
        // the child is bounded by the kernel's verifier ceiling and by disposal.
        { parent, signal: new AbortController().signal },
      )
    } catch (error) {
      return fail(criterion, request.changedScopes, `the independent reviewer could not be started: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (result.stopReason !== 'completed') {
      const diagnostic = result.diagnostic === undefined ? '' : `: ${result.diagnostic}`
      return fail(criterion, request.changedScopes, `the independent reviewer did not finish (${result.stopReason})${diagnostic}`)
    }
    return criterion.verifier === 'browser'
      ? scenarioVerdict(criterion, request, result.structured)
      : findingsVerdict(criterion, request, result.structured, this.config.minSeverity ?? 'high')
  }
}

/**
 * Decide a criterion from the reviewer's scenario report.
 * @param criterion - the criterion being evaluated.
 * @param request - the request the criterion belongs to.
 * @param structured - the child's structured output, validated here.
 * @returns the verdict, carrying the reviewer's observations.
 */
function scenarioVerdict(criterion: AcceptanceCriterion, request: VerificationRequest, structured: unknown): CriterionVerdict {
  const report = scenarioReportOf(structured)
  if (report === undefined) {
    return fail(criterion, request.changedScopes, 'the browser verifier finished without a scenario report stating whether the scenario held')
  }
  return {
    result: {
      criterionId: criterion.id,
      status: report.passed ? 'pass' : 'fail',
      evidence: [...report.evidence ?? request.changedScopes],
      detail: report.detail,
    },
  }
}

/**
 * Decide a criterion from the reviewer's findings: a finding at or above the
 * configured floor fails it.
 * @param criterion - the criterion being evaluated.
 * @param request - the request the criterion belongs to.
 * @param structured - the child's structured output, validated here.
 * @param floor - lowest severity that fails the criterion.
 * @returns the verdict, carrying the reviewer's findings.
 */
function findingsVerdict(
  criterion: AcceptanceCriterion,
  request: VerificationRequest,
  structured: unknown,
  floor: ReviewSeverity,
): CriterionVerdict {
  const report = reviewReportOf(structured)
  if (report === undefined) {
    return fail(criterion, request.changedScopes, 'the reviewer finished without a structured report of its findings')
  }
  const blocking = report.findings.filter(finding => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[floor])
  const files = [...new Set(report.findings.map(finding => finding.file))]
  return {
    result: {
      criterionId: criterion.id,
      status: blocking.length === 0 ? 'pass' : 'fail',
      evidence: files.length === 0 ? [...request.changedScopes] : files,
      detail: blocking.length === 0
        ? `no finding at or above ${floor}\n${renderReport(report)}`
        : `${String(blocking.length)} finding(s) at or above ${floor}\n${renderReport(report)}`,
    },
  }
}

/**
 * Answer one criterion `fail` with the reason it could not be decided.
 * @param criterion - the criterion being evaluated.
 * @param evidence - references the failure rests on.
 * @param detail - why the criterion has no verdict from a reviewer.
 * @returns the failed verdict.
 */
function fail(criterion: AcceptanceCriterion, evidence: readonly string[], detail: string): CriterionVerdict {
  return { result: { criterionId: criterion.id, status: 'fail', evidence: [...evidence], detail } }
}

/**
 * Render a review report as the retained detail: the summary, then one line per finding.
 * @param report - the reviewer's report.
 * @returns the detail text.
 */
function renderReport(report: ReviewReport): string {
  return [report.summary, ...report.findings.map((finding) => {
    const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`
    return `[${finding.severity}] ${location} — ${finding.message}`
  })].join('\n')
}

/**
 * Read one reviewer's structured output as a review report. The child's JSON is
 * a model boundary, so every field is checked before use.
 * @param value - the child's structured output.
 * @returns the report, or undefined when the value is not one.
 */
function reviewReportOf(value: unknown): ReviewReport | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { summary, findings } = value as { summary?: unknown; findings?: unknown }
  if (typeof summary !== 'string' || !Array.isArray(findings)) return undefined
  const reported: ReviewFinding[] = []
  for (const finding of findings) {
    if (typeof finding !== 'object' || finding === null) return undefined
    const { file, line, severity, message } = finding as Record<string, unknown>
    if (typeof file !== 'string' || typeof message !== 'string') return undefined
    if (severity !== 'high' && severity !== 'medium' && severity !== 'low') return undefined
    if (line !== undefined && typeof line !== 'string') return undefined
    reported.push({ file, message, severity, ...line === undefined ? {} : { line } })
  }
  return { summary, findings: reported }
}

/**
 * Read one reviewer's structured output as a scenario report. The child's JSON
 * is a model boundary, so every field is checked before use.
 * @param value - the child's structured output.
 * @returns the report, or undefined when the value is not one.
 */
function scenarioReportOf(value: unknown): ScenarioReport | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { passed, detail, evidence } = value as { passed?: unknown; detail?: unknown; evidence?: unknown }
  if (typeof passed !== 'boolean' || typeof detail !== 'string') return undefined
  if (evidence === undefined) return { passed, detail }
  if (!Array.isArray(evidence)) return undefined
  const references: string[] = []
  for (const entry of evidence) {
    if (typeof entry !== 'string') return undefined
    references.push(entry)
  }
  return { passed, detail, evidence: references }
}
