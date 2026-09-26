/**
 * Workspace memory store (`ctx.workspaceMemory`): the durable per-Workspace
 * document, its byte caps, and its capacity accounting over the
 * `workspace_memory` domain.
 *
 * Reads are synchronous from the domain's validated memory. Every cap is
 * checked before the write chain is entered, and a rejected write never
 * mutates the record. Stored objects never leak by reference.
 * @module @deepseek-ai/dsh-workspace-memory
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { digestOf, usedBytesOf, utf8Bytes } from './digest.ts'
import { workspaceMemoryDomainSpec } from './spec.ts'
import type {
  WorkspaceContextItem,
  WorkspaceContextItemInput,
  WorkspaceMemoryExtraction,
  WorkspaceMemoryRecord,
  WorkspaceMemoryUsage,
  WorkspaceOutput,
} from './types.ts'

export type {
  WorkspaceContextItem,
  WorkspaceContextItemInput,
  WorkspaceMemoryExtraction,
  WorkspaceMemoryRecord,
  WorkspaceMemoryUsage,
  WorkspaceOutput,
} from './types.ts'
export { workspaceMemoryDomainSpec } from './spec.ts'
export { digestOf, usedBytesOf, EMPTY_DIGEST } from './digest.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable per-Workspace memory record owner. */
    workspaceMemory: WorkspaceMemoryStore
  }
}

/** Deployment-chosen caps for stored workspace memory. */
export interface Config {
  /** Capacity-bar denominator and hard ceiling on stored bytes. */
  capacityBytes: number
  /** Description cap in UTF-8 bytes. */
  maxDescriptionBytes?: number
  /** Instructions cap in UTF-8 bytes. */
  maxInstructionsBytes?: number
  /** Memory document cap in UTF-8 bytes. */
  maxMemoryBytes?: number
  /** Per-item cap in UTF-8 bytes, and ceiling on a file item's observed size. */
  maxContextItemBytes?: number
  /** Item count cap. */
  maxContextItems?: number
  /** Produced-file index size. */
  maxOutputs?: number
}

/** Validated deployment choices; `capacityBytes` is required. */
export const Config: z<Config> = z.object({
  capacityBytes: z.number().step(1).min(1).required(),
  maxDescriptionBytes: z.number().step(1).min(1).default(4096),
  maxInstructionsBytes: z.number().step(1).min(1).default(65536),
  maxMemoryBytes: z.number().step(1).min(1).default(65536),
  maxContextItemBytes: z.number().step(1).min(1).default(262144),
  maxContextItems: z.number().step(1).min(1).default(50),
  maxOutputs: z.number().step(1).min(1).default(200),
})

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  capacityBytes: number
  maxDescriptionBytes: number
  maxInstructionsBytes: number
  maxMemoryBytes: number
  maxContextItemBytes: number
  maxContextItems: number
  maxOutputs: number
}

/**
 * Resolve defaults for optional caps.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    capacityBytes: config.capacityBytes,
    maxDescriptionBytes: config.maxDescriptionBytes ?? 4096,
    maxInstructionsBytes: config.maxInstructionsBytes ?? 65536,
    maxMemoryBytes: config.maxMemoryBytes ?? 65536,
    maxContextItemBytes: config.maxContextItemBytes ?? 262144,
    maxContextItems: config.maxContextItems ?? 50,
    maxOutputs: config.maxOutputs ?? 200,
  }
}

function freshRecord(): Omit<WorkspaceMemoryRecord, 'updatedAt'> & { updatedAt?: string } {
  return {
    description: '',
    instructions: '',
    memory: '',
    memoryUpdatedAt: null,
    contextItems: [],
    outputs: [],
    lastExtraction: null,
  }
}

function tooLarge(field: string, bytes: number, maxBytes: number): RemoteError<'workspace-memory/too-large'> {
  return new RemoteError(
    'workspace-memory/too-large',
    `workspace memory field '${field}' is ${bytes} bytes, exceeding the ${maxBytes} byte cap`,
    { field, bytes, maxBytes },
  )
}

function capacityExceeded(usedBytes: number, capacityBytes: number): RemoteError<'workspace-memory/capacity-exceeded'> {
  return new RemoteError(
    'workspace-memory/capacity-exceeded',
    `workspace memory write would use ${usedBytes} of ${capacityBytes} bytes`,
    { usedBytes, capacityBytes },
  )
}

/**
 * Durable per-Workspace memory store. Opens the `workspace_memory` domain at
 * init and closes it through `ctx.effect`.
 */
