/**
 * What one delegating session has already spawned: the children still in
 * flight, the ones that settled with a result this session can reuse, and the
 * count the delegation policy's per-parent caps are checked against.
 *
 * The ledger is keyed by the live parent `Session` object, and a restarted
 * process starts with none of it: after a restart the first delegation of a
 * session is admitted as if it were the first. Everything it holds was observed
 * by the spawn boundary itself — this tool's own admitted spawns and the
 * `subagent/end` events that settle them — so admitting a spawn costs no log
 * read and no model call.
 *
 * @module @deepseek-ai/dsh-tool-subagent/delegation-children
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ActiveChildTask, CompletedChildTask, DelegationHistory } from '@deepseek-ai/dsh-agent-kernel'

/** Settled children one parent keeps for overlap comparison, most recent first. */
const RECENT_COMPLETED_CHILDREN = 8

/** The result one settled child returned, as the reuse path re-serves it. */
export interface DelegationChildResult {
  /** The child's final text, as the reuse path shows it. */
  readonly text: string
  /** The child's output blocks, as its own tool result carried them. */
  readonly output: readonly JsonValue[]
  /** The child's validated structured value, when it returned one. */
  readonly structured?: JsonValue
}

/** The handle one admitted spawn holds, for the boundary to settle later. */
export interface DelegationSpawn {
  /** Identity of this delegation within its parent's ledger. */
  readonly id: string
  /** Durable child identity, absent when the provider published none. */
  readonly childId?: string
}

/** One child of one parent, in flight or settled. */
interface LedgerChild {
  readonly spawn: DelegationSpawn
  readonly objective: string
  readonly at: number
  result?: DelegationChildResult
}

/** One parent's own record. */
interface ParentLedger {
  /** Spawns this parent has admitted over its session, monotonic. */
  children: number
  /** In-flight children by delegation identity. */
  readonly active: Map<string, LedgerChild>
  /** Settled children, most recent first, bounded by {@link RECENT_COMPLETED_CHILDREN}. */
  readonly settled: LedgerChild[]
  /** Monotonic counter naming one admitted delegation. */
  nextId: number
}

/** One delegating session's spawn history, read by the spawn boundary. */
export class DelegationLedger {
  private readonly ledgers = new WeakMap<Session, ParentLedger>()
  /**
   * In-flight children by durable child identity, with the parent record that
   * holds them, so a `subagent/end` settles the delegation it belongs to. An
   * entry lives only while its child runs.
   */
  private readonly inFlightChildren = new Map<string, { readonly ledger: ParentLedger; readonly child: LedgerChild }>()

  /** The record of one parent, created on its first admitted spawn. */
  private ledgerOf(session: Session): ParentLedger {
    const existing = this.ledgers.get(session)
    if (existing !== undefined) return existing
    const created: ParentLedger = { children: 0, active: new Map(), settled: [], nextId: 0 }
    this.ledgers.set(session, created)
    return created
  }

  /**
   * Record one admitted spawn.
   * @param session - the delegating parent's session.
   * @param spawn - the spawn's objective and durable child identity, when the provider published one.
   * @returns the handle that settles this delegation.
   */
  spawn(session: Session, spawn: { readonly objective: string; readonly childId?: string }): DelegationSpawn {
    const ledger = this.ledgerOf(session)
    const handle: DelegationSpawn = {
      id: `delegation-${String(++ledger.nextId)}`,
      ...spawn.childId === undefined ? {} : { childId: spawn.childId },
    }
    const child: LedgerChild = { spawn: handle, objective: spawn.objective, at: Date.now() }
    ledger.children += 1
    ledger.active.set(handle.id, child)
    if (handle.childId !== undefined) this.inFlightChildren.set(handle.childId, { ledger, child })
    return handle
  }

  /**
   * Record that one spawned child settled, retaining the result it returned.
   * @param session - the delegating parent's session.
   * @param spawn - the handle {@link spawn} returned.
   * @param result - the child's result, absent when it returned nothing this session may reuse.
   */
  settle(session: Session, spawn: DelegationSpawn, result?: DelegationChildResult): void {
    const ledger = this.ledgers.get(session)
    const child = ledger?.active.get(spawn.id)
    if (ledger === undefined || child === undefined) return
    if (spawn.childId !== undefined) this.inFlightChildren.delete(spawn.childId)
    ledger.active.delete(spawn.id)
    this.retain(ledger, result === undefined ? child : { ...child, result })
  }

  /**
   * Record that the child of one published run settled, identified by the
   * durable child identity a `subagent/end` carries.
   * @param childId - the settled child's session identity.
   * @param result - the child's final message, absent when the run carried none.
   */
  settleChild(childId: string, result?: DelegationChildResult): void {
    const entry = this.inFlightChildren.get(childId)
    if (entry === undefined) return
    this.inFlightChildren.delete(childId)
    entry.ledger.active.delete(entry.child.spawn.id)
    this.retain(entry.ledger, result === undefined ? entry.child : { ...entry.child, result })
  }

  /**
   * What one parent has admitted, as the delegation policy's caps read it.
   * @param session - the delegating parent's session.
   * @returns the parent's cumulative child count and its children in flight.
   */
  history(session: Session): DelegationHistory {
    const ledger = this.ledgers.get(session)
    return { children: ledger?.children ?? 0, concurrent: ledger?.active.size ?? 0 }
  }

  /**
   * The children of one parent that are still in flight.
   * @param session - the delegating parent's session.
   * @returns one entry per in-flight child, in spawn order.
   */
  activeTasks(session: Session): readonly ActiveChildTask[] {
    return [...this.ledgers.get(session)?.active.values() ?? []].map(child => ({
      childId: child.spawn.childId ?? child.spawn.id,
      objective: child.objective,
    }))
  }

  /**
   * The children of one parent that settled, most recent first.
   * @param session - the delegating parent's session.
   * @returns one entry per retained child, carrying the result text when one was kept.
   */
  completedTasks(session: Session): readonly CompletedChildTask[] {
    return [...this.ledgers.get(session)?.settled ?? []].map(child => ({
      childId: child.spawn.childId ?? child.spawn.id,
      objective: child.objective,
      ...child.result === undefined ? {} : { result: child.result.text },
    }))
  }

  /**
   * The result one settled child of this parent retained for reuse.
   * @param session - the delegating parent's session.
   * @param childId - the child identity the overlap decision named.
   * @returns the retained result, or undefined when this session kept none.
   */
  retainedResult(session: Session, childId: string): DelegationChildResult | undefined {
    const settled = this.ledgers.get(session)?.settled
    return settled?.find(child => (child.spawn.childId ?? child.spawn.id) === childId)?.result
  }

  /** Retain one settled child inside its parent's bound. */
  private retain(ledger: ParentLedger, child: LedgerChild): void {
    ledger.settled.unshift(child)
    ledger.settled.length = Math.min(ledger.settled.length, RECENT_COMPLETED_CHILDREN)
  }
}
