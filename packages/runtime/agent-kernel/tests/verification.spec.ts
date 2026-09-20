import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CriterionVerifierRegistry, DefaultVerificationGate, VERIFIER_VERSION } from '../src/verification.ts'
import type {
  AcceptanceCriterion,
  BudgetSnapshot,
  CriterionResult,
  CriterionVerifier,
  FailureRef,
  ResourceBudget,
  RunId,
  TaskContract,
  TaskId,
  VerificationRequest,
} from '../src/types.ts'

/** One criterion with the given verifier and requirement. */
function criterion(id: string, verifier: AcceptanceCriterion['verifier'] = 'test', required = true): AcceptanceCriterion {
  return { id, description: `criterion ${id}`, verifier, required }
}

/** A task carrying the given criteria and budget. */
function task(criteria: readonly AcceptanceCriterion[], budget: ResourceBudget = {}): TaskContract {
  return {
    taskId: brandString<TaskId>('task-1'),
    runId: brandString<RunId>('run-1'),
    objective: 'objective',
    constraints: [],
    acceptance: [...criteria],
    agentProfile: 'default',
    policyProfile: 'default',
    budget,
    status: 'verifying',
    revision: 3,
  }
}

/** One reported criterion outcome. */
function verdict(criterionId: string, status: CriterionResult['status']): CriterionResult {
  return { criterionId, status, evidence: [`evidence-${criterionId}`] }
}

/** A budget snapshot with the given remaining allowance. */
function budget(remaining: BudgetSnapshot['remaining'] = {}): BudgetSnapshot {
  return { steps: 1, toolCalls: 1, wallMs: 1, remaining }
}

/** The default gate used by the kernel. */
function gate(requireAcceptanceCriteria = false, allowHumanOnlyCompletion = false): DefaultVerificationGate {
  return new DefaultVerificationGate({ requireAcceptanceCriteria, allowHumanOnlyCompletion })
}

describe('verification requests and aggregation', () => {
  it('requests the task criteria at the task revision', () => {
    const request = gate().request(task([criterion('a')]), ['src/a.ts'])
    expect(request).toMatchObject({ revision: 3, changedScopes: ['src/a.ts'] })
    expect(request.criteria.map(item => item.id)).toEqual(['a'])
  })

  it('aggregates reported outcomes and leaves an unreported criterion unknown', () => {
    const request = gate().request(task([criterion('a'), criterion('b')]), [])
    const passed = gate().evaluate(request, [verdict('a', 'pass'), verdict('b', 'pass')], ['pnpm test'])
    expect(passed).toMatchObject({ status: 'pass', commands: ['pnpm test'], verifierVersion: VERIFIER_VERSION })

    const failed = gate().evaluate(request, [verdict('a', 'pass'), verdict('b', 'fail')], [])
    expect(failed.status).toBe('fail')

    const unknown = gate().evaluate(request, [verdict('a', 'pass')], [])
    expect(unknown.status).toBe('unknown')
    expect(unknown.criterionResults[1]).toMatchObject({
      criterionId: 'b',
      status: 'unknown',
      detail: 'no verifier reported a result for this criterion',
    })

    expect(gate().evaluate(gate().request(task([]), []), [], []).status).toBe('pass')
  })
})

