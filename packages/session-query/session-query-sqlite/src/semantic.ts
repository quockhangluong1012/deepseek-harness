/**
 * Vector channel of the derived session index: the candidate query that does
 * not require a full-text match, the vector codec, and the similarity ranking.
 * @module @deepseek-ai/dsh-session-query-sqlite/semantic
 */

/**
 * Candidate documents for a semantic search. It mirrors the columns
 * `selectedDocumentsSql()` produces so hit assembly is shared, but selects
 * on the filters alone: a vector channel ranks the corpus by meaning, so it
 * cannot start from an FTS5 `MATCH` and has no match count or highlight.
 *
 * Binds, in order: whether persisted documents are visible, then the same
 * flag for the live branch's `persisted` column.
 */
export const SEMANTIC_CANDIDATES_SQL = `WITH candidates AS (
  SELECT
    pd.rowid AS doc_rowid,
    pd.session_id AS session_id,
    ps.version AS version,
    ps.created_at AS created_at,
    ps.cwd AS cwd,
    ps.parent_session AS parent_session,
    ps.seed_length AS seed_length,
    ps.delegation_depth AS delegation_depth,
    ps.agent_preset AS agent_preset,
    0 AS live,
    1 AS persisted,
    CAST(pd.seq AS INTEGER) AS seq,
    pd.type AS type,
    CAST(pd.time AS INTEGER) AS time,
    pd.surface AS surface,
    pd.text AS marked_text,
    0 AS match_count,
    CAST(pd.codepoint_length AS INTEGER) AS document_length
  FROM persisted_docs AS pd
  JOIN persisted_sessions AS ps ON ps.id = pd.session_id
  WHERE ? = 1
    AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
  UNION ALL
  SELECT
    ld.rowid AS doc_rowid,
    ld.session_id AS session_id,
    ls.version AS version,
    ls.created_at AS created_at,
    ls.cwd AS cwd,
    ls.parent_session AS parent_session,
    ls.seed_length AS seed_length,
    ls.delegation_depth AS delegation_depth,
    ls.agent_preset AS agent_preset,
    1 AS live,
    CASE WHEN ? = 1 THEN ls.persisted ELSE 0 END AS persisted,
    CAST(ld.seq AS INTEGER) AS seq,
    ld.type AS type,
    CAST(ld.time AS INTEGER) AS time,
    ld.surface AS surface,
    ld.text AS marked_text,
    0 AS match_count,
    CAST(ld.codepoint_length AS INTEGER) AS document_length
  FROM temp.live_docs AS ld
  JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
)`

/** One candidate row plus the index rowid its vector is stored under. */
export interface SemanticRow {
  /** Rowid of the indexed document, and the key its vector is stored under. */
  doc_rowid: number
  /** Indexed document text, used as the embedding input. */
  marked_text: string
  /** Session identity this document belongs to. */
  session_id: string
  /** Whether the document came from the live projection rather than persistence. */
  live: number
  /** Whether the owning session is also present in persistence. */
  persisted: number
}

/** Encode one vector for storage. */
export function encodeVector(vector: readonly number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer)
}

/**
 * Decode one stored vector.
 * @param blob - the stored bytes.
 * @returns the vector, or undefined when the length is not a whole number of float32 values.
 */
export function decodeVector(blob: Uint8Array): readonly number[] | undefined {
  if (blob.byteLength === 0 || blob.byteLength % 4 !== 0) return undefined
  const bytes = Uint8Array.from(blob)
  return [...new Float32Array(bytes.buffer)]
}

/**
 * Cosine similarity between two equal-length vectors.
 * @param left - one vector.
 * @param right - the other, with the same length.
 * @returns similarity in `[-1, 1]`, or 0 when either vector has no magnitude.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0
  let leftSquared = 0
  let rightSquared = 0
  for (let index = 0; index < left.length; index += 1) {
    // Both vectors were checked to have the query's length before ranking.
    const value = left[index] ?? 0
    const other = right[index] ?? 0
    dot += value * other
    leftSquared += value * value
    rightSquared += other * other
  }
  const magnitude = Math.sqrt(leftSquared) * Math.sqrt(rightSquared)
  return magnitude === 0 ? 0 : dot / magnitude
}

/**
 * Order candidate rows by similarity to the query vector. Only rows that have
 * a vector of the query's own length participate: a vector from a different
 * model, or a truncated one, is absent rather than comparable.
 * @param rows - candidate rows in index order.
 * @param query - the query vector.
 * @param vectors - stored or freshly embedded vectors, keyed by index rowid.
 * @returns the participating rows, most similar first.
 */
export function rankBySimilarity<T extends { doc_rowid: number }>(
  rows: readonly T[],
  query: readonly number[],
  vectors: ReadonlyMap<number, readonly number[]>,
): Array<{ row: T; score: number }> {
  const scored: Array<{ row: T; score: number }> = []
  for (const row of rows) {
    const vector = vectors.get(row.doc_rowid)
    if (vector === undefined || vector.length !== query.length) continue
    scored.push({ row, score: cosineSimilarity(query, vector) })
  }
  return scored.sort((left, right) => right.score - left.score || left.row.doc_rowid - right.row.doc_rowid)
}
