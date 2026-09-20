/**
 * The permission-rule engine: compile a deployment's {@link PolicyDocument}
 * once, evaluate one action against it, and compose the result with the
 * implementation's sandbox boundary.
 *
 * Evaluation is broad-to-specific with the last matching rule winning. A rule
 * matches when its action family is one the action's declared capabilities
 * belong to and its resource glob matches that capability's resource. Deny
 * dominates every later composition step, and the technical sandbox is
 * intersected afterwards, so neither a rule nor a human approval can grant
 * outside the configured boundary.
 *
 * @module @deepseek-ai/dsh-agent-kernel/policy
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  ActionProposal,
  AuthorizationDecision,
  Capability,
  CapabilityRequest,
  PolicyAction,
  PolicyContext,
  PolicyDecision,
  PolicyDecisionId,
  PolicyDocument,
  PolicyEffect,
  PolicyEngine,
  PolicyRule,
} from './types.ts'

/** Every action family a permission rule may select. */
export const POLICY_ACTIONS = [
  'read',
  'write',
  'edit',
  'shell',
  'network',
  'mcp',
  'delegate',
  'workflow',
  'memory',
  'policy',
] as const satisfies readonly PolicyAction[]

/** Every decision a permission rule or default may make. */
export const POLICY_EFFECTS = ['allow', 'ask', 'deny'] as const satisfies readonly PolicyEffect[]

/**
 * The action family each capability belongs to. A tool declares capabilities;
 * the rule document selects families, so a rule never names a tool.
 */
const CAPABILITY_ACTIONS: Readonly<Record<Capability, PolicyAction>> = {
  'fs.read': 'read',
  'fs.write': 'write',
  'fs.edit': 'edit',
  'process.exec': 'shell',
  'terminal.interactive': 'shell',
  'network.read': 'network',
  'network.write': 'network',
  'mcp.call': 'mcp',
  'memory.read': 'memory',
  'memory.write': 'memory',
  'subagent.spawn': 'delegate',
  'workflow.start': 'workflow',
  'approval.request': 'policy',
  'policy.propose': 'policy',
}

/** Capabilities a `read-only` sandbox refuses outright. */
const MUTATING_CAPABILITIES: readonly Capability[] = ['fs.write', 'fs.edit']

/**
 * Translate one resource glob into a regular expression. `**` matches any run
 * of characters including `/`, `*` matches a run without `/`, and `?` matches
 * one character without `/`; every other character is literal.
 * @param glob - the rule's resource selector.
 * @returns the compiled pattern, anchored at both ends.
 */
