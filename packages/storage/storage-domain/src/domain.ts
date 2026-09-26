/**
 * Runtime of one open domain: authoritative in-memory state, the single
 * per-domain write chain, and change-event emission. Reads are synchronous
 * from memory; every write queues on the chain, awaits backend durability
 * FIRST, then mutates memory, then emits `domain/changed` — a rejected
 * backend write leaves memory untouched (no divergence between reads and the
 * medium), and events carry values that equal the in-memory state at
 * emission, in write order.
 *
 * A domain whose spec opts into `coalesceWrites` trades that ordering for
 * throughput: each write applies to memory at its chain slot, the writes
 * staged together publish as one backend operation per touched slot, and
 * every caller's promise still resolves only after the publication that
 * covers it landed. A rejected publication restores each failed slot to its
 * pre-batch value, so memory and medium agree again, and the batch emits the
 * last staged change per landed slot.
 * @module @deepseek-ai/dsh-storage-domain/src/domain
 */

import type { Context } from '@deepseek-ai/cordis'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { DomainError } from './error.ts'
import type { DomainSpec, DomainGlobalSpec, TableKeyOf, TableValueOf } from './spec.ts'
import type { DomainChanged } from './events.ts'

/** Handle on a domain's global singleton. */
export interface DomainGlobal<G> {
  /**
   * Current value, synchronously from the authoritative in-memory state.
   * Before the first `set` this is the spec's `initial`.
   * @returns the current global value.
   */
  get(): G

  /**
   * Replace the value durably. Queued on the domain's write chain; the first
   * `set` is what materializes the global on the medium.
   * @param value - New value; must satisfy the spec's schema (not re-checked
   * here — validation happens at the durable read boundary).
   * @returns resolution after durability and event emission.
   */
  set(value: G): Promise<void>
}

/**
 * Handle on one declared table. Records are plain immutable data: returned
 * values are the stored objects themselves (no defensive copies) and must not
 * be mutated in place — replace via `put`/`update`.
 */
export interface KvTable<K extends string, V> {
  /**
   * Read one record, synchronously from memory.
   * @param key - Record key.
   * @returns the record, or `undefined` when absent.
   */
  get(key: K): V | undefined

  /**
   * Snapshot iterator over `[key, record]` pairs. A snapshot, not a live
   * view: iteration stays stable while queued writes land.
   * @returns the pair iterator.
   */
  entries(): IterableIterator<[K, V]>

  /**
   * Snapshot iterator over keys.
   * @returns the key iterator.
   */
  keys(): IterableIterator<K>

  /** Current record count. */
  readonly size: number

  /**
   * Insert or overwrite one record durably.
   * @param key - Record key.
   * @param value - The full new record (no partial merge).
   * @returns resolution after durability and event emission.
   */
  put(key: K, value: V): Promise<void>

  /**
   * Delete one record durably.
   * @param key - Record key.
   * @returns `true` when the record existed, `false` when it was already
   * absent (no write and no event in that case).
   */
  delete(key: K): Promise<boolean>

  /**
   * Atomic read-modify-write on the domain's write chain: `fn` sees the
   * value current at its queue slot, so concurrent updates never interleave.
   * @param key - Record key; a missing key rejects with `missing-key`.
   * @param fn - Synchronous pure transform from current to next record.
   * @returns the stored next record.
   */
  update(key: K, fn: (current: V) => V): Promise<V>
}

/** Global handle of a spec: typed when declared, `never` (inaccessible) when not. */
export type DomainGlobalHandleOf<S extends DomainSpec> =
  S extends { readonly global: DomainGlobalSpec<infer G> } ? DomainGlobal<G> : never

/** One open domain, typed by its spec. */
export interface Domain<S extends DomainSpec> {
  /** Domain name from the spec. */
  readonly name: string
  /** Global singleton handle; a spec without `global` has no usable handle (`never`). */
  readonly global: DomainGlobalHandleOf<S>
  /**
   * Resolve one declared table handle. Handles are stable — repeated calls
   * return the same instance.
   * @param name - Declared table name.
   * @returns the typed table handle.
   */
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>

