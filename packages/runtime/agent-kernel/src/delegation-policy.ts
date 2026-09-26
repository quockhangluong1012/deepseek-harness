/**
 * The delegation policy: the bounds a delegating agent's children are held to,
 * checked where a spawn is admitted rather than after the child exists.
 *
 * The policy answers four admission questions — how many children this parent
 * may create, how many it may keep in flight, which roles it may spawn, and
 * whether a spawn must carry an output schema — and supplies the child-depth
 * cap, the token ceiling, and the cost ceiling handed to the child. Depth is
 * checked by the provider the request reaches, because only it knows the
 * child's computed depth; the ceilings ride the child's own worker limits, so
 * the child enforces them on itself.
 *
 * A refusal is one sentence and never a silent skip: the boundary that admits
 * the spawn reports it to whoever asked for the child.
 *
 * @module @deepseek-ai/dsh-agent-kernel/delegation-policy
 */

import z from '@deepseek-ai/schemastery'

/** Axis value meaning this deployment declares no ceiling on that axis. */
export const NO_DELEGATION_CEILING = Number.MAX_SAFE_INTEGER

/**
 * The bounds one delegating agent's children are held to. Every axis is
 * required so a reader never has to distinguish "no ceiling declared" from
 * "unbounded"; {@link NO_DELEGATION_CEILING} states the latter explicitly.
 */
export interface DelegationPolicy {
  /** Deepest child depth this deployment admits; the provider checks it against the child's computed depth. */
  readonly maxDepth: number
  /** Children one parent may create over its session. */
  readonly maxChildren: number
  /** Children of one parent that may be in flight at once. */
  readonly maxConcurrent: number
  /** Priced USD one child may spend, handed to the child as its own ceiling. */
  readonly maxCost: number
  /** Billed tokens one child may spend, handed to the child as its own ceiling. */
  readonly maxTokens: number
  /** Role names this deployment admits; empty admits every role, including a spawn that names none. */
  readonly allowedRoles: readonly string[]
  /** Whether a spawn is compared against the parent's active and recently completed children before it is admitted. */
  readonly duplicateTaskDetection: boolean
  /** Whether every admitted spawn must declare an output schema for its child. */
  readonly resultSchemaRequired: boolean
}

/**
 * The policy axes a deployment declares. An omitted axis keeps the shipped
 * default, so a deployment changes one bound without restating the rest.
 */
export interface DelegationPolicyConfig {
  /** Deepest child depth this deployment admits; an omitted value uses the deployment's subagent depth setting. */
  maxDepth?: number
  /** Children one parent may create over its session. */
  maxChildren?: number
  /** Children of one parent that may be in flight at once. */
  maxConcurrent?: number
  /** Priced USD one child may spend. */
  maxCost?: number
  /** Billed tokens one child may spend. */
  maxTokens?: number
  /** Role names this deployment admits; empty admits every role. */
  allowedRoles?: string[]
  /** Whether a spawn is compared against the parent's other children before it is admitted. */
  duplicateTaskDetection?: boolean
  /** Whether every admitted spawn must declare an output schema. */
  resultSchemaRequired?: boolean
}

/**
 * The shipped policy: no ceiling on any axis, every role admitted, no
 * duplicate-task detection, and no output-schema requirement. A deployment
 * that declares nothing keeps the behavior it had before this policy existed.
 */
export const DELEGATION_POLICY_DEFAULTS: DelegationPolicy = {
  maxDepth: NO_DELEGATION_CEILING,
  maxChildren: NO_DELEGATION_CEILING,
  maxConcurrent: NO_DELEGATION_CEILING,
  maxCost: NO_DELEGATION_CEILING,
  maxTokens: NO_DELEGATION_CEILING,
  allowedRoles: [],
  duplicateTaskDetection: false,
  resultSchemaRequired: false,
}

/** Largest bound any numeric policy axis accepts, matching {@link NO_DELEGATION_CEILING}. */
const MAX_BOUND = NO_DELEGATION_CEILING

/** Configuration schema for one delegation policy, defaulted from {@link DELEGATION_POLICY_DEFAULTS}. */
export const delegationPolicySchema = z.object({
  // Omitted stays omitted: this axis' deployment default is the consumer's own
  // child-depth setting, which only that consumer resolves, so the schema must
  // not materialize a value here.
  maxDepth: z.number().step(1).min(0).max(MAX_BOUND).default(undefined as unknown as number),
  maxChildren: z.number().step(1).min(0).max(MAX_BOUND).default(DELEGATION_POLICY_DEFAULTS.maxChildren),
  maxConcurrent: z.number().step(1).min(0).max(MAX_BOUND).default(DELEGATION_POLICY_DEFAULTS.maxConcurrent),
  maxCost: z.number().min(0).max(MAX_BOUND).default(DELEGATION_POLICY_DEFAULTS.maxCost),
  maxTokens: z.number().step(1).min(0).max(MAX_BOUND).default(DELEGATION_POLICY_DEFAULTS.maxTokens),
  allowedRoles: z.array(z.string()).default([...DELEGATION_POLICY_DEFAULTS.allowedRoles]),
  duplicateTaskDetection: z.boolean().default(DELEGATION_POLICY_DEFAULTS.duplicateTaskDetection),
  resultSchemaRequired: z.boolean().default(DELEGATION_POLICY_DEFAULTS.resultSchemaRequired),
})

/**
 * Reject one axis bound the harness cannot compare against.
 * @param axis - the axis name, for the message.
 * @param value - the declared bound.
 * @param integer - whether the axis counts whole units.
 * @throws when the bound is not a non-negative safe integer, or not a
 *   non-negative finite number on a fractional axis.
 */