export class WorkspaceMemoryStore extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<WorkspaceId, WorkspaceMemoryRecord>
  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - Host context carrying the storage domain.
   * @param config - capacity and per-field caps from the composition.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'workspaceMemory')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspaceMemoryDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace-memory.domainClose')
    this.table = domain.table('records')
  }

  /**
   * Read one Workspace's record.
   * @param id - Workspace identity.
   * @returns a detached copy, or undefined when absent.
   */
  read(id: WorkspaceId): WorkspaceMemoryRecord | undefined {
    const found = this.requireTable().get(id)
    return found === undefined ? undefined : structuredClone(found)
  }

  /**
   * Capacity accounting for one Workspace.
   * @param id - Workspace identity.
   * @returns charged bytes and the configured ceiling.
   */
  usage(id: WorkspaceId): WorkspaceMemoryUsage {
    return { usedBytes: usedBytesOf(this.requireTable().get(id)), capacityBytes: this.resolved.capacityBytes }
  }

  /**
   * Digest of the brief's inputs for one Workspace.
   * @param id - Workspace identity.
   * @returns `'empty'` when absent, else the sha1 of the covered inputs.
   */
  digest(id: WorkspaceId): string {
    return digestOf(this.requireTable().get(id))
  }

  /**
   * Replace the page blurb. Never reaches a model request.
   * @param id - Workspace identity.
   * @param description - new blurb.
   * @returns the stored record.
   */
  async setDescription(id: WorkspaceId, description: string): Promise<WorkspaceMemoryRecord> {
    const bytes = utf8Bytes(description)
    if (bytes > this.resolved.maxDescriptionBytes) throw tooLarge('description', bytes, this.resolved.maxDescriptionBytes)
    return this.write(id, current => ({ ...current, description }))
  }

  /**
   * Replace the instruction text.
   * @param id - Workspace identity.
   * @param instructions - new rules.
   * @returns the stored record.
   */
  async setInstructions(id: WorkspaceId, instructions: string): Promise<WorkspaceMemoryRecord> {
    const bytes = utf8Bytes(instructions)
    if (bytes > this.resolved.maxInstructionsBytes) throw tooLarge('instructions', bytes, this.resolved.maxInstructionsBytes)
    const current = this.requireTable().get(id)
    const priorItems = current === undefined
      ? 0
      : current.contextItems.reduce((sum, item) => sum + item.sizeBytes, 0)
    const nextUsed = bytes + utf8Bytes(current?.memory ?? '') + priorItems
    if (nextUsed > this.resolved.capacityBytes) throw capacityExceeded(nextUsed, this.resolved.capacityBytes)
    return this.write(id, record => ({ ...record, instructions }))
  }

  /**
   * Replace the memory document by hand or from extraction.
   * @param id - Workspace identity.
   * @param memory - replacement document.
   * @param extraction - the extraction record when model-written.
   * @returns the stored record.
   */
  async setMemory(id: WorkspaceId, memory: string, extraction?: WorkspaceMemoryExtraction): Promise<WorkspaceMemoryRecord> {
    const bytes = utf8Bytes(memory)
    if (bytes > this.resolved.maxMemoryBytes) throw tooLarge('memory', bytes, this.resolved.maxMemoryBytes)
    const current = this.requireTable().get(id)
    const priorItems = current === undefined
      ? 0
      : current.contextItems.reduce((sum, item) => sum + item.sizeBytes, 0)
    const nextUsed = utf8Bytes(current?.instructions ?? '') + bytes + priorItems
    if (nextUsed > this.resolved.capacityBytes) throw capacityExceeded(nextUsed, this.resolved.capacityBytes)
    const now = new Date().toISOString()
    return this.write(id, record => ({
      ...record,
      memory,
      memoryUpdatedAt: now,
      ...extraction === undefined ? {} : { lastExtraction: structuredClone(extraction) },
    }))
  }

  /**
   * Attach pasted text or a workspace file.
   * @param id - Workspace identity.
   * @param input - label plus text or path with its observed size.
   * @returns the stored record.
   */
  async addContextItem(id: WorkspaceId, input: WorkspaceContextItemInput): Promise<WorkspaceMemoryRecord> {
    const sizeBytes = input.kind === 'text' ? utf8Bytes(input.text) : input.sizeBytes
    if (sizeBytes > this.resolved.maxContextItemBytes) {
      throw tooLarge('contextItem', sizeBytes, this.resolved.maxContextItemBytes)
    }
    const current = this.requireTable().get(id)
    const items = current?.contextItems ?? []
    if (items.length + 1 > this.resolved.maxContextItems) {
      throw capacityExceeded(usedBytesOf(current) + sizeBytes, this.resolved.capacityBytes)
    }
    const nextUsed = usedBytesOf(current) + sizeBytes
    if (nextUsed > this.resolved.capacityBytes) throw capacityExceeded(nextUsed, this.resolved.capacityBytes)
    const now = new Date().toISOString()
    const item: WorkspaceContextItem = input.kind === 'text'
      ? { kind: 'text', id: randomUUID(), label: input.label, text: input.text, sizeBytes, addedAt: now }
      : { kind: 'file', id: randomUUID(), label: input.label, path: input.path, sizeBytes, addedAt: now }
    return this.write(id, record => ({ ...record, contextItems: [...record.contextItems, item] }))
  }

  /**
   * Detach one context item.
   * @param id - Workspace identity.
   * @param itemId - context item identity.
   * @returns the stored record.
   */
  async removeContextItem(id: WorkspaceId, itemId: string): Promise<WorkspaceMemoryRecord> {
    const current = this.requireTable().get(id)
    if (current === undefined || !current.contextItems.some(item => item.id === itemId)) {
      throw new RemoteError('workspace-memory/item-not-found', `no context item '${itemId}'`, { itemId })
    }
    return this.write(id, record => ({ ...record, contextItems: record.contextItems.filter(item => item.id !== itemId) }))
  }

  /**
   * Index produced files newest-first, collapsing repeats onto the newer
   * `at` and truncating to `maxOutputs`. Resolves without writing when the
   * resulting list is unchanged.
   * @param id - Workspace identity.
   * @param entries - output entries with path, tool, session, and instant.
   * @returns resolution after durability, or immediately when unchanged.
   */
  async recordOutputs(id: WorkspaceId, entries: readonly WorkspaceOutput[]): Promise<void> {
    if (entries.length === 0) return
    const table = this.requireTable()
    const current = table.get(id)
    if (current === undefined) {
      const now = new Date().toISOString()
      const seen = new Map<string, WorkspaceOutput>()
      for (const entry of entries) {
        const prior = seen.get(entry.path)
        if (prior === undefined || entry.at > prior.at) seen.set(entry.path, { ...entry })
      }
      const outputs = [...seen.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, this.resolved.maxOutputs)
      await table.put(id, {
        ...freshRecord() as WorkspaceMemoryRecord,
        outputs,
        updatedAt: now,
      })
      return
    }
    const merged = new Map<string, WorkspaceOutput>()
    for (const output of current.outputs) merged.set(output.path, output)
    for (const entry of entries) {
      const prior = merged.get(entry.path)
      if (prior === undefined || entry.at > prior.at) merged.set(entry.path, { ...entry })
      else if (entry.at === prior.at && (entry.tool !== prior.tool || entry.sessionId !== prior.sessionId)) {
        merged.set(entry.path, { ...entry })
      }
    }
    const outputs = [...merged.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, this.resolved.maxOutputs)
    if (sameOutputs(current.outputs, outputs)) return
    await table.update(id, record => ({ ...record, outputs, updatedAt: new Date().toISOString() }))
  }

  private async write(id: WorkspaceId, fn: (current: WorkspaceMemoryRecord) => WorkspaceMemoryRecord): Promise<WorkspaceMemoryRecord> {
    const table = this.requireTable()
    const current = table.get(id)
    if (current === undefined) {
      const now = new Date().toISOString()
      const seeded: WorkspaceMemoryRecord = { ...(freshRecord() as WorkspaceMemoryRecord), updatedAt: now }
      const next: WorkspaceMemoryRecord = { ...fn(seeded), updatedAt: now }
      await table.put(id, structuredClone(next))
      return structuredClone(next)
    }
    const next = await table.update(id, (record) => {
      const candidate = fn(record)
      return { ...candidate, updatedAt: new Date().toISOString() }
    })
    return structuredClone(next)
  }

  private requireTable(): KvTable<WorkspaceId, WorkspaceMemoryRecord> {
    if (this.table === undefined) throw new Error('workspace memory store is not started yet')
    return this.table
  }
}

function sameOutputs(left: readonly WorkspaceOutput[], right: readonly WorkspaceOutput[]): boolean {
  if (left.length !== right.length) return false
  return left.every((entry, index) => {
    const other = right[index] as WorkspaceOutput
    return entry.path === other.path && entry.tool === other.tool && entry.sessionId === other.sessionId && entry.at === other.at
  })
}

export default WorkspaceMemoryStore

export type { SessionId }