  /**
   * Settle every write queued and staged so far: the barrier a caller uses at
   * a boundary that must not leave a write pending. Resolves once each write
   * has reached its own outcome — durable, or rejected to the caller that
   * issued it — so a write's failure is never reported through the barrier.
   * A domain without `coalesceWrites` publishes nothing early: this only
   * waits for its write chain to drain.
   * @returns resolution after every write issued before the call settled.
   */
  flush(): Promise<void>

  /**
   * Close this domain: reject new writes immediately, drain already-queued
   * writes (their events still emit), release the backend unit, then free
   * the domain name for a later open. Idempotent — repeated calls share one
   * teardown. The consumer owns this call (typically as its own `ctx.effect`
   * disposer); the facility closes any domain left open when it unmounts.
   * @returns resolution after the unit is released.
   */
  close(): Promise<void>
}

/** Memory state of one write slot, as a batch needs it to roll back. */
interface SlotState {
  /** Whether the slot held a record (`false` for an absent key). */
  readonly has: boolean
  readonly value: unknown
}

/** One change a landed write reports, minus the slot the job already names. */
type WriteChange = { readonly operation: 'put'; readonly value: unknown } | { readonly operation: 'deleted' }

/** What one prepared write does to memory and to the medium. */
interface PreparedDurability {
  /** Durably publish the mutation. */
  publish(): Promise<void>
  /** Apply the mutation to authoritative memory. */
  commit(): void
}

/** One write prepared at its chain slot. */
interface Prepared<T> {
  /** The caller-facing outcome. */
  readonly value: T
  /** The change this write reports once it landed. */
  readonly change: WriteChange
  /** The durable half; absent when the write stores nothing (a delete of an absent key). */
  readonly durable?: PreparedDurability
}

/** One queued write: its slot, its memory accessors, and what it must prepare. */
interface WriteJob<T> {
  /** Table name; `''` for a global-singleton write. */
  readonly table: string
  /** Record key; `''` for a global-singleton write. */
  readonly key: string
  /** Read the slot's memory state (before this job's own mutation). */
  current(): SlotState
  /** Restore the slot to a state captured earlier. */
  restore(state: SlotState): void
  /** Prepare the write at its chain slot. */
  prepare(): Prepared<T>
}

/** One caller waiting for the publication covering its staged write. */
interface BatchWaiter {
  settle(): void
  fail(error: unknown): void
}

/** One staged slot of a batch: the writes of one key, published together. */
interface StagedSlot {
  readonly table: string
  readonly key: string
  /** The slot's memory state when the batch first touched it. */
  readonly before: SlotState
  /** Restore {@link before} after a rejected publication. */
  restore(state: SlotState): void
  /** The publication of the slot's final staged state; the last staged write supplies it. */
  publish(): Promise<void>
  /** The change the slot's last staged write reports. */
  change: WriteChange
  /** The callers whose writes this slot's publication covers. */
  readonly waiters: BatchWaiter[]
}

/** Internal boundary handing table handles their domain-owned write machinery. */
interface TableHost {
  readonly domainName: string
  readonly unit: KvUnit
  /** Queue one write on the domain's single write chain. */
  write<T>(job: WriteJob<T>): Promise<T>
  /** Throw `closed` once the domain has fully closed (reads stay valid while draining). */
  assertReadable(): void
  /** Emit `domain/changed` for one durably landed write. */
  emitChanged(change: DomainChanged): void
}

const noop = () => {}

/**
 * The single domain implementation behind the {@link Domain} interface. The
 * facility constructs it from a validated `loadAll` snapshot and erases it to
 * `Domain<S>`; nothing outside this package constructs one.
 */
export class DomainImpl {
  /** Domain name from the spec. */
  readonly name: string

  private readonly tables = new Map<string, KvTableImpl<string, unknown>>()
  private globalValue: unknown
  private readonly globalHandle?: DomainGlobal<unknown>

  /** Tail of the write chain; every link settles (rejections are observed by the caller's slice). */
  private chain: Promise<void> = Promise.resolve()
  /** Set when close begins: new writes reject while already-queued writes drain. */
  private disposing = false
  /** Set when close finishes (chain drained, unit closed): reads reject from here on. */
  private closed = false
  private disposal?: Promise<void>

