/**
 * Service Definition for artifact retrieval (`ctx.artifacts`): a read-only view
 * over the artifacts a `SpillStore` backend stored, exposing the five
 * operations named by the evolution specification's artifact APIs — search,
 * read, extract, diff, and summarize. Implementations subclass
 * {@link ArtifactStore} and register as the `artifacts` service;
 * `@deepseek-ai/dsh-spill-local` reads the same files its `saveText` wrote.
 *
 * The seam owns NO storage: a retrieval never writes, replaces, exports, or
 * deletes an artifact, and locators stay the opaque handles `saveText` returned.
 * It also owns no model-facing preview policy: `@deepseek-ai/dsh-spill-policy`
 * still decides what a model sees of an oversized result, and a retrieval
 * recovers the complete artifact behind its notice.
 *
 * @module @deepseek-ai/dsh-spill/artifacts
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ArtifactDiff, ArtifactExtract, ArtifactMatch, ArtifactSummary, ArtifactText,
  DiffArtifacts, ExtractArtifact, ReadArtifact, SearchArtifacts, SummarizeArtifact,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    artifacts: ArtifactStore
  }
}

/**
 * A locator the backend did not store: another backend's handle, an unknown
 * name, or an entry that is not a stored artifact. Callers catch it to tell a
 * request that names nothing from a storage read that failed.
 */
export class ArtifactLocatorError extends Error {
  /**
   * @param locator - the rejected locator string.
   * @param reason - why the backend refused it.
   */
  constructor(locator: string, reason: string) {
    super(`artifact locator ${JSON.stringify(locator)} ${reason}`)
    this.name = 'ArtifactLocatorError'
  }
}

/**
 * Abstract artifact retrieval service over the artifacts of one
 * `SpillStore` backend. Subclass, implement every operation, and load the
 * subclass as a plugin — it registers as `ctx.artifacts` (one implementation per
 * context; loading a second throws, cordis' standard duplicate-service
 * behavior).
 *
 * Semantics every implementation must honor:
 * - Retrieval is READ-ONLY. No operation writes, replaces, exports, or deletes
 *   an artifact, and none changes what a model request contains; the writing
 *   seam is `SpillStore`, and model-facing preview policy stays in
 *   `@deepseek-ai/dsh-spill-policy`.
 * - {@link read}, {@link extract}, {@link diff}, and {@link summarize} accept
 *   only locators this backend stored. Another backend's locator, an unknown
 *   name, or a non-artifact entry REJECTS with {@link ArtifactLocatorError}
 *   rather than reading an arbitrary file.
 * - Search is scoped to the request's {@link SearchArtifacts.owner} session,
 *   like storage, and never reaches another session's artifacts.
 * - {@link summarize} retains the artifact's head and tail under the request's
 *   byte budget with the same byte-oriented retention the spill policy
 *   composes, so its exact `omittedBytes` is what the shipped notice formatter
 *   consumes.
 */
export abstract class ArtifactStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'artifacts')
  }

  /**
   * List artifacts of the owner session, newest first, filtered by the request's
   * criteria. A session with no stored artifact returns an empty list.
   * @param request - the owner session scope, optional stored-name substring, and match limit.
   * @returns the matching artifacts, newest first; empty when none match.
   */
  abstract search(request: SearchArtifacts): Promise<ArtifactMatch[]>

  /**
   * Read one line window of a stored artifact, defaulting to all of it.
   * @param request - the artifact locator and the optional 1-based line window.
   * @returns the window text and both the window's and the artifact's sizes.
   */
  abstract read(request: ReadArtifact): Promise<ArtifactText>

  /**
   * Project the artifact lines matching a regular expression, in artifact order.
   * @param request - the artifact locator, the pattern source, and the optional match limit.
   * @returns the matching lines with their line numbers and the complete match count.
   */
  abstract extract(request: ExtractArtifact): Promise<ArtifactExtract>

  /**
   * Compare two stored artifacts line by line.
   * @param request - the two artifact locators and the optional unchanged-line context.
   * @returns the unified patch and the added/deleted line counts.
   */
  abstract diff(request: DiffArtifacts): Promise<ArtifactDiff>

  /**
   * Retain an artifact's head and tail under a byte budget.
   * @param request - the artifact locator and the maximum returned UTF-8 bytes.
   * @returns the retained ends and the exact omitted byte count.
   */
  abstract summarize(request: SummarizeArtifact): Promise<ArtifactSummary>
}
