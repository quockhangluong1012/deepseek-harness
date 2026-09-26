/**
 * In-memory filesystem provider for the batch-mutator tests. It records every
 * accepted write with the intent the tool stamped, stores one monotonic version
 * per file, and raises the two guarded-mutation codes `dsh-fs-local` raises, so
 * a spec can assert exactly what a tool published without a real disk.
 */

import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'

/** One stored file: its content plus the version a write advances. */
interface Entry {
  content: string
  version: number
}

/** A write the provider accepted, in call order. */
export interface RecordedWrite {
  targetKey: string
  content: string
  intent: FsWriteIntent | undefined
}

export class FakeFs extends FileSystem {
  /** Stored files by target key. */
  private readonly entries = new Map<string, Entry>()
  /** Every accepted write, in call order. */
  readonly writes: RecordedWrite[] = []

  /** The target key this provider derives from a model-supplied path. */
  keyOf(path: string): string {
    return `key:${path}`
  }

  /**
   * Seed a file, or replace its content as an external change would: either way
   * the stored version advances, so a guard recorded before the call goes stale.
   */
  seed(path: string, content: string): void {
    this.entries.set(this.keyOf(path), { content, version: (this.entries.get(this.keyOf(path))?.version ?? 0) + 1 })
  }

  /** The stored content of one model-supplied path, or undefined when absent. */
  contentOf(path: string): string | undefined {
    return this.entries.get(this.keyOf(path))?.content
  }

  override async resolve(path: string): Promise<FsTarget> {
    return { targetKey: FsTargetKey(this.keyOf(path)), displayPath: `/abs/${path}` }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    return `file://${target.targetKey}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return parent.targetKey === child.targetKey
  }

  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const entry = this.entries.get(target.targetKey)
    return entry === undefined
      ? undefined
      : { version: FsVersion(`v${entry.version}`), type: 'file', size: entry.content.length }
  }

  override async lstat(path: string): Promise<FsPathInfo | undefined> {
    const entry = this.entries.get(this.keyOf(path))
    return entry === undefined
      ? undefined
      : { version: FsVersion(`v${entry.version}`), type: 'file', size: entry.content.length }
  }

  override async readText(target: FsTarget): Promise<string> {
    const entry = this.entries.get(target.targetKey)
    if (entry === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    return entry.content
  }

  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    const content = await this.readText(target)
    return (async function* () { yield content })()
  }

  override async readBytes(target: FsTarget): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readText(target))
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }): Promise<Uint8Array> {
    return (await this.readBytes(target)).subarray(range.offset, range.offset + range.length)
  }

  override async listDir(): Promise<FsDirEntry[]> {
    return []
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    const entry = this.entries.get(target.targetKey)
    if (expected?.kind === 'createIfAbsent' && entry !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion' && expected.version !== FsVersion(`v${entry?.version ?? 0}`)) {
      throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    const version = (entry?.version ?? 0) + 1
    this.writes.push({ targetKey: target.targetKey, content, intent: expected })
    this.entries.set(target.targetKey, { content, version })
    return {
      operation: entry === undefined ? 'create' : 'update',
      version: FsVersion(`v${version}`),
      before: entry?.content ?? null,
      after: content,
    }
  }

  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }): Promise<FsEditOutcome> {
    const entry = this.entries.get(target.targetKey)
    if (entry === undefined) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    if (expected !== undefined && expected.version !== FsVersion(`v${entry.version}`)) {
      throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    const after = edit.replaceAll
      ? entry.content.split(edit.oldString).join(edit.newString)
      : entry.content.replace(edit.oldString, () => edit.newString)
    this.entries.set(target.targetKey, { content: after, version: entry.version + 1 })
    return { version: FsVersion(`v${entry.version + 1}`), before: entry.content, after }
  }
}
