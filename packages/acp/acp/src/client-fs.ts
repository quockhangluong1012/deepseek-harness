/**
 * The ACP client's text filesystem as a `ctx.fs` provider: a read or
 * unconditional write whose target lies in exactly one routed ACP session's
 * workspace goes through `fs/read_text_file` / `fs/write_text_file` and
 * therefore observes the client's own view of the file, including unsaved
 * editor state.
 *
 * The provider extends the local backend so every operation ACP does not
 * define — listing, metadata, byte reads, guarded writes, literal edits, and
 * any target outside a routed workspace — keeps the local behavior the
 * composition selected. ACP defines no not-found error, so a failed prior read
 * delegates as a create with no diff basis, and no version token the client
 * reported: the returned version is the written content's digest.
 *
 * @module @deepseek-ai/dsh-acp/client-fs
 */

import { createHash } from 'node:crypto'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

/** LF normalization of the contextual-diff basis the seam documents. */
function storageText(content: string): string {
  return content.replace(/\r\n/g, '\n')
}

/**
 * Registers as `ctx.fs` and delegates the two text operations ACP defines when
 * the connected client advertises them for a routable target; other calls keep
 * the inherited local backend.
 */
export default class AcpClientFileSystem extends LocalFileSystem {
  static inject = ['acpClient']

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    if (!this.ctx.acpClient.clientCapabilities.readTextFile) return super.readText(target, signal)
    const route = this.route(target)
    if (route === undefined) return super.readText(target, signal)
    return this.readThroughClient(target, route.sessionId, route.path)
  }

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (!this.ctx.acpClient.clientCapabilities.readTextFile) return super.streamText(target, signal)
    const route = this.route(target)
    if (route === undefined) return super.streamText(target, signal)
    return Promise.resolve(this.streamThroughClient(target, route.sessionId, route.path))
  }

  /**
   * Write one target, delegating to the client when it can carry the whole
   * contract.
   *
   * @param target - the resolved target to write.
   * @param content - the complete content to store.
   * @param expected - a version or absence guard; the ACP surface carries no
   *   version token, so a guarded write stays with the inherited backend.
   * @param signal - aborts before the delegated write is sent.
   * @param _sandboxPolicy - part of the `ctx.fs` contract but never forwarded:
   *   the client writes in its own environment, and the inherited local backend
   *   ignores the policy as well.
   * @returns the outcome, reporting a create or update from the prior read.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const capabilities = this.ctx.acpClient.clientCapabilities
    // A guarded write needs the version token the ACP surface cannot carry,
    // and the outcome contract needs a prior-content basis; without both text
    // methods the local backend keeps that contract.
    if (!capabilities.readTextFile || !capabilities.writeTextFile) {
      return super.writeText(target, content, expected, signal)
    }
    const route = this.route(target)
    if (route === undefined || expected !== undefined) {
      return super.writeText(target, content, expected, signal)
    }
    let before: string | null = null
    try {
      before = storageText((await this.ctx.acpClient.readTextFile({
        sessionId: route.sessionId,
        path: route.path,
      })).content)
    } catch {
      // ACP carries no not-found code, so an unreadable prior file is treated
      // as absent: the write proceeds and the outcome reports a create.
    }
    try {
      await this.ctx.acpClient.writeTextFile({ sessionId: route.sessionId, path: route.path, content })
    } catch (error: unknown) {
      throw new FsError(
        `cannot write "${target.displayPath}" through the ACP client: ${String(error)}`,
        'FS_IO_ERROR',
        { cause: error },
      )
    }
    return {
      operation: before === null ? 'create' : 'update',
      version: FsVersion(`acp:${createHash('sha256').update(content, 'utf8').digest('hex')}`),
      before,
      after: storageText(content),
    }
  }

  /** The ACP session and absolute path for one target, when it routes uniquely. */
  private route(target: FsTarget): { sessionId: SessionId; path: string } | undefined {
    const path = this.processPath(target)
    const sessionId = this.ctx.acpClient.sessionForPath(path)
    return sessionId === undefined ? undefined : { sessionId, path }
  }

  /** Read one target through the client, mapping every client failure to the seam's code. */
  private async readThroughClient(target: FsTarget, sessionId: SessionId, path: string): Promise<string> {
    try {
      return (await this.ctx.acpClient.readTextFile({ sessionId, path })).content
    } catch (error: unknown) {
      throw new FsError(
        `cannot read "${target.displayPath}" through the ACP client: ${String(error)}`,
        'FS_IO_ERROR',
        { cause: error },
      )
    }
  }

  /** Read one target through the client as the seam's single-chunk stream; the read follows iteration. */
  private async *streamThroughClient(target: FsTarget, sessionId: SessionId, path: string): AsyncGenerator<string> {
    yield await this.readThroughClient(target, sessionId, path)
  }
}
