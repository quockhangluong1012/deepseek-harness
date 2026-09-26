/**
 * The criterion verifier itself: it claims the criteria the deployment
 * configured a target for and answers each one from a shell command's outcome
 * or from the scopes a task changed.
 *
 * @module @deepseek-ai/dsh-command-verifiers/verifier
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AcceptanceCriterion, CriterionVerdict, CriterionVerifier, VerificationRequest } from '@deepseek-ai/dsh-agent-kernel'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { withinExpectedPaths } from './targets.ts'
import { compareChangeContract } from './contract.ts'
import type { ResolvedCommandTarget, ResolvedContractTarget, ResolvedScopeTarget, ResolvedTarget } from './types.ts'

/** Stable verifier identity the kernel records for every result this package produces. */
export const VERIFIER_ID = 'command-verifiers'

/**
 * Evidence reference for a command whose target declares no `cwd`: `.` names
 * the shell executor's configured working directory.
 */
const EXECUTOR_WORKDIR = '.'

/** The criterion verifier over `ctx.shell` and the resolved target table. */
export class CommandCriterionVerifier implements CriterionVerifier {
  readonly id = VERIFIER_ID

  /**
   * @param ctx - the context whose `shell` service runs the configured commands.
   * @param targets - resolved targets keyed by criterion id or verifier family.
   */
  constructor(
    private readonly ctx: Context,
    private readonly targets: ReadonlyMap<string, ResolvedTarget>,
  ) {}

  /**
   * Whether this deployment declared a target for the criterion's id or family.
   * @param criterion - the criterion to test.
   * @returns true when a target claims the criterion.
   */
  supports(criterion: AcceptanceCriterion): boolean {
    return this.targetOf(criterion) !== undefined
  }

  /**
   * Run the criterion's target. A command that times out, is aborted, or cannot
   * start answers `fail`: a criterion is never left unresolved by a verifier
   * that claimed it.
   * @param request - the request the criterion belongs to.
   * @param criterion - the criterion to evaluate.
   * @returns the verdict, or undefined when no target claims the criterion.
   */
  async verify(request: VerificationRequest, criterion: AcceptanceCriterion): Promise<CriterionVerdict | undefined> {
    const target = this.targetOf(criterion)
    if (target === undefined) return undefined
    if (target.kind === 'command') return await this.runCommand(target, criterion)
    if (target.kind === 'scopes') return this.checkScopes(target, request, criterion)
    return this.checkContract(target, request, criterion)
  }

  /**
   * Find the target that claims a criterion: its own id first, else its family.
   * @param criterion - the criterion to look up.
   * @returns the claiming target, or undefined when the deployment declared none.
   */
  private targetOf(criterion: AcceptanceCriterion): ResolvedTarget | undefined {
    return this.targets.get(criterion.id) ?? this.targets.get(criterion.verifier)
  }

