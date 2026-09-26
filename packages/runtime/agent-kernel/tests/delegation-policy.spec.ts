/**
 * The delegation policy and task overlap: the bounds a parent's children are
 * admitted under, the ceilings handed to a child, and the deterministic
 * decision that keeps a repeated delegation from spawning a second child.
 *
 * @module @deepseek-ai/dsh-agent-kernel/tests/delegation-policy
 */

import { describe, expect, it } from 'vitest'
import {
  DELEGATION_POLICY_DEFAULTS,
  NO_DELEGATION_CEILING,
  delegatedWorkerBudget,
  delegationPolicyRefusal,
  resolveDelegationPolicy,
  type DelegationPolicy,
} from '../src/delegation-policy.ts'
import { objectiveOverlap, taskOverlapDecision } from '../src/task-overlap.ts'

/** A resolved policy with the given axes replaced. */
function policyWith(overrides: Partial<DelegationPolicy>): DelegationPolicy {
  return { ...DELEGATION_POLICY_DEFAULTS, ...overrides }
}

describe('delegation policy resolution', () => {
  it('keeps the deployment behavior when no policy is declared', () => {
    expect(resolveDelegationPolicy(undefined, undefined)).toEqual(DELEGATION_POLICY_DEFAULTS)
  })

  it('takes the child-depth cap from the deployment depth it is resolved against', () => {
    expect(resolveDelegationPolicy(undefined, 2).maxDepth).toBe(2)
    expect(resolveDelegationPolicy({ maxDepth: 3 }, 2).maxDepth).toBe(3)
    expect(resolveDelegationPolicy(undefined, undefined).maxDepth).toBe(NO_DELEGATION_CEILING)
  })

  it('changes one axis without restating the others', () => {
    const policy = resolveDelegationPolicy({ maxChildren: 3, allowedRoles: ['coder'] }, undefined)
    expect(policy.maxChildren).toBe(3)
    expect(policy.allowedRoles).toEqual(['coder'])
    expect(policy.maxConcurrent).toBe(DELEGATION_POLICY_DEFAULTS.maxConcurrent)
    expect(policy.resultSchemaRequired).toBe(false)

    const switches = resolveDelegationPolicy(
      { duplicateTaskDetection: true, resultSchemaRequired: true, maxTokens: 10, maxCost: 5 },
      undefined,
    )
    expect(switches.duplicateTaskDetection).toBe(true)
    expect(switches.resultSchemaRequired).toBe(true)
    expect(switches.maxTokens).toBe(10)
    expect(switches.maxCost).toBe(5)
  })

  it('copies the declared roles away from the caller array', () => {
    const roles = ['coder']
    const policy = resolveDelegationPolicy({ allowedRoles: roles }, undefined)
    roles.push('reviewer')
    expect(policy.allowedRoles).toEqual(['coder'])
  })

  it('rejects a bound the harness cannot compare, naming the axis', () => {
    expect(() => resolveDelegationPolicy({ maxChildren: -1 }, undefined))
      .toThrow('delegation policy "maxChildren" must be a non-negative safe integer, received -1')
    expect(() => resolveDelegationPolicy({ maxDepth: 1.5 }, undefined))
      .toThrow('delegation policy "maxDepth" must be a non-negative safe integer, received 1.5')
    expect(() => resolveDelegationPolicy({ maxTokens: Number.POSITIVE_INFINITY }, undefined))
      .toThrow('delegation policy "maxTokens" must be a non-negative safe integer, received Infinity')
    // Cost is priced, not counted: a fractional dollar ceiling is a real bound.
    expect(resolveDelegationPolicy({ maxCost: 2.5 }, undefined).maxCost).toBe(2.5)
    expect(() => resolveDelegationPolicy({ maxCost: Number.NaN }, undefined))
      .toThrow('delegation policy "maxCost" must be a non-negative number, received NaN')
  })

  it('rejects a role that names nothing', () => {
    expect(() => resolveDelegationPolicy({ allowedRoles: ['coder', '  '] }, undefined))
      .toThrow('delegation policy "allowedRoles" must name a non-empty role')
  })
})