  /** The spec's coalescing opt-in: writes stage into batches instead of publishing one by one. */
  private readonly coalescing: boolean
  /** Coalescing: mutation jobs queued on the chain but not yet applied to memory. */
  private queued = 0
  /** Coalescing: slots staged for the next publication, in first-touch order. */
  private batch?: StagedSlot[] | undefined
  /** Coalescing: tail of batch publications, so only one runs at a time. */
  private publishing: Promise<void> = Promise.resolve()
  /** Coalescing: set while a publication is armed to run on an upcoming microtask. */
  private armed = false

  /**
   * @param ctx - Context that carries `domain/changed` emissions.
   * @param spec - The domain declaration.
   * @param unit - The opened backend unit; this instance owns its lifecycle.
   * @param records - Validated records from the unit's `loadAll`, one entry
   * per declared table (empty maps included) — the facility builds it from
   * the spec, so the entry set IS the table set.
   * @param globalValue - Validated stored global, or the spec's `initial`
   * when the medium held none; `undefined` when the spec declares no global.
   * @param onClosed - Facility hook run once after teardown completes; frees
   * the domain name for a later open.
   */
  constructor(
    private readonly ctx: Context,
    spec: DomainSpec,
    private readonly unit: KvUnit,
    records: Map<string, Map<string, unknown>>,
    globalValue: unknown,
    private readonly onClosed: () => void,
  ) {
    this.name = spec.name
    this.coalescing = spec.coalesceWrites === true
    const host: TableHost = {
      domainName: spec.name,
      unit,
      write: job => this.write(job),
      assertReadable: () => { this.assertReadable() },
      emitChanged: (change) => { this.emitChanged(change) },
    }
    for (const [table, tableRecords] of records) {
      this.tables.set(table, new KvTableImpl(host, table, tableRecords))
    }
    if (spec.global !== undefined) {
      this.globalValue = globalValue
      this.globalHandle = {
        get: () => {
          this.assertReadable()
          return this.globalValue
        },
        set: value => this.write({
          table: '',
          key: '',
          current: () => ({ has: true, value: this.globalValue }),
          restore: (state) => { this.globalValue = state.value },
          prepare: () => ({
            value: undefined,
            change: { operation: 'put', value },
            durable: {
              publish: () => this.unit.setGlobal(value),
              commit: () => { this.globalValue = value },
            },
          }),
        }),
      }
    }
  }

  /** Global singleton handle; accessing it on a spec that declares no global is a caller bug and throws. */
  get global(): DomainGlobal<unknown> {
    if (this.globalHandle === undefined) {
      throw new Error(`domain '${this.name}' declares no global`)
    }
    return this.globalHandle
  }

  /**
   * Resolve one declared table handle; an undeclared name is a caller bug
   * and throws.
   * @param name - Declared table name.
   * @returns the stable table handle.
   */
  table(name: string): KvTable<string, unknown> {
    const table = this.tables.get(name)
    if (table === undefined) {
      throw new Error(`domain '${this.name}' declares no table '${name}'`)
    }
    return table
  }

  /**
   * Close this domain: reject new writes immediately, drain already-queued
   * writes (their events still emit), close the unit, then free the name via
   * the facility hook. Idempotent — repeated calls share one teardown.
   * @returns resolution after the unit is released.
   */
  close(): Promise<void> {
    this.disposal ??= this.runClose()
    return this.disposal
  }

  private async runClose(): Promise<void> {
    this.disposing = true
    // New writes reject from here on; the barrier still settles everything
    // queued and staged before close began, then the unit is released.
    await this.flush()
    await this.unit.close()
    this.closed = true
    this.onClosed()
  }

  /**
   * Settle every queued and staged write. On a domain without coalescing this
   * is the chain-drain barrier the close path and callers already relied on;
   * on a coalescing domain it also publishes the staged batch on demand
   * instead of waiting for the arming microtask.
   * @returns resolution after every write issued before the call settled.
   */
  async flush(): Promise<void> {
    for (;;) {
      // Chain links never reject (each is settled via then(noop, noop)), so
      // this await is a pure barrier over the queued mutations.
      await this.chain
      if (this.batch === undefined || this.batch.length === 0) {
        await this.publishing
        return
      }
      await this.drain()
    }
  }

