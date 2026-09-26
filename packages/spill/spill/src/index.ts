/**
 * Service Definitions for two capability seams over one artifact store: storage
 * (`ctx.spillStore`) defines WHAT a backend persists — the caller's text plus a
 * model-facing locator and retrieval guidance — and retrieval (`ctx.artifacts`)
 * defines how a caller reads the SAME artifacts back. Implementations subclass
 * {@link SpillStore} and {@link ArtifactStore} and register as the `spillStore`
 * and `artifacts` services; `@deepseek-ai/dsh-spill-local` (host filesystem)
 * implements both over one root.
 *
 * {@link SpillStore} is deliberately minimal: `saveText` and nothing else. It owns NO
 * retention policy (that is `@deepseek-ai/dsh-output-retention`), NO tool-result
 * replacement (that is `@deepseek-ai/dsh-spill-policy`), and NO retrieval or
 * search API. The backend supplies the locator and retrieval hint appropriate
 * for its storage substrate; {@link ArtifactStore} reads those locators back and
 * never writes.
 *
 * @module @deepseek-ai/dsh-spill
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SaveTextSpill, SpillRef } from './types.ts'

export { ArtifactLocatorError, ArtifactStore } from './artifacts.ts'
export { SpillLocator } from './types.ts'
export type { SaveTextSpill, SpillOwner, SpillRef, SpillSource } from './types.ts'
export type {
  ArtifactDiff, ArtifactExtract, ArtifactLine, ArtifactMatch, ArtifactSummary, ArtifactText,
  DiffArtifacts, ExtractArtifact, ReadArtifact, SearchArtifacts, SummarizeArtifact,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    spillStore: SpillStore
  }
}

/**
 * Abstract spill storage service. Subclass, implement {@link saveText}, and load
 * the subclass as a plugin — it registers as `ctx.spillStore` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior).
 *
 * Semantics every implementation must honor:
 * - {@link saveText} persists the FULL `content` verbatim and returns an opaque
 *   locator, exact byte length, and model-facing retrieval guidance.
 * - Storage is scoped by the request's {@link SaveTextSpill.owner} session; the
 *   backend chooses a private (not world-readable) location and a collision-free
 *   name derived from — never equal to — the caller's `suggestedName`.
 * - `saveText` REJECTS on a real storage failure (permissions, ENOSPC, backend
 *   unavailable); the caller decides how to degrade (the spill policy treats a
 *   rejection as best-effort and keeps the inline result).
 */
export abstract class SpillStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'spillStore')
  }

  /**
   * Persist `input.content` to a session-scoped spill artifact.
   * @param input - the owner, caller-supplied source fields, suggested name, and full text to save.
   * @returns the saved artifact's {@link SpillRef}; rejects on a storage failure.
   */
  abstract saveText(input: SaveTextSpill): Promise<SpillRef>
}

export default SpillStore
