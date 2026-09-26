/**
 * `LocalArtifactStore`: the host-filesystem Service Provider for the
 * `@deepseek-ai/dsh-spill` artifact retrieval seam (`ctx.artifacts`). It reads
 * the files `LocalSpillStore.saveText` wrote under the same root — the backend's
 * locators are those paths — and never writes, replaces, or deletes an artifact.
 * The startup cleanup sweep owns artifact lifetime, so a locator that the sweep
 * expired reads as an unknown locator.
 *
 * @module @deepseek-ai/dsh-spill-local/artifacts
 */

import { Context } from '@deepseek-ai/cordis'
import { ArtifactStore, SpillLocator } from '@deepseek-ai/dsh-spill'
import type {
  ArtifactDiff, ArtifactExtract, ArtifactMatch, ArtifactSummary, ArtifactText,
  DiffArtifacts, ExtractArtifact, ReadArtifact, SearchArtifacts, SummarizeArtifact,
} from '@deepseek-ai/dsh-spill'
import {
  ARTIFACT_DIFF_CONTEXT, listStoredArtifacts, projectMatches, readStoredArtifact, readWindow,
  retainWithin, unifiedDiff,
} from './retrieve.ts'

/**
 * Artifact retrieval over one local spill root. Constructed by the
 * `LocalSpillStore` plugin, which passes the root it writes to; registering the
 * service is the constructor's side effect, and the owning fiber's disposal
 * releases `ctx.artifacts` with `ctx.spillStore`.
 */
export class LocalArtifactStore extends ArtifactStore {
  /** Resolved absolute spill root: the same root the writing backend persists into. */
  readonly root: string

  /**
   * @param ctx - the plugin context this service registers in.
   * @param root - the resolved absolute spill root to read.
   */
  constructor(ctx: Context, root: string) {
    super(ctx)
    this.root = root
  }

  async search(request: SearchArtifacts): Promise<ArtifactMatch[]> {
    const found = await listStoredArtifacts(this.root, request.owner.sessionId, request.name)
    const matches = request.limit === undefined ? found : found.slice(0, Math.max(0, request.limit))
    return matches.map(artifact => ({
      locator: SpillLocator(artifact.path),
      name: artifact.name,
      bytes: artifact.bytes,
      savedAt: artifact.savedAt,
    }))
  }

  async read(request: ReadArtifact): Promise<ArtifactText> {
    return readWindow(await readStoredArtifact(this.root, request.locator), request.offset, request.limit)
  }

  async extract(request: ExtractArtifact): Promise<ArtifactExtract> {
    return projectMatches(await readStoredArtifact(this.root, request.locator), request.pattern, request.limit)
  }

  async diff(request: DiffArtifacts): Promise<ArtifactDiff> {
    const [left, right] = await Promise.all([
      readStoredArtifact(this.root, request.left),
      readStoredArtifact(this.root, request.right),
    ])
    return unifiedDiff(left, right, request.context ?? ARTIFACT_DIFF_CONTEXT)
  }

  async summarize(request: SummarizeArtifact): Promise<ArtifactSummary> {
    return retainWithin(await readStoredArtifact(this.root, request.locator), request.maxBytes)
  }
}