  /**
   * Queue one write on the chain. The default path publishes at the job and
   * mutates memory only after the backend acknowledged durability; the
   * coalescing path mutates memory at the job and settles the caller when the
   * batch covering it is published.
   * @param job - The queued write.
   * @returns the caller-facing outcome.
   */
  private write<T>(job: WriteJob<T>): Promise<T> {
    if (this.disposing) {
      return Promise.reject(new DomainError('closed', `domain '${this.name}' is closed`))
    }
    return this.coalescing ? this.stage(job) : this.chainWrite(job)
  }

  private chainWrite<T>(job: WriteJob<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const prepared = job.prepare()
      if (prepared.durable !== undefined) {
        await prepared.durable.publish()
        prepared.durable.commit()
        this.emitChanged(this.changeOf(job.table, job.key, prepared.change))
      }
      return prepared.value
    })
    this.chain = result.then(noop, noop)
    return result
  }

  private stage<T>(job: WriteJob<T>): Promise<T> {
    let settle!: (value: T) => void
    let fail!: (error: unknown) => void
    const settled = new Promise<T>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    this.queued += 1
    const applied = this.chain.then(() => {
      try {
        const prepared = job.prepare()
        if (prepared.durable === undefined) {
          // A write that stores nothing never reaches the medium or a batch.
          settle(prepared.value)
          return
        }
        const slot = this.stageSlot(job)
        const durability = prepared.durable
        const value = prepared.value
        // Memory first: the batch publishes the state the writes produced, so
        // a batch is one durable replacement of the slot's final value.
        durability.commit()
        slot.publish = () => durability.publish()
        slot.change = prepared.change
        slot.waiters.push({ settle: () => { settle(value) }, fail })
      } catch (error) {
        fail(error)
      } finally {
        this.queued -= 1
        this.arm()
      }
    })
    this.chain = applied.then(noop, noop)
    return settled
  }

  /** Resolve (or create) the batch slot one staged write touches; `before` is the batch's own baseline. */
  private stageSlot(job: WriteJob<unknown>): StagedSlot {
    const slots = this.batch ??= []
    const existing = slots.find(slot => slot.table === job.table && slot.key === job.key)
    if (existing !== undefined) return existing
    const before = job.current()
    const slot: StagedSlot = {
      table: job.table,
      key: job.key,
      before,
      restore: (state) => { job.restore(state) },
      publish: () => Promise.resolve(),
      change: { operation: 'deleted' },
      waiters: [],
    }
    slots.push(slot)
    return slot
  }

  /**
   * Publish the staged batch once no queued mutation is left to join it: every
   * write that arrived before the arming microtask runs rides the same
   * publication, which is what makes a burst one durable replacement per slot.
   */
  private arm(): void {
    if (this.queued > 0 || this.armed || this.batch === undefined) return
    this.armed = true
    queueMicrotask(() => { void this.drain() })
  }

  /** Serialize one publication behind the previous one. */
  private drain(): Promise<void> {
    const next = this.publishing.then(() => this.publishBatch())
    this.publishing = next.then(noop, noop)
    return next
  }

  private async publishBatch(): Promise<void> {
    this.armed = false
    const slots = this.batch
    this.batch = undefined
    if (slots === undefined || slots.length === 0) return
    // Every slot publishes at once — one backend operation per touched slot,
    // and one whole-unit rewrite per batch on a single-document layout.
    const outcomes = await Promise.allSettled(slots.map(slot => slot.publish()))
    for (const [index, slot] of slots.entries()) {
      const outcome = outcomes[index]
      if (outcome?.status !== 'rejected') continue
      // The publication that covers this slot failed, so none of its staged
      // writes landed: restore the slot to its pre-batch value and reject
      // exactly the callers whose writes it covered.
      slot.restore(slot.before)
      for (const waiter of slot.waiters) waiter.fail(outcome.reason)
    }
    // Events come after every rollback, so a listener always observes memory
    // that agrees with the medium; a rolled-back slot emits nothing.
    for (const [index, slot] of slots.entries()) {
      if (outcomes[index]?.status !== 'fulfilled') continue
      this.emitChanged(this.changeOf(slot.table, slot.key, slot.change))
    }
    for (const [index, slot] of slots.entries()) {
      if (outcomes[index]?.status !== 'fulfilled') continue
      for (const waiter of slot.waiters) waiter.settle()
    }
  }

  private changeOf(table: string, key: string, change: WriteChange): DomainChanged {
    return change.operation === 'put'
      ? { domain: this.name, table, key, operation: 'put', value: change.value }
      : { domain: this.name, table, key, operation: 'deleted' }
  }

  /**
   * Dispatch one post-durability change notification, containing observer
   * failures: the write is already committed (medium and memory both hold
   * the new state), so a throwing listener must not retroactively reject it.
   */
  private emitChanged(change: DomainChanged): void {
    try {
      this.ctx.emit('domain/changed', change)
    } catch (error) {
      // Swallows synchronous observer exceptions only: emit dispatches
      // listeners inline and nothing else runs in the try. The event is a
      // notification, not a transaction participant — the commit point has
      // passed, so containment (with a log) is the only correct outcome.
      this.ctx.logger.warn(`domain '${this.name}': domain/changed listener failed: ${String(error)}`)
    }
  }

  private assertReadable(): void {
    if (this.closed) {
      throw new DomainError('closed', `domain '${this.name}' is closed`)
    }
  }
}