  /**
   * Run one command target and decide the criterion from how it ended. Every
   * failure path answers a verdict: the completion gate reads a rejection as an
   * unfinished turn, not as a failed criterion.
   * @param target - the resolved command target.
   * @param criterion - the criterion being evaluated.
   * @returns the verdict, carrying the command and the retained output.
   */
  private async runCommand(target: ResolvedCommandTarget, criterion: AcceptanceCriterion): Promise<CriterionVerdict> {
    const evidence = [target.cwd ?? EXECUTOR_WORKDIR]
    const shell = this.ctx.get('shell')
    let outcome: { readonly result: ShellRunResult } | { readonly detail: string }
    if (shell === undefined) {
      outcome = { detail: `no shell executor is mounted, so "${target.command}" did not run` }
    } else {
      try {
        const execution = await shell.execute(shell.resolve({
          command: target.command,
          timeoutMs: target.timeoutMs,
          onExpiry: 'kill',
          ...target.cwd === undefined ? {} : { workdir: target.cwd },
        }))
        outcome = { result: await execution.result() }
      } catch (error) {
        outcome = { detail: `"${target.command}" could not run: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    if ('detail' in outcome) {
      return { result: { criterionId: criterion.id, status: 'fail', evidence, detail: outcome.detail } }
    }
    const result = outcome.result
    // Exit status, timeout, and abort are independent facts: a process that
    // trapped its termination signal exits 0, and an accepted code must not
    // turn a cut-short run into a pass.
    const accepted = !result.timedOut && !result.aborted && result.exitCode !== null
      && target.expectedExitCodes.includes(result.exitCode)
    return {
      result: {
        criterionId: criterion.id,
        status: accepted ? 'pass' : 'fail',
        evidence,
        detail: commandDetail(target, result),
      },
      commands: [target.command],
    }
  }

  /**
   * Decide a `diff` criterion from the scopes the task changed.
   * @param target - the resolved scope target.
   * @param request - the request carrying the changed scopes.
   * @param criterion - the criterion being evaluated.
   * @returns the verdict, carrying the scopes the outcome rests on.
   */
  private checkScopes(target: ResolvedScopeTarget, request: VerificationRequest, criterion: AcceptanceCriterion): CriterionVerdict {
    const globs = target.expectedPaths.join(', ')
    const changed = request.changedScopes.map(scope => scope.replaceAll('\\', '/'))
    if (changed.length === 0) {
      return {
        result: {
          criterionId: criterion.id,
          status: 'pass',
          evidence: [],
          detail: `the task changed no scope, which the expected paths (${globs}) admit`,
        },
      }
    }
    const outside = changed.filter(scope => !withinExpectedPaths(scope, target.expectedPaths))
    return outside.length === 0
      ? {
        result: {
          criterionId: criterion.id,
          status: 'pass',
          evidence: changed,
          detail: `every changed scope matches the expected paths (${globs})`,
        },
      }
      : {
        result: {
          criterionId: criterion.id,
          status: 'fail',
          evidence: outside,
          detail: `changed outside the expected paths (${globs}): ${outside.join(', ')}`,
        },
      }
  }
  /**
   * Decide a criterion from the boundary its task declared. A claimed criterion
   * whose task declared no contract fails rather than staying unresolved: the
   * deployment claimed it, so the missing boundary is a reportable fact.
   * @param target - the resolved contract target.
   * @param request - the request carrying the declared contract and the changed scopes.
   * @param criterion - the criterion being evaluated.
   * @returns the verdict, carrying every broken bound as its detail.
   */
  private checkContract(target: ResolvedContractTarget, request: VerificationRequest, criterion: AcceptanceCriterion): CriterionVerdict {
    const contract = request.changeContract
    if (contract === undefined) {
      return {
        result: {
          criterionId: criterion.id,
          status: 'fail',
          evidence: [],
          detail: `the target "${target.claim}" decides this criterion by the change contract, and the task declared none`,
        },
      }
    }
    const comparison = compareChangeContract(contract, request.changedScopes)
    const changed = request.changedScopes.map(scope => scope.replaceAll('\\', '/'))
    if (comparison.violations.length > 0) {
      return {
        result: {
          criterionId: criterion.id,
          status: 'fail',
          evidence: comparison.violations.flatMap(violation => violation.scopes),
          detail: comparison.violations.map(violation => violation.reason).join('; '),
        },
      }
    }
    return {
      result: {
        criterionId: criterion.id,
        status: 'pass',
        evidence: changed,
        detail: comparison.bounded
          ? `every changed scope stayed inside the change contract "${contract.goal}"`
          : `the change contract "${contract.goal}" declares no bound, which every changed scope admits`,
      },
    }
  }
}

/**
 * Describe one command run: how it ended, then the retained output tail.
 * @param target - the resolved command target.
 * @param result - the foreground result the executor returned.
 * @returns the detail text, bounded by what the executor retained.
 */
function commandDetail(target: ResolvedCommandTarget, result: ShellRunResult): string {
  const parts = [outcomeLine(target, result)]
  for (const [name, stream] of [['stdout', result.stdout], ['stderr', result.stderr]] as const) {
    if (stream.text.length > 0) parts.push(`${name}:\n${stream.text.trimEnd()}`)
    if (stream.truncated) {
      parts.push(`${name} truncated; complete stream at ${stream.spillPath ?? 'no spill file'}`)
    }
  }
  return parts.join('\n')
}

/**
 * Name how one run ended, independently of which codes it accepts.
 * @param target - the resolved command target.
 * @param result - the foreground result the executor returned.
 * @returns the outcome line.
 */
function outcomeLine(target: ResolvedCommandTarget, result: ShellRunResult): string {
  const expected = `expected exit ${target.expectedExitCodes.join(' or ')}`
  if (result.timedOut) return `timed out after ${String(result.timeoutMs)}ms (${expected})`
  if (result.aborted) return `aborted before it finished (${expected})`
  if (result.exitCode === null) return `killed by signal ${result.signal ?? 'unknown'} (${expected})`
  return `exit code ${String(result.exitCode)} (${expected})`
}
