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
import { delegationRefusal } from './delegation.ts'
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
  'browser',
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
  'git.read': 'read',
  'git.write': 'write',
  'fs.edit': 'edit',
  'process.exec': 'shell',
  'terminal.interactive': 'shell',
  'network.read': 'network',
  'network.write': 'network',
  'browser.read': 'browser',
  'mcp.call': 'mcp',
  'memory.read': 'memory',
  'memory.write': 'memory',
  'subagent.spawn': 'delegate',
  'workflow.start': 'workflow',
  'approval.request': 'policy',
  'policy.propose': 'policy',
}

/** Capabilities a `read-only` sandbox refuses outright. */
const MUTATING_CAPABILITIES: readonly Capability[] = ['fs.write', 'fs.edit', 'git.write']

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
export function insideWorkspace(root: string, target: string): boolean {
  if (!isAbsolute(target)) return true
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/**
 * Every capability the vocabulary declares, in declaration order: the grant
 * vocabulary a permission rule, a delegation receipt, and an agent profile all
 * speak. Exported so a configuration schema can reject a name the kernel would
 * never evaluate instead of accepting it silently.
 */
export const CAPABILITY_VOCABULARY = Object.keys(CAPABILITY_ACTIONS) as Capability[]

/**
 * Every capability a compiled document admits at all. A capability is admitted
 * when its action family is not denied outright: either the default effect is
 * not `deny`, or some rule selecting that family carries a non-deny effect.
 * This is the boundary a root run hands to its children; a nested delegation
 * narrows its parent's receipt instead of recomputing one.
 * @param compiled - the compiled document.
 * @returns the admitted capabilities, in vocabulary order.
 */
export function admittedCapabilities(compiled: CompiledPolicy): Capability[] {
  const families = new Set<PolicyAction>()
  if (compiled.defaultEffect !== 'deny') {
    for (const action of POLICY_ACTIONS) families.add(action)
  }
  for (const rule of compiled.rules) {
    if (rule.effect !== 'deny') families.add(rule.action)
  }
  return CAPABILITY_VOCABULARY.filter(capability => families.has(CAPABILITY_ACTIONS[capability]))
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
   * Evaluate each declared capability independently. The last matching rule
   * decides that capability; any denial dominates, then approval, then allow.
   * An action with no required capability fails closed.
   * @param context - the action, its declared capabilities, and its boundaries.
   * @returns the rule decision.
   */
  evaluate(context: PolicyContext): PolicyDecision {
    const decisionId = brandString<PolicyDecisionId>(randomUUID())
    const reasons: string[] = []
    if (context.undeclared || context.capabilities.length === 0) {
      reasons.push(context.undeclared
        ? `tool "${context.action.toolName}" declared no capability; failing closed`
        : `tool "${context.action.toolName}" declared no required capability; failing closed`)
      return {
        decisionId,
        actionId: context.action.actionId,
        effect: 'deny',
        matchedRuleIndex: null,
        capabilities: [],
        reasons,
      }
    }

    let effect: PolicyEffect = 'allow'
    let matchedRuleIndex: number | null = null
    for (const request of context.capabilities) {
      let matched: { rule: CompiledRule; index: number } | undefined
      for (const [index, rule] of this.compiled.rules.entries()) {
        if (CAPABILITY_ACTIONS[request.capability] !== rule.action || !rule.pattern.test(request.resource)) continue
        matched = { rule, index }
        reasons.push(`rule ${index} (${rule.action} ${JSON.stringify(rule.resource)}) matched ${request.capability} ${JSON.stringify(request.resource)}`)
      }
      const requestEffect = matched?.rule.effect ?? this.compiled.defaultEffect
      if (matched === undefined) reasons.push(`no rule matched; default effect ${requestEffect}`)
      else reasons.push(`rule ${matched.index} decides ${requestEffect}`)

      if (requestEffect === 'deny' && effect !== 'deny') {
        effect = 'deny'
        matchedRuleIndex = matched?.index ?? null
      } else if (requestEffect === 'ask' && effect === 'allow') {
        effect = 'ask'
        matchedRuleIndex = matched?.index ?? null
      } else if (requestEffect === effect && matched !== undefined) {
        matchedRuleIndex = matched.index
      }
    }

    return {
      decisionId,
      actionId: context.action.actionId,
      effect,
      matchedRuleIndex,
      capabilities: context.capabilities,
      reasons,
    }
  }
}


/**
 * Intersect a rule decision with the implementation's sandbox boundary and the
 * delegation the action runs under. Deny from the rules dominates; a mutating
 * capability the boundary refuses is denied rather than asked, because no human
 * answer can widen the technical sandbox; and a capability, resource, or depth
 * the child's receipt withholds is denied for the same reason. An `ask` stays
 * an `ask`: only the composed answerer chain may resolve it, and it fails
 * closed when no answerer is available.
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
  const delegationId = context.parentGrant?.delegationId
  const refuse = (reason: string): AuthorizationDecision => {
    reasons.push(reason)
    return {
      effect: 'deny',
      decisionId: decision.decisionId,
      capabilityGrants: [],
      sandbox,
      enforced,
      ...delegationId === undefined ? {} : { delegationId },
      reasons,
    }
  }
  if (decision.effect === 'deny') return refuse('policy rules denied the action')
  const blocked = sandboxRefusal(sandbox, decision.capabilities)
  if (blocked !== undefined) return refuse(blocked)
  const outsideRole = profileRefusal(context.agentGrant, decision.capabilities)
  if (outsideRole !== undefined) return refuse(outsideRole)
  const withheld = context.parentGrant === undefined
    ? undefined
    : delegationRefusal(context.parentGrant, decision.capabilities)
  if (withheld !== undefined) return refuse(withheld)
  if (decision.effect === 'ask') {
    return {
      effect: 'ask',
      decisionId: decision.decisionId,
      capabilityGrants: [],
      sandbox,
      enforced,
      ...delegationId === undefined ? {} : { delegationId },
      reasons: [...reasons, `action "${proposal.toolName}" requires a human decision`],
    }
  }
  return {
    effect: 'allow',
    decisionId: decision.decisionId,
    capabilityGrants: decision.capabilities.map(request => request.capability),
    sandbox,
    enforced,
    ...delegationId === undefined ? {} : { delegationId },
    reasons,
  }
}

/**
 * The capability an agent profile withholds, if any. A profile is a role
 * boundary: the permission document may allow a capability for the deployment
 * and still not intend it for this role.
 * @param grant - the role's capability grant, absent when no profile is registered.
 * @param requests - the capabilities this invocation needs.
 * @returns the refusal reason, or undefined when the role covers every request.
 */
function profileRefusal(grant: readonly Capability[] | undefined, requests: readonly CapabilityRequest[]): string | undefined {
  if (grant === undefined) return undefined
  const outside = requests.find(request => !grant.includes(request.capability))
  return outside === undefined
    ? undefined
    : `the agent profile withholds capability "${outside.capability}"`
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
