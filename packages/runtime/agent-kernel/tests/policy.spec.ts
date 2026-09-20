import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  compilePolicy,
  composeAuthorization,
  PermissionPolicyEngine,
  POLICY_ACTIONS,
  POLICY_EFFECTS,
} from '../src/policy.ts'
import type {
  ActionId,
  ActionProposal,
  Capability,
  CapabilityRequest,
  PolicyContext,
  PolicyDocument,
} from '../src/types.ts'

/** One proposal for the tool under test. */
function proposal(toolName = 'write_file'): ActionProposal {
  return {
    actionId: brandString<ActionId>('call-1'),
    agentId: SessionId('agent-1'),
    toolName,
    arguments: {},
    source: 'model',
    taskRevision: 1,
    trust: 'unknown',
  }
}

/** One declared capability request. */
function request(capability: Capability, resource: string): CapabilityRequest {
  return { capability, resource }
}

/** A policy context with the given capabilities and boundary. */
function context(
  capabilities: readonly CapabilityRequest[],
  sandbox: SandboxExecutionPolicy = { mode: 'danger-full-access', workspaceRoot: 'C:\\ws' },
  undeclared = false,
): PolicyContext {
  return { action: proposal(), capabilities, undeclared, sandbox }
}

describe('policy compilation', () => {
  it('compiles a valid document and exposes the default effect', () => {
    const compiled = compilePolicy({
      defaults: { effect: 'ask' },
      rules: [{ action: 'read', resource: 'workspace/**', effect: 'allow' }],
    })
    expect(compiled.defaultEffect).toBe('ask')
    expect(compiled.rules).toHaveLength(1)
    expect(compiled.rules[0]?.pattern.test('workspace/a/b.ts')).toBe(true)
  })

  it('carries every action family and effect the schema accepts', () => {
    expect([...POLICY_ACTIONS]).toContain('policy')
    expect([...POLICY_EFFECTS]).toEqual(['allow', 'ask', 'deny'])
  })

  it('fails loud on an unknown default effect, action, effect, and empty resource', () => {
    const document = (rules: PolicyDocument['rules'], effect: PolicyDocument['defaults']['effect'] = 'ask'): PolicyDocument => ({
      defaults: { effect },
      rules,
    })
    expect(() => compilePolicy(document([], 'bogus' as 'ask'))).toThrow('unknown default policy effect "bogus"')
    expect(() => compilePolicy(document([{ action: 'teleport' as 'read', resource: 'x', effect: 'allow' }]))).toThrow(
      'policy rule 0 declares unknown action "teleport"',
    )
    expect(() => compilePolicy(document([{ action: 'read', resource: 'x', effect: 'maybe' as 'allow' }]))).toThrow(
      'policy rule 0 declares unknown effect "maybe"',
    )
    expect(() => compilePolicy(document([{ action: 'read', resource: '', effect: 'allow' }]))).toThrow(
      'policy rule 0 declares an empty resource selector',
    )
  })

  it('translates glob metacharacters without leaking regular-expression syntax', () => {
    const compiled = compilePolicy({
      defaults: { effect: 'deny' },
      rules: [{ action: 'read', resource: 'a?c.*', effect: 'allow' }],
    })
    const pattern = compiled.rules[0]?.pattern
    expect(pattern?.test('abc.def')).toBe(true)
    expect(pattern?.test('ac.def')).toBe(false)
    expect(pattern?.test('abcXdef')).toBe(false)
  })
})

