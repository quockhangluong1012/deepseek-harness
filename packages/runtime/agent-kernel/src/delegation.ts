/**
 * Delegation: the authority one run hands to a child, and the intersection
 * every child action is checked against.
 *
 * A receipt only ever withholds. It is written into the child's own log before
 * its first step, so a replay reconstructs the child's authority without the
 * parent's session, and a nested delegation narrows its parent's receipt rather
 * than replacing it.
 *
 * @module @deepseek-ai/dsh-agent-kernel/delegation
 */

import { createHash } from 'node:crypto'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { insideWorkspace } from './policy.ts'
import type {
  Capability,
  CapabilityRequest,
  BudgetReservation,
  DelegationId,
  DelegationReceipt,
  KernelView,
  PolicyDocument,
  ResourceBudget,
  RunId,
} from './types.ts'

/** The writable scope that admits every path, used when a boundary is unrestricted. */
export const UNRESTRICTED_SCOPE = '**'

/** Capabilities a receipt bounds by writable scope rather than by presence alone. */
const MUTATING_CAPABILITIES: readonly Capability[] = ['fs.write', 'fs.edit', 'git.write']

/**
 * Digest one permission document and the profile name it is mounted under, so
 * a reader can tell whether a child ran under the rules its parent did.
 * @param document - the deployment's permission document.
 * @param policyProfile - the policy profile name recorded on the task contract.
 * @returns the lower-case hex SHA-256 of the canonical pair.
 */
export function policyDigest(document: PolicyDocument, policyProfile: string): string {
  return createHash('sha256').update(JSON.stringify({ policyProfile, document }), 'utf8').digest('hex')
}

/**
 * The writable scopes one resolved boundary admits.
 * @param sandbox - the resolved technical boundary.
 * @returns every path for an unrestricted boundary, the workspace root for a
 *   writing one, and nothing for a read-only one.
 */
export function writableScopesOf(sandbox: SandboxExecutionPolicy): readonly string[] {
  switch (sandbox.mode) {
    case 'danger-full-access':
      return [UNRESTRICTED_SCOPE]
    case 'workspace-write':
      return [sandbox.workspaceRoot]
    case 'read-only':
      return []
    /* v8 ignore next 3 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default:
      return assertNever(sandbox.mode, 'SandboxMode')
  }
}

/**
 * Narrow one set of writable scopes to another. An unrestricted outer scope
 * lets the inner scope decide; an unrestricted inner scope defers to the outer.
 * @param outer - the parent's scopes.
 * @param inner - the scopes this delegation would otherwise grant.
 * @returns the scopes inside both.
 */
function narrowScopes(outer: readonly string[], inner: readonly string[]): readonly string[] {
  if (outer.includes(UNRESTRICTED_SCOPE)) return [...inner]
  if (inner.includes(UNRESTRICTED_SCOPE)) return [...outer]
  return inner.filter(scope => outer.some(outerScope => insideWorkspace(outerScope, scope)))
}

/** Everything one receipt is computed from. */
export interface DelegationInput {
  /** Identity of the receipt being issued. */
  readonly delegationId: DelegationId
  /** Run identity the child's task contract will carry. */
  readonly childRunId: RunId
  /** Durable parent session named by the child session's header. */
  readonly parentSessionId: SessionId
  /** The parent's kernel view, absent when its session is not resolvable. */
  readonly parent?: KernelView
  /** Capabilities the deployment's permission document admits, for a root parent. */
  readonly admitted: readonly Capability[]
  /** The parent's resolved technical boundary. */
  readonly sandbox: SandboxExecutionPolicy
  /** Digest of the permission document the grant is computed under. */
  readonly inheritedPolicyDigest: string
  /** The parent's available allowance, which becomes the child's ceiling. */
  readonly resourceLimits: ResourceBudget
  /** Unix epoch milliseconds the receipt is issued. */
  readonly at: number
}

/**
 * The ceilings one delegation hands a child: exactly what the parent reserved
 * for it, so a child is never promised budget a sibling already holds. A child
 * granted the parent's raw remaining instead would double-count it, because the
 * parent's remaining is measured from the parent's own spend and knows nothing
 * of what it has already promised.
 * @param parent - the delegating parent's view, absent when it is not resolvable.
 * @param reservation - the hold the child's grant was drawn from, absent for a parent without one.
 * @param deployment - the ceilings this kernel was configured with.
 * @returns the ceilings the child's task contract starts from.
 */
export function delegableBudget(
  parent: KernelView | undefined,
  reservation: BudgetReservation | undefined,
  deployment: ResourceBudget,
): ResourceBudget {
  return parent === undefined || reservation === undefined ? deployment : reservation.amount
}

/**
 * Build the receipt one child run acts under.
 * @param input - the parent's view, boundary, budget, and the child's identity.
 * @returns the receipt, narrowed by the parent's own receipt when it has one.
 */
export function delegationReceipt(input: DelegationInput): DelegationReceipt {
  const inherited = input.parent?.delegation
  const maxDepth = narrowerDepth(input.parent?.task.budget.maxSubagentDepth, inherited?.maxDepth)
  const scopes = writableScopesOf(input.sandbox)
  return {
    delegationId: input.delegationId,
    childRunId: input.childRunId,
    ...input.parent === undefined ? {} : { parentRunId: input.parent.task.runId, parentTaskId: input.parent.task.taskId },
    parentSessionId: input.parentSessionId,
    allowedCapabilities: inherited?.allowedCapabilities ?? input.admitted,
    resourceLimits: input.resourceLimits,
    writableScopes: inherited === undefined ? scopes : narrowScopes(inherited.writableScopes, scopes),
    inheritedPolicyDigest: input.inheritedPolicyDigest,
    depth: (inherited?.depth ?? 0) + 1,
    ...maxDepth === undefined ? {} : { maxDepth },
    at: input.at,
  }
}

/**
 * The smaller of two declared depth caps.
 * @param declared - the cap the parent's own task budget declares.
 * @param inherited - the cap the parent's receipt carries.
 * @returns the smaller cap, or undefined when neither declares one.
 */
function narrowerDepth(declared: number | undefined, inherited: number | undefined): number | undefined {
  if (declared === undefined) return inherited
  if (inherited === undefined) return declared
  return Math.min(declared, inherited)
}

/**
 * Why a receipt refuses one action's capabilities, or undefined when it admits
 * them all. Depth is checked beside the capabilities: a delegation past its
 * parent's cap refuses every action rather than only the ones that delegate.
 * @param receipt - the child's delegation receipt.
 * @param requests - the action's declared capability requests.
 * @returns the refusal reason, or undefined.
 */
export function delegationRefusal(receipt: DelegationReceipt, requests: readonly CapabilityRequest[]): string | undefined {
  if (receipt.maxDepth !== undefined && receipt.depth > receipt.maxDepth) {
    return `the delegation is at depth ${String(receipt.depth)}, past the ${String(receipt.maxDepth)} its parent allows`
  }
  for (const request of requests) {
    if (!receipt.allowedCapabilities.includes(request.capability)) {
      return `the delegation does not grant ${request.capability}`
    }
    if (!MUTATING_CAPABILITIES.includes(request.capability)) continue
    if (!receipt.writableScopes.some(scope => scope === UNRESTRICTED_SCOPE || insideWorkspace(scope, request.resource))) {
      return receipt.writableScopes.length === 0
        ? `the delegation refuses ${request.capability} outside every writable scope`
        : `the delegation refuses ${request.capability} outside ${receipt.writableScopes.join(', ')}`
    }
  }
  return undefined
}