function assertBound(axis: string, value: number, integer: boolean): void {
  const valid = integer ? Number.isSafeInteger(value) && value >= 0 : Number.isFinite(value) && value >= 0
  if (!valid) {
    throw new Error(
      `delegation policy "${axis}" must be a non-negative ${integer ? 'safe integer' : 'number'}, received ${String(value)}`,
    )
  }
}

/**
 * Resolve the policy one spawn is admitted under.
 * @param configured - the axes this deployment declared, absent when it declared none.
 * @param depth - the child-depth cap this deployment resolves for its subagents, absent when it leaves depth to the provider.
 * @returns the complete policy; an omitted axis keeps its default, and
 *   `maxDepth` falls back to `depth` and then to {@link NO_DELEGATION_CEILING}.
 * @throws when a declared axis is not a non-negative safe integer or a declared role is empty.
 */
export function resolveDelegationPolicy(
  configured: DelegationPolicyConfig | undefined,
  depth: number | undefined,
): DelegationPolicy {
  const policy: DelegationPolicy = {
    maxDepth: configured?.maxDepth ?? depth ?? DELEGATION_POLICY_DEFAULTS.maxDepth,
    maxChildren: configured?.maxChildren ?? DELEGATION_POLICY_DEFAULTS.maxChildren,
    maxConcurrent: configured?.maxConcurrent ?? DELEGATION_POLICY_DEFAULTS.maxConcurrent,
    maxCost: configured?.maxCost ?? DELEGATION_POLICY_DEFAULTS.maxCost,
    maxTokens: configured?.maxTokens ?? DELEGATION_POLICY_DEFAULTS.maxTokens,
    allowedRoles: [...(configured?.allowedRoles ?? DELEGATION_POLICY_DEFAULTS.allowedRoles)],
    duplicateTaskDetection: configured?.duplicateTaskDetection ?? DELEGATION_POLICY_DEFAULTS.duplicateTaskDetection,
    resultSchemaRequired: configured?.resultSchemaRequired ?? DELEGATION_POLICY_DEFAULTS.resultSchemaRequired,
  }
  assertBound('maxDepth', policy.maxDepth, true)
  assertBound('maxChildren', policy.maxChildren, true)
  assertBound('maxConcurrent', policy.maxConcurrent, true)
  assertBound('maxCost', policy.maxCost, false)
  assertBound('maxTokens', policy.maxTokens, true)
  for (const role of policy.allowedRoles) {
    if (role.trim() === '') {
      throw new Error('delegation policy "allowedRoles" must name a non-empty role')
    }
  }
  return policy
}

/** One spawn the boundary is about to admit. */
export interface DelegationAdmission {
  /** Effective role the spawn declares, absent when it names no role. */
  readonly role?: string
  /** Whether the spawn carries the output schema its child must satisfy. */
  readonly hasOutputSchema: boolean
}

/** What the delegating parent has already spawned, as the boundary observes it. */
export interface DelegationHistory {
  /** Children this parent has created over its session. */
  readonly children: number
  /** Children of this parent still in flight. */
  readonly concurrent: number
}

/**
 * Why the policy refuses one spawn, or undefined when it admits it. Bounds are
 * checked in a fixed order — children, concurrency, role, output schema — so a
 * spawn past several bounds always reports the same one.
 * @param policy - the resolved policy.
 * @param admission - the role and output schema the spawn declares.
 * @param history - what this parent has already spawned.
 * @returns the refusal reason, or undefined.
 */
export function delegationPolicyRefusal(
  policy: DelegationPolicy,
  admission: DelegationAdmission,
  history: DelegationHistory,
): string | undefined {
  if (history.children >= policy.maxChildren) {
    return `this delegation policy allows ${String(policy.maxChildren)} children per parent, and the parent already spawned ${String(history.children)}`
  }
  if (history.concurrent >= policy.maxConcurrent) {
    return `this delegation policy allows ${String(policy.maxConcurrent)} children in flight, and the parent already has ${String(history.concurrent)}`
  }
  if (policy.allowedRoles.length > 0) {
    if (admission.role === undefined) {
      return `this delegation policy allows only the roles ${policy.allowedRoles.join(', ')}, and the spawn names none`
    }
    if (!policy.allowedRoles.includes(admission.role)) {
      return `the role "${admission.role}" is not one of the roles this delegation policy allows (${policy.allowedRoles.join(', ')})`
    }
  }
  if (policy.resultSchemaRequired && !admission.hasOutputSchema) {
    return 'this delegation policy requires an output schema, and the spawn declares none'
  }
  return undefined
}

/** The ceilings one admitted spawn hands its child, as that child's worker limits. */
export interface DelegatedWorkerBudget {
  /** Billed tokens the child may spend; absent when the policy declares no token ceiling. */
  readonly maxTokens?: number
  /** Priced USD the child may spend; absent when the policy declares no cost ceiling. */
  readonly maxCostUsd?: number
}

/**
 * The token and cost ceilings this policy hands the child of one admitted spawn.
 * @param policy - the resolved policy.
 * @returns the declared ceilings; an axis at {@link NO_DELEGATION_CEILING} is omitted.
 */
export function delegatedWorkerBudget(policy: DelegationPolicy): DelegatedWorkerBudget {
  return {
    ...policy.maxTokens === NO_DELEGATION_CEILING ? {} : { maxTokens: policy.maxTokens },
    ...policy.maxCost === NO_DELEGATION_CEILING ? {} : { maxCostUsd: policy.maxCost },
  }
}

