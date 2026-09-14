/**
 * Relevance-bounded selection of one scope's current lesson artifacts for a
 * single extraction call: the artifacts worth showing the model this turn,
 * ranked by cosine similarity against the turn's text through the optional
 * `ctx.embeddings` seam, or by recency when that seam is absent or fails.
 *
 * Ranking never fails an extraction. A missing, foreign, or throwing
 * embeddings service degrades to the recency ranking — a less relevant window,
 * never a lost turn — and logs the degradation instead of propagating.
 * @module @deepseek-ai/dsh-evolution-reviewer/relevance
 */

import type { Context } from '@deepseek-ai/cordis'
import { cosineSimilarity } from '@deepseek-ai/dsh-evolution-memory'
import type { LessonArtifact } from '@deepseek-ai/dsh-evolution-memory'

/**
 * The slice of `ctx.embeddings` this module calls. It is declared here rather
 * than imported so the reviewer keeps no dependency on an embeddings package:
 * the seam is optional, and recency ranking must work with nothing mounted.
 * Mirrors the seam `evolution-memory` measures merge candidates through.
 */
interface EmbeddingsSeam {
  /** Embed one batch of texts, one vector per text in request order. */
  embed(request: { texts: readonly string[] }): Promise<{ vectors: readonly (readonly number[])[] }>
}

/**
 * Whether a context value offers the embeddings seam this module calls. An
 * absent or foreign value answers false instead of throwing, and `Object`
 * keeps the check total for nullish and primitive values.
 * @param value - the value read from `ctx.get('embeddings')`.
 * @returns whether the value can embed a batch.
 */
function isEmbeddingsSeam(value: unknown): value is EmbeddingsSeam {
  return typeof Reflect.get(Object(value), 'embed') === 'function'
}

/**
 * Rank artifacts most-recently-updated first. This is the no-embeddings
 * fallback: a recently confirmed or edited fact is the cheapest available
 * proxy for relevance, and it needs nothing mounted.
 * @param artifacts - the scope's current artifacts.
 * @param limit - most artifacts to return.
 * @returns up to `limit` artifacts, newest `updatedAt` first.
 */
export function rankByRecency(artifacts: readonly LessonArtifact[], limit: number): LessonArtifact[] {
  return [...artifacts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit)
}

/**
 * Rank artifacts by descending cosine similarity against the query vector.
 * An artifact with no vector in `vectors` keeps its input position after every
 * scored artifact rather than being dropped, so a partial embeddings failure
 * degrades to ranking fewer facts instead of hiding the rest.
 * @param query - the turn's query vector.
 * @param artifacts - the scope's current artifacts, in fallback order.
 * @param vectors - artifact id to embedded vector, as the batch answered it.
 * @param limit - most artifacts to return.
 * @returns up to `limit` artifacts, closest first, then the unscored ones.
 */
export function rankBySimilarity(
  query: readonly number[],
  artifacts: readonly LessonArtifact[],
  vectors: ReadonlyMap<string, readonly number[]>,
  limit: number,
): LessonArtifact[] {
  const scored: { artifact: LessonArtifact; score: number }[] = []
  const unscored: LessonArtifact[] = []
  for (const artifact of artifacts) {
    const vector = vectors.get(artifact.id)
    if (vector === undefined) unscored.push(artifact)
    else scored.push({ artifact, score: cosineSimilarity(query, vector) })
  }
  scored.sort((left, right) => right.score - left.score)
  return [...scored.map(entry => entry.artifact), ...unscored].slice(0, limit)
}

/**
 * Select the artifacts one extraction call shows the model: the most relevant
 * `limit` of the scope's current artifacts for this turn's text.
 *
 * With an embeddings service mounted, the turn text and every artifact
 * statement are embedded in one batch and ranked by similarity. Without one,
 * when the batch throws, or when it answers without a query vector, the
 * selection falls back to recency: extraction is never failed by ranking.
 * @param ctx - context carrying the optional embeddings service.
 * @param artifacts - the scope's current artifacts.
 * @param queryText - the turn text to rank against.
 * @param limit - most artifacts to return.
 * @returns up to `limit` artifacts, most relevant first.
 */
export async function selectRelevantArtifacts(
  ctx: Context,
  artifacts: readonly LessonArtifact[],
  queryText: string,
  limit: number,
): Promise<LessonArtifact[]> {
  const raw: unknown = ctx.get('embeddings')
  if (!isEmbeddingsSeam(raw) || artifacts.length === 0) return rankByRecency(artifacts, limit)
  try {
    const result = await raw.embed({ texts: [queryText, ...artifacts.map(artifact => artifact.statement)] })
    const query = result.vectors[0]
    if (query === undefined) return rankByRecency(artifacts, limit)
    const vectors = new Map<string, readonly number[]>()
    for (const [index, artifact] of artifacts.entries()) {
      const vector = result.vectors[index + 1]
      if (vector !== undefined) vectors.set(artifact.id, vector)
    }
    return rankBySimilarity(query, artifacts, vectors, limit)
  } catch (error) {
    ctx.logger.warn(`evolution review relevance ranking failed: ${String(error)}`)
    return rankByRecency(artifacts, limit)
  }
}