describe('permission evaluation', () => {
  it('fails closed for a tool that declared no capability', () => {
    const engine = new PermissionPolicyEngine({ defaults: { effect: 'allow' }, rules: [] })
    const decision = engine.evaluate(context([], undefined, true))
    expect(decision.effect).toBe('deny')
    expect(decision.matchedRuleIndex).toBeNull()
    expect(decision.reasons).toContain('tool "write_file" declared no capability; failing closed')
  })

  it('falls back to the default effect when no rule matches, and the last matching rule wins', () => {
    const engine = new PermissionPolicyEngine({
      defaults: { effect: 'deny' },
      rules: [
        { action: 'write', resource: 'workspace/**', effect: 'allow' },
        { action: 'write', resource: 'workspace/secret/**', effect: 'deny' },
      ],
    })
    expect(engine.evaluate(context([request('fs.read', 'workspace/a')])).effect).toBe('deny')
    expect(engine.evaluate(context([request('fs.read', 'workspace/a')])).reasons).toContain('no rule matched; default effect deny')

    const allowed = engine.evaluate(context([request('fs.write', 'workspace/a')]))
    expect(allowed).toMatchObject({ effect: 'allow', matchedRuleIndex: 0 })

    const overridden = engine.evaluate(context([request('fs.write', 'workspace/secret/a')]))
    expect(overridden).toMatchObject({ effect: 'deny', matchedRuleIndex: 1 })
    expect(overridden.reasons).toContain('rule 1 decides deny')
  })
})

describe('authorization composition', () => {
  const engine = new PermissionPolicyEngine({
    defaults: { effect: 'allow' },
    rules: [{ action: 'shell', resource: '**', effect: 'ask' }],
  })

  it('lets a rule denial dominate every later step', () => {
    const denying = new PermissionPolicyEngine({ defaults: { effect: 'deny' }, rules: [] })
    const ctx = context([request('fs.write', 'workspace/a')])
    const decision = denying.evaluate(ctx)
    const authorization = composeAuthorization(decision, proposal(), ctx, true)
    expect(authorization).toMatchObject({ effect: 'deny', capabilityGrants: [], enforced: true })
    expect(authorization.reasons).toContain('policy rules denied the action')
  })

  it('grants the declared capabilities on an allowed action', () => {
    const ctx = context([request('fs.write', 'workspace/a')])
    const authorization = composeAuthorization(engine.evaluate(ctx), proposal(), ctx, false)
    expect(authorization).toMatchObject({ effect: 'allow', capabilityGrants: ['fs.write'], enforced: false })
  })

  it('records an ask without a human answerer, and refuses mutating capabilities outside the sandbox', () => {
    const shell = context([request('process.exec', 'git status')])
    expect(composeAuthorization(engine.evaluate(shell), proposal(), shell, true)).toMatchObject({ effect: 'ask', capabilityGrants: [] })
    expect(composeAuthorization(engine.evaluate(shell), proposal(), shell, true).reasons)
      .toContain('action "write_file" requires a human decision')

    const readOnly = context([request('fs.write', 'workspace/a')], { mode: 'read-only', workspaceRoot: 'C:\\ws' })
    const refused = composeAuthorization(engine.evaluate(readOnly), proposal(), readOnly, true)
    expect(refused.effect).toBe('deny')
    expect(refused.reasons).toContain('the read-only file policy refuses every mutating capability')

    const writable = context([request('fs.write', 'C:\\elsewhere\\a.ts')], { mode: 'workspace-write', workspaceRoot: 'C:\\ws' })
    const outside = composeAuthorization(engine.evaluate(writable), proposal(), writable, true)
    expect(outside.effect).toBe('deny')
    expect(outside.reasons).toContain('the workspace-write file policy refuses fs.write outside C:\\ws')

    const inside = context([request('fs.write', 'C:\\ws\\a.ts')], { mode: 'workspace-write', workspaceRoot: 'C:\\ws' })
    expect(composeAuthorization(engine.evaluate(inside), proposal(), inside, true).effect).toBe('allow')

    const relative = context([request('fs.edit', 'src/a.ts')], { mode: 'workspace-write', workspaceRoot: 'C:\\ws' })
    expect(composeAuthorization(engine.evaluate(relative), proposal(), relative, true).effect).toBe('allow')

    const rooted = context([request('fs.write', 'C:\\ws')], { mode: 'workspace-write', workspaceRoot: 'C:\\ws' })
    expect(composeAuthorization(engine.evaluate(rooted), proposal(), rooted, true).effect).toBe('allow')

    const readOnlyRead = context([request('fs.read', 'C:\\elsewhere')], { mode: 'read-only', workspaceRoot: 'C:\\ws' })
    expect(composeAuthorization(engine.evaluate(readOnlyRead), proposal(), readOnlyRead, true).effect).toBe('allow')
  })
})
