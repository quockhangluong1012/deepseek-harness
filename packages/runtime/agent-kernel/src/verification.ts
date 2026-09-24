/**
 * The completion gate: turn a task's acceptance criteria into one verification
 * request, aggregate the criteria's outcomes, and decide whether the task may
 * be reported complete.
 *
 * The gate is deliberately pessimistic. Completion requires every criterion to
 * pass, no unresolved failure to remain, and no configured ceiling to be
 * exhausted; a criterion with no result is `unknown`, never an implicit pass.
 *
 * @module @deepseek-ai/dsh-agent-kernel/verification
 */

import type {
  AcceptanceCriterion,
  BudgetSnapshot,
  CompletionDecision,
  CriterionResult,
  CriterionVerdict,
  CriterionVerifier,
  FailureRef,
  ResourceBudget,
  TaskClass,
  TaskContract,
  VerificationGate,
  VerificationRequest,
  VerificationResult,
} from './types.ts'

/** The verifier's own version, recorded on every result it produces. */
export const VERIFIER_VERSION = 'agent-kernel/1'

/** Deployment choices the completion gate reads. */
export interface VerificationConfig {
  /**
   * Whether a task with no acceptance criteria may complete, by task class. A
   * class absent from the map demands no criterion.
   */
  readonly requireAcceptanceCriteria: Partial<Record<TaskClass, boolean>>
  /** Whether a task whose only passing evidence is human-reported may complete. */
  readonly allowHumanOnlyCompletion: boolean
}

/** Every ceiling name a budget snapshot reports remaining allowance for. */
const CEILINGS = ['maxSteps', 'maxToolCalls', 'maxTokens', 'maxWallMs', 'maxCostUsd'] as const

/**
 * The default completion gate. It owns no state beyond its configuration and
 * reads nothing but its arguments, so a replayed log produces the same
 * decision.
 */
export class DefaultVerificationGate implements VerificationGate {
  /** Deployment choices this gate decides under. */
  private readonly config: VerificationConfig

  /**
   * @param config - deployment choices for required criteria and human evidence.
   */
  constructor(config: VerificationConfig) {
    this.config = config
  }

  /**
   * Whether this deployment demands an acceptance criterion for the task's class.
   * @param task - the task being considered.
   * @returns true when the task's class is required to declare a criterion.
   */
  requiredFor(task: TaskContract): boolean {
    return this.config.requireAcceptanceCriteria[task.taskClass ?? 'conversational'] === true
  }

  /**
   * Build the verification request for one task revision.
   * @param task - the task to verify.
   * @param changedScopes - scopes the task changed.
   * @returns the request carrying the task's criteria at its current revision.
   */
  request(task: TaskContract, changedScopes: readonly string[]): VerificationRequest {
    return {
      taskId: task.taskId,
      revision: task.revision,
      criteria: task.acceptance,
      changedScopes,
    }
  }

  /**
   * Aggregate per-criterion outcomes. The aggregate passes only when every
   * criterion passed; a criterion reported `fail` makes the aggregate fail,
   * and a criterion with no result leaves it `unknown`.
   * @param request - the request the results answer.
   * @param results - per-criterion outcomes.
   * @param commands - commands the verifier ran.
   * @returns the aggregated result.
   */
  evaluate(
    request: VerificationRequest,
    results: readonly CriterionResult[],
    commands: readonly string[],
  ): VerificationResult {
    const byCriterion = new Map(results.map(result => [result.criterionId, result]))
    const criterionResults = request.criteria.map((criterion): CriterionResult =>
      byCriterion.get(criterion.id) ?? {
        criterionId: criterion.id,
        status: 'unknown',
        evidence: [],
        detail: 'no verifier reported a result for this criterion',
      })
    const status = criterionResults.some(result => result.status === 'fail')
      ? 'fail'
      : criterionResults.every(result => result.status === 'pass') ? 'pass' : 'unknown'
    return {
      taskId: request.taskId,
      revision: request.revision,
      status,
      criterionResults,
      commands,
      verifierVersion: VERIFIER_VERSION,
    }
  }

  /**
   * Decide whether a task may be reported complete. Every refusal names its
   * own reason, so a reader of the log can tell a failed criterion from an
   * unresolved failure from an exhausted budget.
   * @param task - the task being considered.
   * @param result - the verification result for the task's revision.
   * @param unresolvedFailures - failures with no accepted recovery.
   * @param budgets - the task's budget observation.
   * @returns the decision and every reason behind it.
   */
  decide(
    task: TaskContract,
    result: VerificationResult,
    unresolvedFailures: readonly FailureRef[],
    budgets: BudgetSnapshot,
  ): CompletionDecision {
    const reasons: string[] = []
    if (task.acceptance.length === 0 && this.requiredFor(task)) {
      const taskClass = task.taskClass ?? 'conversational'
      reasons.push(`the ${taskClass} task declares no acceptance criterion and this deployment requires one before completion`)
    }
    if (result.status !== 'pass') {
      reasons.push(`verification reported ${result.status} for revision ${result.revision}`)
    }
    for (const criterion of result.criterionResults) {
      if (criterion.status !== 'pass' && isRequired(task, criterion.criterionId)) {
        reasons.push(`required criterion "${criterion.criterionId}" is ${criterion.status}`)
      }
    }
    if (!this.config.allowHumanOnlyCompletion && humanEvidenceOnly(task, result)) {
      reasons.push('the only evidence is human-reported and this deployment requires machine-verifiable evidence')
    }
    for (const failure of unresolvedFailures) {
      reasons.push(`unresolved failure ${failure.failureId} (${failure.kind})`)
    }
    const exhausted = exhaustedCeiling(task.budget, budgets)
    if (exhausted !== undefined) reasons.push(`budget ceiling ${exhausted} is exhausted`)
    return { allowed: reasons.length === 0, reasons }
  }
}

