import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CriterionResultCache, CriterionVerifierRegistry, DefaultVerificationGate, VERIFIER_VERSION } from '../src/verification.ts'
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
    dependencies: [],
    evidence: [],
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
  return { steps: 1, toolCalls: 1, tokens: 0, wallMs: 1, remaining }
}

/** The default gate used by the kernel; the requirement is per task class. */
function gate(requireAcceptanceCriteria = false, allowHumanOnlyCompletion = false): DefaultVerificationGate {
  return new DefaultVerificationGate({
    requireAcceptanceCriteria: requireAcceptanceCriteria
      ? { conversational: true, coding: true, research: true, operations: true }
      : {},
    allowHumanOnlyCompletion,
  })
}

/** One verification request at one repository state. */
function request(subject: TaskContract, changedScopes: readonly string[] = [], repositoryDigest = 'digest-1'): VerificationRequest {
  return gate().request(subject, changedScopes, repositoryDigest)
}

/** Cache bounds the registry specs run under. */
const CACHE = { maxEntries: 8, ttlMs: 60_000 }

describe('verification requests and aggregation', () => {
  it('requests the task criteria at the task revision', () => {
    const built = request(task([criterion('a')]), ['src/a.ts'])
    expect(built).toMatchObject({ revision: 3, changedScopes: ['src/a.ts'], repositoryDigest: 'digest-1' })
    expect(built.criteria.map(item => item.id)).toEqual(['a'])
  })

  it('aggregates reported outcomes and leaves an unreported criterion unknown', () => {
    const built = request(task([criterion('a'), criterion('b')]), [])
    const passed = gate().evaluate(built, [verdict('a', 'pass'), verdict('b', 'pass')], ['pnpm test'])
    expect(passed).toMatchObject({ status: 'pass', commands: ['pnpm test'], verifierVersion: VERIFIER_VERSION })

    const failed = gate().evaluate(built, [verdict('a', 'pass'), verdict('b', 'fail')], [])
    expect(failed.status).toBe('fail')

    const unknown = gate().evaluate(built, [verdict('a', 'pass')], [])
    expect(unknown.status).toBe('unknown')
    expect(unknown.criterionResults[1]).toMatchObject({
      criterionId: 'b',
      status: 'unknown',
      detail: 'no verifier reported a result for this criterion',
    })

    expect(gate().evaluate(request(task([]), []), [], []).status).toBe('pass')
  })
})

describe('completion gate', () => {
  it('allows completion only when every required criterion passed', () => {
    const subject = task([criterion('a')])
    const built = request(subject, [])
    const result = gate().evaluate(built, [verdict('a', 'pass')], [])
    expect(gate().decide(subject, result, [], budget())).toEqual({ allowed: true, reasons: [] })
  })

  it('refuses completion for a missing criterion, an unresolved failure, and an exhausted ceiling', () => {
    const subject = task([criterion('a'), criterion('b', 'test', false)], { maxSteps: 4 })
    const built = request(subject, [])
    const failed = gate().evaluate(built, [verdict('a', 'fail'), verdict('b', 'pass')], [])
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
    const decision = gate(true).decide(subject, gate().evaluate(request(subject, []), [], []), [], budget())
    expect(decision).toEqual({
      allowed: false,
      reasons: ['the conversational task declares no acceptance criterion and this deployment requires one before completion'],
    })
  })

  it('refuses a task whose only passing evidence is human-reported', () => {
    const subject = task([criterion('a', 'human')])
    const built = request(subject, [])
    const result = gate().evaluate(built, [verdict('a', 'pass')], [])
    expect(gate().decide(subject, result, [], budget()).reasons)
      .toEqual(['the only evidence is human-reported and this deployment requires machine-verifiable evidence'])
    expect(gate(false, true).decide(subject, result, [], budget()).allowed).toBe(true)
    expect(gate().decide(task([criterion('a', 'human')]), gate().evaluate(built, [], []), [], budget()).reasons).toContain(
      'verification reported unknown for revision 3',
    )
  })

  it('treats a configured ceiling missing from the snapshot as exhausted', () => {
    const subject = task([criterion('a', 'test', false)], { maxTokens: 100 })
    const passed = gate().evaluate(request(subject, []), [verdict('a', 'pass')], [])
    expect(gate().decide(subject, passed, [], budget()).reasons).toEqual(['budget ceiling maxTokens is exhausted'])

    const optionalNone = task([criterion('a', 'test', false), criterion('b', 'human', false)])
    const noneRequired = gate().evaluate(request(optionalNone, []), [verdict('a', 'pass')], [])
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
    const registry = new CriterionVerifierRegistry(60_000, CACHE)
    const unrecognized = request(task([criterion('a')]), [], 'digest-unrecognized')
    expect(await registry.collect(unrecognized)).toEqual({ results: [], commands: [] })

    const dispose = registry.register(verifier('v1', 'pass', ['pnpm test']))
    registry.register(verifier('v2', 'fail', ['pnpm lint']))
    const state: VerificationRequest = { ...unrecognized, repositoryDigest: 'digest-collect' }
    expect(await registry.collect(state)).toEqual({
      results: [{ criterionId: 'a', status: 'pass', evidence: [] }],
      commands: ['pnpm test'],
    })

    dispose()
    dispose()
    expect(await registry.collect({ ...state, repositoryDigest: 'digest-after-dispose' }))
      .toMatchObject({ commands: ['pnpm lint'] })
  })

  it('skips a criterion no verifier supports and a verifier that answers nothing', async () => {
    const registry = new CriterionVerifierRegistry(60_000, CACHE)
    registry.register({
      id: 'silent',
      supports: () => true,
      verify: async () => undefined,
    })
    expect(await registry.collect(request(task([criterion('a')]), []))).toEqual({ results: [], commands: [] })
  })
})