describe('spawn admission', () => {
  it('admits a spawn no declared bound refuses', () => {
    expect(delegationPolicyRefusal(DELEGATION_POLICY_DEFAULTS, { hasOutputSchema: false }, { children: 9, concurrent: 4 }))
      .toBeUndefined()
  })

  it('refuses a child past the per-parent cap', () => {
    const policy = policyWith({ maxChildren: 2 })
    expect(delegationPolicyRefusal(policy, { hasOutputSchema: false }, { children: 1, concurrent: 0 }))
      .toBeUndefined()
    expect(delegationPolicyRefusal(policy, { hasOutputSchema: false }, { children: 2, concurrent: 0 }))
      .toBe('this delegation policy allows 2 children per parent, and the parent already spawned 2')
  })

  it('refuses a child past the concurrency cap', () => {
    const policy = policyWith({ maxConcurrent: 1 })
    expect(delegationPolicyRefusal(policy, { hasOutputSchema: false }, { children: 0, concurrent: 1 }))
      .toBe('this delegation policy allows 1 children in flight, and the parent already has 1')
  })

  it('reports the child cap before the concurrency cap when a spawn is past both', () => {
    const policy = policyWith({ maxChildren: 1, maxConcurrent: 1, allowedRoles: ['coder'] })
    expect(delegationPolicyRefusal(policy, { hasOutputSchema: false }, { children: 5, concurrent: 5 }))
      .toBe('this delegation policy allows 1 children per parent, and the parent already spawned 5')
  })

  it('refuses a role the policy does not allow and admits one it does', () => {
    const policy = policyWith({ allowedRoles: ['coder', 'tester'] })
    expect(delegationPolicyRefusal(policy, { role: 'reviewer', hasOutputSchema: false }, { children: 0, concurrent: 0 }))
      .toBe('the role "reviewer" is not one of the roles this delegation policy allows (coder, tester)')
    expect(delegationPolicyRefusal(policy, { role: 'tester', hasOutputSchema: false }, { children: 0, concurrent: 0 }))
      .toBeUndefined()
  })

  it('refuses an anonymous spawn once the policy names roles', () => {
    const policy = policyWith({ allowedRoles: ['coder'] })
    expect(delegationPolicyRefusal(policy, { hasOutputSchema: false }, { children: 0, concurrent: 0 }))
      .toBe('this delegation policy allows only the roles coder, and the spawn names none')
  })

  it('refuses a spawn with no output schema when the policy requires one', () => {
    const policy = policyWith({ resultSchemaRequired: true })
    expect(delegationPolicyRefusal(policy, { role: 'coder', hasOutputSchema: false }, { children: 0, concurrent: 0 }))
      .toBe('this delegation policy requires an output schema, and the spawn declares none')
    expect(delegationPolicyRefusal(policy, { role: 'coder', hasOutputSchema: true }, { children: 0, concurrent: 0 }))
      .toBeUndefined()
  })

  it('hands the declared ceilings to the child and omits an unbounded axis', () => {
    expect(delegatedWorkerBudget(policyWith({ maxTokens: 50_000, maxCost: 1.25 })))
      .toEqual({ maxTokens: 50_000, maxCostUsd: 1.25 })
    expect(delegatedWorkerBudget(DELEGATION_POLICY_DEFAULTS)).toEqual({})
  })
})

describe('task overlap', () => {
  it('scores identical objectives at 1 and unrelated objectives at 0', () => {
    expect(objectiveOverlap('review the parser changes', 'Review the parser changes')).toBe(1)
    expect(objectiveOverlap('review the parser changes', 'explore the codebase layout')).toBe(0)
  })

  it('scores no content word as no overlap', () => {
    expect(objectiveOverlap('the and of', 'the and of')).toBe(0)
    expect(objectiveOverlap('', 'review the parser')).toBe(0)
    expect(objectiveOverlap('review the parser', 'of and the')).toBe(0)
  })

  it('spawns when nothing overlaps and when detection is off', () => {
    const input = {
      objective: 'explore the codebase layout',
      active: [{ childId: 'child-1', objective: 'review the parser changes' }],
      completed: [{ childId: 'child-2', objective: 'review the parser changes', result: 'the parser is fine' }],
    }
    expect(taskOverlapDecision(policyWith({ duplicateTaskDetection: true }), input)).toEqual({ kind: 'spawn' })
    expect(taskOverlapDecision(DELEGATION_POLICY_DEFAULTS, {
      objective: 'review the parser changes',
      active: [],
      completed: [{ childId: 'child-2', objective: 'review the parser changes', result: 'the parser is fine' }],
    })).toEqual({ kind: 'spawn' })
  })

  it('reuses the retained result of a completed child that ran the same task', () => {
    expect(taskOverlapDecision(policyWith({ duplicateTaskDetection: true }), {
      objective: 'review the parser changes',
      active: [],
      completed: [{ childId: 'child-2', objective: 'Review the parser changes', result: 'the parser is fine' }],
    })).toEqual({
      kind: 'reuse',
      childId: 'child-2',
      objective: 'Review the parser changes',
      result: 'the parser is fine',
    })
  })

  it('merges into an in-flight child that already covers the task', () => {
    expect(taskOverlapDecision(policyWith({ duplicateTaskDetection: true }), {
      objective: 'review the parser changes',
      active: [{ childId: 'child-1', objective: 'review the parser changes' }],
      completed: [],
    })).toEqual({ kind: 'merge', childId: 'child-1', objective: 'review the parser changes' })
  })

  it('prefers the in-flight child when a completed child matches equally', () => {
    expect(taskOverlapDecision(policyWith({ duplicateTaskDetection: true }), {
      objective: 'review the parser changes',
      active: [{ childId: 'child-1', objective: 'review the parser changes' }],
      completed: [{ childId: 'child-2', objective: 'review the parser changes', result: 'the parser is fine' }],
    })).toEqual({ kind: 'merge', childId: 'child-1', objective: 'review the parser changes' })
  })

  it('narrows the scope of a task a completed child partly covered', () => {
    expect(taskOverlapDecision(policyWith({ duplicateTaskDetection: true }), {
      objective: 'review the parser changes',
      active: [],
      completed: [{ childId: 'child-2', objective: 'audit the parser changes', result: 'audited' }],
    })).toEqual({ kind: 'narrow', childId: 'child-2', objective: 'audit the parser changes', overlap: 2 / 3 })
  })

  it('avoids the spawn when a completed child ran the task but kept no result', () => {
    expect(taskOverlapDecision(policyWith({ duplicateTaskDetection: true }), {
      objective: 'review the parser changes',
      active: [],
      completed: [{ childId: 'child-2', objective: 'review the parser changes' }],
    })).toEqual({
      kind: 'avoid',
      childId: 'child-2',
      objective: 'review the parser changes',
      reason: 'a child already completed this task (child-2) and this session retains no result to reuse',
    })
  })
})