/**
 * Whether a criterion is required by the task contract's own criteria list.
 * @param task - the task whose criteria are consulted.
 * @param criterionId - the criterion to look up.
 * @returns true when the criterion is declared required.
 */
function isRequired(task: TaskContract, criterionId: string): boolean {
  return task.acceptance.some(criterion => criterion.id === criterionId && criterion.required)
}

/**
 * Whether every required criterion is human-verified, which is a task with no
 * machine-checkable evidence at all.
 * @param task - the task whose criteria are consulted.
 * @param result - the verification result to inspect.
 * @returns true when at least one criterion exists and all required ones are human-verified.
 */
function humanEvidenceOnly(task: TaskContract, result: VerificationResult): boolean {
  const human = new Set(task.acceptance.filter(c => c.verifier === 'human').map(c => c.id))
  const required = result.criterionResults.filter(criterion => isRequired(task, criterion.criterionId))
  return required.length > 0 && required.every(criterion => human.has(criterion.criterionId))
}

/**
 * The local verifiers the completion gate delegates to. Registration is
 * first-match-wins in registration order: the first verifier that supports a
 * criterion answers it, and a criterion no verifier supports stays unresolved,
 * which the gate reports as `unknown` rather than a pass.
 */
/**
 * How expensive one verifier family is, cheapest first. The gate runs the cheap
 * families before the slow ones and stops at the first failed required
 * criterion, so a broken assertion never pays for a build.
 */
const FAMILY_COST: Readonly<Record<AcceptanceCriterion['verifier'], number>> = {
  assertion: 0,
  diff: 1,
  human: 2,
  research: 3,
  build: 4,
  test: 5,
}

export class CriterionVerifierRegistry {
  /** Registered verifiers in registration order. */
  private readonly registered: CriterionVerifier[] = []
  /** Per-verifier wall-clock ceiling; a verifier that overruns answers `fail`. */
  private readonly timeoutMs: number

  /**
   * @param timeoutMs - ceiling for one verifier's own evaluation.
   */
  constructor(timeoutMs = 60_000) {
    this.timeoutMs = timeoutMs
  }

  /**
   * Register one verifier.
   * @param verifier - the verifier to add.
   * @returns a disposer that removes exactly this registration.
   */
  register(verifier: CriterionVerifier): () => void {
    this.registered.push(verifier)
    return () => {
      const index = this.registered.indexOf(verifier)
      if (index >= 0) this.registered.splice(index, 1)
    }
  }

  /**
   * Collect every verdict the registered verifiers can produce for a request.
   * @param request - the request whose criteria are evaluated.
   * @returns the verdicts and every command the verifiers ran.
   */
  async collect(request: VerificationRequest): Promise<{ results: CriterionResult[]; commands: string[] }> {
    const results: CriterionResult[] = []
    const commands: string[] = []
    const ordered = [...request.criteria].sort((left, right) => FAMILY_COST[left.verifier] - FAMILY_COST[right.verifier])
    for (const criterion of ordered) {
      const verifier = this.registered.find(candidate => candidate.supports(criterion))
      if (verifier === undefined) continue
      const verdict = await this.runVerifier(verifier, request, criterion)
      if (verdict === undefined) continue
      results.push(verdict.result)
      commands.push(...verdict.commands ?? [])
      // A failed required criterion already decides the aggregate: running a
      // slower verifier cannot make the task complete.
      if (criterion.required && verdict.result.status === 'fail') break
    }
    return { results, commands }
  }

  /**
   * Run one verifier under its wall-clock ceiling. A verifier that never
   * answers is reported as a failed criterion naming the timeout, because an
   * unbounded verifier must not hold a turn open forever.
   * @param verifier - the verifier to run.
   * @param request - the request the criterion belongs to.
   * @param criterion - the criterion to evaluate.
   * @returns the verdict, or a failure naming the timeout.
   */
  private async runVerifier(
    verifier: CriterionVerifier,
    request: VerificationRequest,
    criterion: AcceptanceCriterion,
  ): Promise<CriterionVerdict | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => { resolve('timeout') }, this.timeoutMs)
    })
    try {
      const settled = await Promise.race([verifier.verify(request, criterion), timedOut])
      if (settled === 'timeout') {
        return {
          result: {
            criterionId: criterion.id,
            status: 'fail',
            evidence: [],
            detail: `verifier "${verifier.id}" exceeded its ${String(this.timeoutMs)}ms ceiling`,
          },
        }
      }
      return settled
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * The first configured ceiling with no remaining allowance.
 * @param budget - the task's configured ceilings.
 * @param snapshot - the observed budget state.
 * @returns the exhausted ceiling's field name, or undefined.
 */
function exhaustedCeiling(budget: ResourceBudget, snapshot: BudgetSnapshot): keyof ResourceBudget | undefined {
  return CEILINGS.find(ceiling => budget[ceiling] !== undefined && (snapshot.remaining[ceiling] ?? 0) <= 0)
}