/** Table handle bound to one in-memory record map and its domain's write chain. */
class KvTableImpl<K extends string, V> implements KvTable<K, V> {
  constructor(
    private readonly host: TableHost,
    private readonly tableName: string,
    private readonly records: Map<string, unknown>,
  ) {}

  get(key: K): V | undefined {
    this.host.assertReadable()
    return this.records.get(key) as V | undefined
  }

  entries(): IterableIterator<[K, V]> {
    this.host.assertReadable()
    return ([...this.records.entries()] as [K, V][])[Symbol.iterator]()
  }

  keys(): IterableIterator<K> {
    this.host.assertReadable()
    return ([...this.records.keys()] as K[])[Symbol.iterator]()
  }

  get size(): number {
    this.host.assertReadable()
    return this.records.size
  }

  put(key: K, value: V): Promise<void> {
    return this.host.write<void>({
      table: this.tableName,
      key,
      current: () => this.slotOf(key),
      restore: (state) => { this.restoreSlot(key, state) },
      prepare: () => ({
        value: undefined,
        change: { operation: 'put', value },
        durable: {
          publish: () => this.host.unit.putRecord(this.tableName, key, value),
          commit: () => { this.records.set(key, value) },
        },
      }),
    })
  }

  delete(key: K): Promise<boolean> {
    return this.host.write<boolean>({
      table: this.tableName,
      key,
      current: () => this.slotOf(key),
      restore: (state) => { this.restoreSlot(key, state) },
      // Existence is decided at this job's chain slot, not at call time: an
      // earlier queued put of the same key makes this delete observe it. A
      // delete of an absent key stores nothing, so it carries no durable half
      // and reports no change.
      prepare: () => this.records.has(key)
        ? {
          value: true,
          change: { operation: 'deleted' },
          durable: {
            publish: () => this.host.unit.deleteRecord(this.tableName, key),
            commit: () => { this.records.delete(key) },
          },
        }
        : { value: false, change: { operation: 'deleted' } },
    })
  }

  update(key: K, fn: (current: V) => V): Promise<V> {
    return this.host.write<V>({
      table: this.tableName,
      key,
      current: () => this.slotOf(key),
      restore: (state) => { this.restoreSlot(key, state) },
      prepare: () => {
        if (!this.records.has(key)) {
          throw new DomainError(
            'missing-key',
            `domain '${this.host.domainName}' table '${this.tableName}' has no record '${key}' to update`,
          )
        }
        const next = fn(this.records.get(key) as V)
        return {
          value: next,
          change: { operation: 'put', value: next },
          durable: {
            publish: () => this.host.unit.putRecord(this.tableName, key, next),
            commit: () => { this.records.set(key, next) },
          },
        }
      },
    })
  }

  /** The slot's memory state as a batch needs it to roll back. */
  private slotOf(key: K): SlotState {
    return { has: this.records.has(key), value: this.records.get(key) }
  }

  /** Return one key to a state an earlier batch captured. */
  private restoreSlot(key: K, state: SlotState): void {
    if (state.has) this.records.set(key, state.value)
    else this.records.delete(key)
  }
}
