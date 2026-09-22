/**
 * Public type vocabulary of the retrieval-aware evolution store: the §39
 * candidate dimensions as one configuration record, the session attributions
 * that ran under it, the graded outcomes joined from the evidence stores, and
 * the derived per-task-class ranking. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-retrieval/src/types
 */

/** Which retrieval lane a configuration serves. */
export type RetrievalSource = 'vector' | 'graph' | 'hybrid'

/** Query-expansion strategy a configuration applies before searching. */
export type QueryExpansion = 'none' | 'graph-entities' | 'synonyms'

/** Reranking strategy a configuration applies to its fused candidates. */
export type Reranker = 'none' | 'cross-encoder'

/** Memory scope a configuration searches. */
export type MemoryScope = 'session' | 'workspace' | 'global'

/** Lane blend weights of one configuration. */
export interface RetrievalWeights {
  /** Weight the vector leg receives. */
  vector: number
  /** Weight the graph leg receives. */
  graph: number
}

/** Maximal-marginal-relevance diversification of one configuration. */
export interface MmrSetting {
  /** Whether the configuration diversifies its result set. */
  enabled: boolean
  /** Relevance-versus-diversity tradeoff in 0..1; 1 is pure relevance. */
  lambda: number
}

/** One retrieval configuration: the §39 candidate dimensions as a record. */
export interface RetrievalConfiguration {
  /** Retrieval source dimension. */
  source: RetrievalSource
  /** Query-expansion dimension. */
  queryExpansion: QueryExpansion
  /** Lane-weight dimension. */
  weights: RetrievalWeights
  /** Reranker dimension. */
  reranker: Reranker
  /** MMR dimension. */
  mmr: MmrSetting
  /** Memory-scope dimension. */
  memoryScope: MemoryScope
  /** Graph-depth dimension: hops the graph leg expands, at least 1. */
  graphDepth: number
  /** Active-memory threshold dimension: minimum similarity a hit must clear, in 0..1. */
  threshold: number
}

/** One task class a configuration is judged on, e.g. a skill name. */
export type RetrievalTaskClass = string

/** One session's graded outcome, as the evidence stores grade it. */
export type SessionOutcome = 'ok' | 'failed'

/** One session's graded outcome on one task class. */
export interface SessionGrade {
  /** Session that was graded. */
  sessionId: string
  /** Task class the grade covers. */
  taskClass: RetrievalTaskClass
  /** Whether the session came out clean on that class. */
  outcome: SessionOutcome
}

/** One recorded attribution: one session ran under one configuration. */
export interface RetrievalAttribution {
  /** Canonical key of the configuration the session ran under. */
  configKey: string
  /** The configuration itself, as it was in force. */
  configuration: RetrievalConfiguration
  /** The session that ran under it. */
  sessionId: string
  /** ISO-8601 instant of the first recording. */
  at: string
}

/** One attribution offered for recording: the session and the configuration in force. */
export interface RetrievalAttributionInput {
  /** The configuration in force for the session. */
  configuration: RetrievalConfiguration
  /** The session that ran under it. */
  sessionId: string
}

/** Derived effectiveness of one configuration on one task class. */
export interface RetrievalEffectiveness {
  /** Canonical key of the configuration. */
  configKey: string
  /** The configuration itself. */
  configuration: RetrievalConfiguration
  /** The task class the sessions were graded on. */
  taskClass: RetrievalTaskClass
  /** Graded sessions attributed to this configuration and class. */
  samples: number
  /** Graded sessions that came out clean. */
  passes: number
  /** Share of graded sessions that came out clean, in 0..1. */
  successRate: number
  /** ISO-8601 instant of the newest attribution behind the row. */
  lastAt: string
}

/** One ranked configuration with the numbers behind its rank. */
export interface RetrievalRankingEntry {
  /** Canonical key of the configuration. */
  configKey: string
  /** The configuration itself. */
  configuration: RetrievalConfiguration
  /** Graded sessions attributed to it on the ranked class. */
  samples: number
  /** Graded sessions that came out clean. */
  passes: number
  /** Share of graded sessions that came out clean, in 0..1. */
  successRate: number
  /** The sample-confidence-adjusted score that ranks the configuration. */
  score: number
  /** Why the configuration ranks here, naming the numbers. */
  reason: string
}

/**
 * One skill's session evidence, as `ctx.evolutionSkillTelemetry` records it:
 * the sessions that loaded the skill and the graded outcome of the ones the
 * curator's trust pass graded.
 */
export interface SkillEvidenceEntry {
  /** Skill name — the task class its sessions served. */
  readonly name: string
  /** The usage record, narrowed to the two session reads this store joins on. */
  readonly usage: {
    /** Sessions that loaded the skill, newest first and deduplicated. */
    readonly sessionIds: readonly string[]
    /** Per-session graded outcomes, newest first and deduplicated by session. */
    readonly sessionOutcomes: readonly SkillSessionOutcome[]
  }
}

/** One session's graded outcome for one skill, as the telemetry store records it. */
export interface SkillSessionOutcome {
  /** The session that loaded the skill. */
  readonly sessionId: string
  /** Whether the session's evidence was clean (`ok`) or attributable (`failed`). */
  readonly outcome: SessionOutcome
}
