/**
 * Tests for the artifact retrieval Service Definition: a concrete subclass
 * registers as `ctx.artifacts` behind the typed module augmentation, a second
 * load throws (duplicate service), and disposal of the owning fiber releases the
 * service. The retrieval behavior is the implementation's concern
 * (`@deepseek-ai/dsh-spill-local`); here we only pin the seam contract.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ArtifactLocatorError, ArtifactStore, SpillLocator } from '@deepseek-ai/dsh-spill'
import type {
  ArtifactDiff, ArtifactExtract, ArtifactMatch, ArtifactSummary, ArtifactText,
  DiffArtifacts, ExtractArtifact, ReadArtifact, SearchArtifacts, SummarizeArtifact,
} from '@deepseek-ai/dsh-spill'

/** Minimal concrete provider: empty search, no readable artifact. */
class StubArtifacts extends ArtifactStore {
  async search(_request: SearchArtifacts): Promise<ArtifactMatch[]> {
    return []
  }

  async read(request: ReadArtifact): Promise<ArtifactText> {
    throw new ArtifactLocatorError(request.locator, 'is unknown to the stub')
  }

  async extract(request: ExtractArtifact): Promise<ArtifactExtract> {
    throw new ArtifactLocatorError(request.locator, 'is unknown to the stub')
  }

  async diff(request: DiffArtifacts): Promise<ArtifactDiff> {
    throw new ArtifactLocatorError(request.left, 'is unknown to the stub')
  }

  async summarize(request: SummarizeArtifact): Promise<ArtifactSummary> {
    throw new ArtifactLocatorError(request.locator, 'is unknown to the stub')
  }
}

describe('artifact retrieval seam', () => {
  it('registers as ctx.artifacts with the seam interface', async () => {
    const ctx = new Context()
    await ctx.plugin(StubArtifacts)
    const store: ArtifactStore = ctx.artifacts
    expect(store).toBeInstanceOf(StubArtifacts)
    await expect(store.read({ locator: SpillLocator('stub://nothing') })).rejects.toThrow(ArtifactLocatorError)
  })

  it('rejects a second implementation (one per context)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubArtifacts)
    await expect(ctx.plugin(StubArtifacts)).rejects.toThrow()
  })

  it('releases the service when the owning fiber is disposed', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubArtifacts)
    expect(ctx.artifacts).toBeInstanceOf(StubArtifacts)
    await fiber.dispose()
    expect((ctx as Context & { artifacts?: unknown }).artifacts).toBeUndefined()
  })
})