function resourcePattern(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob.charAt(index)
    if (character === '*' && glob.charAt(index + 1) === '*') {
      source += '.*'
      index += 1
    } else if (character === '*') {
      source += '[^/]*'
    } else if (character === '?') {
      source += '[^/]'
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/** One rule with its compiled resource pattern. */
interface CompiledRule {
  readonly action: PolicyAction
  readonly resource: string
  readonly effect: PolicyEffect
  readonly pattern: RegExp
}

/** A policy document prepared for evaluation. */
export interface CompiledPolicy {
  /** Decision for an action no rule matches. */
  readonly defaultEffect: PolicyEffect
  /** Rules in declaration order. */
  readonly rules: readonly CompiledRule[]
}

/**
 * Validate a permission document and compile its resource selectors.
 * Misconfiguration fails loud here, at load: an unknown action, an unknown
 * effect, or an empty resource would otherwise silently never match.
 * @param document - the deployment's permission document.
 * @returns the compiled document.
 * @throws When the document declares an unknown action, an unknown effect, or an empty resource.
 */
export function compilePolicy(document: PolicyDocument): CompiledPolicy {
  if (!POLICY_EFFECTS.includes(document.defaults.effect)) {
    throw new Error(`agent-kernel: unknown default policy effect ${JSON.stringify(document.defaults.effect)}`)
  }
  const rules = document.rules.map((rule: PolicyRule, index: number): CompiledRule => {
    if (!POLICY_ACTIONS.includes(rule.action)) {
      throw new Error(`agent-kernel: policy rule ${index} declares unknown action ${JSON.stringify(rule.action)}`)
    }
    if (!POLICY_EFFECTS.includes(rule.effect)) {
      throw new Error(`agent-kernel: policy rule ${index} declares unknown effect ${JSON.stringify(rule.effect)}`)
    }
    if (rule.resource.length === 0) {
      throw new Error(`agent-kernel: policy rule ${index} declares an empty resource selector`)
    }
    return { action: rule.action, resource: rule.resource, effect: rule.effect, pattern: resourcePattern(rule.resource) }
  })
  return { defaultEffect: document.defaults.effect, rules }
}

/**
 * Whether an absolute write target stays inside the workspace root. A relative
 * selector is workspace-relative by contract and is therefore inside.
 * @param root - the resolved workspace root.
 * @param target - the capability's resource selector.
 * @returns true when the target is inside the boundary.
 */
function insideWorkspace(root: string, target: string): boolean {
  if (!isAbsolute(target)) return true
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/**
 * The rule decision for one action, before sandbox and human composition.
 * Implements {@link PolicyEngine}.
 */
export class PermissionPolicyEngine implements PolicyEngine {
  /** The compiled document every evaluation reads. */
  private readonly compiled: CompiledPolicy

  /**
   * Compile one document for this engine's lifetime.
   * @param document - the deployment's permission document.
   * @throws When the document is invalid; see {@link compilePolicy}.
   */
  constructor(document: PolicyDocument) {
    this.compiled = compilePolicy(document)
  }

  /**
   * Evaluate one action against the compiled document. The last matching rule
   * wins; an action whose tool declared no capability fails closed without
   * consulting the rules, because there is no resource to match against.
   * @param context - the action, its declared capabilities, and its boundaries.
   * @returns the rule decision.
   */
  evaluate(context: PolicyContext): PolicyDecision {
    const decisionId = brandString<PolicyDecisionId>(randomUUID())
    const reasons: string[] = []
    if (context.undeclared) {
      reasons.push(`tool "${context.action.toolName}" declared no capability; failing closed`)
      return {
        decisionId,
        actionId: context.action.actionId,
        effect: 'deny',
        matchedRuleIndex: null,
        capabilities: [],
        reasons,
      }
    }
    let matched: { rule: CompiledRule; index: number } | undefined
    for (const [index, rule] of this.compiled.rules.entries()) {
      const request = matchingRequest(rule, context.capabilities)
      if (request === undefined) continue
      matched = { rule, index }
      reasons.push(`rule ${index} (${rule.action} ${JSON.stringify(rule.resource)}) matched ${request.capability} ${JSON.stringify(request.resource)}`)
    }
    if (matched === undefined) {
      reasons.push(`no rule matched; default effect ${this.compiled.defaultEffect}`)
      return {
        decisionId,
        actionId: context.action.actionId,
        effect: this.compiled.defaultEffect,
        matchedRuleIndex: null,
        capabilities: context.capabilities,
        reasons,
      }
    }
    reasons.push(`rule ${matched.index} decides ${matched.rule.effect}`)
    return {
      decisionId,
      actionId: context.action.actionId,
      effect: matched.rule.effect,
      matchedRuleIndex: matched.index,
      capabilities: context.capabilities,
      reasons,
    }
  }
}

/**
 * The first capability request a rule selects, or undefined when the rule does
 * not match this action at all.
 * @param rule - the compiled rule to test.
 * @param requests - the action's declared capability requests.
 * @returns the matched request, or undefined.
 */
function matchingRequest(rule: CompiledRule, requests: readonly CapabilityRequest[]): CapabilityRequest | undefined {
  return requests.find(request =>
    CAPABILITY_ACTIONS[request.capability] === rule.action && rule.pattern.test(request.resource))
}

/**
 * Intersect a rule decision with the implementation's sandbox boundary. Deny
 * from the rules dominates; a mutating capability the boundary refuses is
 * denied rather than asked, because no human answer can widen the technical
 * sandbox. An `ask` stays an `ask`: only the composed answerer chain may
 * resolve it, and it fails closed when no answerer is available.
 * @param decision - the rule decision to compose.
 * @param proposal - the action the decision answers.
 * @param context - the boundaries the decision composes with.
 * @param enforced - whether the kernel acts on the composed effect.
 * @returns the composed authorization.
 */
export function composeAuthorization(
  decision: PolicyDecision,
  proposal: ActionProposal,
  context: PolicyContext,
  enforced: boolean,
): AuthorizationDecision {
  const reasons = [...decision.reasons]
  const sandbox = context.sandbox
  const refuse = (reason: string): AuthorizationDecision => {
    reasons.push(reason)
    return { effect: 'deny', decisionId: decision.decisionId, capabilityGrants: [], sandbox, enforced, reasons }
  }
  if (decision.effect === 'deny') return refuse('policy rules denied the action')
  const blocked = sandboxRefusal(sandbox, decision.capabilities)
  if (blocked !== undefined) return refuse(blocked)
  if (decision.effect === 'ask') {
    return {
      effect: 'ask',
      decisionId: decision.decisionId,
      capabilityGrants: [],
      sandbox,
      enforced,
      reasons: [...reasons, `action "${proposal.toolName}" requires a human decision`],
    }
  }
  return {
    effect: 'allow',
    decisionId: decision.decisionId,
    capabilityGrants: decision.capabilities.map(request => request.capability),
    sandbox,
    enforced,
    reasons,
  }
}

/**
 * The sandbox boundary a set of capabilities violates, or undefined when the
 * boundary admits them all.
 * @param sandbox - the resolved technical boundary.
 * @param requests - the action's declared capability requests.
 * @returns the refusal reason, or undefined.
 */
function sandboxRefusal(sandbox: SandboxExecutionPolicy, requests: readonly CapabilityRequest[]): string | undefined {
  switch (sandbox.mode) {
    case 'danger-full-access':
      return undefined
    case 'read-only':
      return requests.some(request => MUTATING_CAPABILITIES.includes(request.capability))
        ? 'the read-only file policy refuses every mutating capability'
        : undefined
    case 'workspace-write': {
      const outside = requests.find(request =>
        MUTATING_CAPABILITIES.includes(request.capability) && !insideWorkspace(sandbox.workspaceRoot, request.resource))
      return outside === undefined
        ? undefined
        : `the workspace-write file policy refuses ${outside.capability} outside ${sandbox.workspaceRoot}`
    }
    /* v8 ignore next 3 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default:
      return assertNever(sandbox.mode, 'SandboxMode')
  }
}