describe('criterion result cache', () => {
  /** One verifier that reports `pass` and counts how often it ran. */
  function countingVerifier(runs: string[]): CriterionVerifier {
    return {
      id: 'counter',
      supports: () => true,
      verify: async (_request, subject): Promise<{ result: CriterionResult }> => {
        runs.push(subject.id)
        return { result: { criterionId: subject.id, status: 'pass', evidence: [] } }
      },
    }
  }

  it('reuses a criterion result for an unchanged repository and re-runs it after a change', async () => {
    const registry = new CriterionVerifierRegistry(60_000, CACHE)
    const runs: string[] = []
    registry.register(countingVerifier(runs))
    const subject = task([criterion('a'), criterion('b')])

    const first = await registry.collect(request(subject, ['src/a.ts'], 'digest-before'))
    expect(runs).toEqual(['a', 'b'])
    expect(first.results).toEqual([
      { criterionId: 'a', status: 'pass', evidence: [] },
      { criterionId: 'b', status: 'pass', evidence: [] },
    ])

    const repeated = await registry.collect(request(subject, ['src/a.ts'], 'digest-before'))
    expect(runs).toEqual(['a', 'b'])
    expect(repeated).toEqual(first)

    await registry.collect(request(subject, ['src/a.ts'], 'digest-after'))
    expect(runs).toEqual(['a', 'b', 'a', 'b'])
  })

  it('evicts the oldest retained result at its entry bound and expires by age', () => {
    const cache = new CriterionResultCache({ maxEntries: 2, ttlMs: 1_000 })
    cache.set('a', 'digest-1', verdict('a', 'pass'), 0)
    cache.set('b', 'digest-1', verdict('b', 'pass'), 0)
    cache.set('c', 'digest-1', verdict('c', 'pass'), 0)

    expect(cache.size).toBe(2)
    expect(cache.get('a', 'digest-1', 0)).toBeUndefined()
    expect(cache.get('c', 'digest-1', 0)).toMatchObject({ criterionId: 'c' })

    expect(cache.get('b', 'digest-1', 1_001)).toBeUndefined()
    expect(cache.size).toBe(1)
  })

  it('keeps one criterion decision per repository state', () => {
    const cache = new CriterionResultCache({ maxEntries: 8, ttlMs: 60_000 })
    cache.set('a', 'digest-1', verdict('a', 'pass'), 0)
    cache.set('a', 'digest-2', verdict('a', 'fail'), 0)

    expect(cache.get('a', 'digest-1', 0)).toMatchObject({ status: 'pass' })
    expect(cache.get('a', 'digest-2', 0)).toMatchObject({ status: 'fail' })
  })
})

describe('verifier cost control', () => {
  /** One criterion of the given family, required. */
  function required(id: string, verifier: AcceptanceCriterion['verifier']): AcceptanceCriterion {
    return { id, description: id, verifier, required: true }
  }

  it('runs the cheap families first and stops at the first failed required criterion', async () => {
    const registry = new CriterionVerifierRegistry(60_000, CACHE)
    const ran: string[] = []
    registry.register({
      id: 'slow',
      supports: criterion => criterion.verifier === 'test',
      verify: async (_request, criterion) => {
        ran.push(criterion.id)
        return { result: { criterionId: criterion.id, status: 'pass', evidence: [] } }
      },
    })
    registry.register({
      id: 'fast',
      supports: criterion => criterion.verifier === 'assertion',
      verify: async (_request, criterion) => {
        ran.push(criterion.id)
        return { result: { criterionId: criterion.id, status: 'fail', evidence: [] } }
      },
    })
    const built = request(task([required('suite', 'test'), required('unit', 'assertion')]), [])

    const { results } = await registry.collect(built)

    expect(ran).toEqual(['unit'])
    expect(results.map(result => result.criterionId)).toEqual(['unit'])
  })

  it('runs an optional failed criterion and still collects the later ones', async () => {
    const registry = new CriterionVerifierRegistry(60_000, CACHE)
    const ran: string[] = []
    registry.register({
      id: 'any',
      supports: () => true,
      verify: async (_request, criterion) => {
        ran.push(criterion.id)
        return { result: { criterionId: criterion.id, status: 'fail', evidence: [] } }
      },
    })
    const optional = { ...required('first', 'assertion'), required: false }
    const built = request(task([optional, required('second', 'assertion')]), [])

    await registry.collect(built)

    expect(ran).toEqual(['first', 'second'])
  })

  it('reports a verifier that overruns its ceiling as a failed criterion', async () => {
    const registry = new CriterionVerifierRegistry(10, CACHE)
    registry.register({
      id: 'hangs',
      supports: () => true,
      verify: () => new Promise((resolve) => { setTimeout(() => { resolve(undefined) }, 5_000) }),
    })

    const { results } = await registry.collect(request(task([required('slow', 'test')]), []))

    expect(results).toEqual([{
      criterionId: 'slow',
      status: 'fail',
      evidence: [],
      detail: 'verifier "hangs" exceeded its 10ms ceiling',
    }])
  })
})