describe('completion gate', () => {
  it('allows completion only when every required criterion passed', () => {
    const subject = task([criterion('a')])
    const request = gate().request(subject, [])
    const result = gate().evaluate(request, [verdict('a', 'pass')], [])
    expect(gate().decide(subject, result, [], budget())).toEqual({ allowed: true, reasons: [] })
  })

  it('refuses completion for a missing criterion, an unresolved failure, and an exhausted ceiling', () => {
    const subject = task([criterion('a'), criterion('b', 'test', false)], { maxSteps: 4 })
    const request = gate().request(subject, [])
    const failed = gate().evaluate(request, [verdict('a', 'fail'), verdict('b', 'pass')], [])
    const decision = gate().decide(
      subject,
      failed,
      [{ failureId: brandString<FailureRef['failureId']>('f-1'), kind: 'verification-failed' }],
      budget({ maxSteps: 0 }),
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toEqual([
      'verification reported fail for revision 3',
      'required criterion "a" is fail',
      'unresolved failure f-1 (verification-failed)',
      'budget ceiling maxSteps is exhausted',
    ])
  })

  it('refuses a task that declares no criterion when the deployment requires one', () => {
    const subject = task([])
    const decision = gate(true).decide(subject, gate().evaluate(gate().request(subject, []), [], []), [], budget())
    expect(decision).toEqual({
      allowed: false,
      reasons: ['the task declares no acceptance criterion and this deployment requires one before completion'],
    })
  })

  it('refuses a task whose only passing evidence is human-reported', () => {
    const subject = task([criterion('a', 'human')])
    const request = gate().request(subject, [])
    const result = gate().evaluate(request, [verdict('a', 'pass')], [])
    expect(gate().decide(subject, result, [], budget()).reasons)
      .toEqual(['the only evidence is human-reported and this deployment requires machine-verifiable evidence'])
    expect(gate(false, true).decide(subject, result, [], budget()).allowed).toBe(true)
    expect(gate().decide(task([criterion('a', 'human')]), gate().evaluate(request, [], []), [], budget()).reasons).toContain(
      'verification reported unknown for revision 3',
    )
  })

  it('treats a configured ceiling missing from the snapshot as exhausted', () => {
    const subject = task([criterion('a', 'test', false)], { maxTokens: 100 })
    const passed = gate().evaluate(gate().request(subject, []), [verdict('a', 'pass')], [])
    expect(gate().decide(subject, passed, [], budget()).reasons).toEqual(['budget ceiling maxTokens is exhausted'])

    const optionalNone = task([criterion('a', 'test', false), criterion('b', 'human', false)])
    const noneRequired = gate().evaluate(gate().request(optionalNone, []), [verdict('a', 'pass')], [])
    expect(gate().decide(optionalNone, noneRequired, [], budget()).reasons)
      .toEqual(['verification reported unknown for revision 3'])
  })
})

describe('criterion verifier registry', () => {
  /** One verifier that claims `test` criteria and reports the given status. */
  function verifier(id: string, status: CriterionResult['status'], commands: readonly string[] = []): CriterionVerifier {
    return {
      id,
      supports: criterionToCheck => criterionToCheck.verifier === 'test',
      verify: async (_request, criterionToCheck): Promise<{ result: CriterionResult; commands?: readonly string[] }> => ({
        result: { criterionId: criterionToCheck.id, status, evidence: [] },
        commands,
      }),
    }
  }

  it('collects verdicts from the first verifier that supports each criterion', async () => {
    const registry = new CriterionVerifierRegistry()
    const request: VerificationRequest = { taskId: brandString<TaskId>('task-1'), revision: 1, criteria: [criterion('a')], changedScopes: [] }
    expect(await registry.collect(request)).toEqual({ results: [], commands: [] })

    const dispose = registry.register(verifier('v1', 'pass', ['pnpm test']))
    registry.register(verifier('v2', 'fail', ['pnpm lint']))
    expect(await registry.collect(request)).toEqual({
      results: [{ criterionId: 'a', status: 'pass', evidence: [] }],
      commands: ['pnpm test'],
    })

    dispose()
    dispose()
    expect(await registry.collect(request)).toMatchObject({ commands: ['pnpm lint'] })
  })

  it('skips a criterion no verifier supports and a verifier that answers nothing', async () => {
    const registry = new CriterionVerifierRegistry()
    registry.register({
      id: 'silent',
      supports: () => true,
      verify: async () => undefined,
    })
    const request: VerificationRequest = {
      taskId: brandString<TaskId>('task-1'),
      revision: 1,
      criteria: [criterion('a')],
      changedScopes: [],
    }
    expect(await registry.collect(request)).toEqual({ results: [], commands: [] })
  })
})
