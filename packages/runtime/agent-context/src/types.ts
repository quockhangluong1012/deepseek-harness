/**
 * Context-compiler contracts: the source envelope one prompt contribution or
 * durable task fact is wrapped in, the budgeted result of one compile, and the
 * log-only `context/compiled` session event.
 *
 * `dsh-agent-kernel` owns the task contract this compiler reads and the
 * `TrustLabel`/`Provenance` vocabulary its envelopes carry; `core/system-prompt`
 * keeps ownership of the contributions the compiler is a facade over. This
 * module declares contracts only.
 *
 * @module @deepseek-ai/dsh-agent-context/types
 */

import type { Provenance, TrustLabel } from '@deepseek-ai/dsh-agent-kernel'

/** What a context source is for. Closed vocabulary, fixed by the runtime specification. */
export type ContextSourceKind =
  | 'policy'
  | 'task'
  | 'plan'
  | 'memory'
  | 'evidence'
  | 'artifact'
  | 'history'
  | 'tool'

/**
 * Whether a source may be dropped to fit a budget. `required` sources carry the
 * task's own authority — its objective, its acceptance criteria, the permission
 * that applies to it, its active plan, its evidence references, and its
 * unresolved failures — and are placed even when they alone exceed the ceiling.
 */
export type RetentionClass = 'required' | 'compressible'

/** Why one source was left out of a compiled context. */
export type OmissionReason = 'budget' | 'duplicate'

/**
 * One contribution the compiler may place: either a section or runtime context
 * that `core/system-prompt` assembled, or a durable task fact read from the
 * kernel's view of the session log.
 */
export interface ContextSource {
  /**
   * Stable key, unique within one compile. An assembled contribution keeps its
   * registered name (`tool:read`, `sandbox:policy`); a durable fact uses a
   * derived key (`task:acceptance:build`, `plan:2`, `failure:<id>`).
   */
  readonly id: string
  /** What the source is for. */
  readonly kind: ContextSourceKind
  /** The exact text the source contributes; never empty. */
  readonly content: string
  /** Whether the content is instruction authority or data. */
  readonly trust: TrustLabel
  /** Where the content came from. */
  readonly provenance: Provenance
  /** Whether the content may be dropped to fit a budget. */
  readonly retention: RetentionClass
  /**
   * The claim the source makes, when it makes one. Two placed `required`
   * sources that declare the same subject and disagree are reported as a
   * conflict.
   */
  readonly subject?: string
}

/** One source a compile placed, priced and ranked. */
export interface CompiledSource {
  /** The placed envelope. */
  readonly source: ContextSource
  /** Lexical overlap with the task objective in [0,1]; higher is more relevant. */
  readonly relevance: number
  /** Fixed-heuristic token price of the source's content. */
  readonly tokens: number
}

/** One source a compile left out. */
export interface ContextOmission {
  /** The omitted source's id. */
  readonly id: string
  /** Why it was left out. */
  readonly reason: OmissionReason
}

/** One retained disagreement between two placed required sources. */
export interface ContextConflict {
  /** The claim both sources make. */
  readonly subject: string
  /** The disagreeing sources' ids, in compiled order. */
  readonly sources: readonly string[]
}

/** What one compile produced. */
export interface CompiledContext {
  /** The placed sources, in placement order. */
  readonly included: readonly CompiledSource[]
  /** The sources the compile left out, in considered order. */
  readonly omitted: readonly ContextOmission[]
  /** Disagreements among the placed required sources, in subject order. */
  readonly conflicts: readonly ContextConflict[]
  /** Sum of the placed sources' token prices. */
  readonly tokenEstimate: number
  /** Digest of the whole placement: the identity a replay must reproduce. */
  readonly digest: string
  /** The compiler version that produced this placement. */
  readonly compilerVersion: string
}

/** One placed source as recorded durably, without its model-facing content. */
export interface ContextCompilationEntry {
  /** The placed source's id. */
  readonly id: string
  /** What the source is for. */
  readonly kind: ContextSourceKind
  /** Whether the content was instruction authority or data. */
  readonly trust: TrustLabel
  /** Whether the source could have been dropped. */
  readonly retention: RetentionClass
  /** The source's token price. */
  readonly tokens: number
  /** The source's lexical overlap with the objective. */
  readonly relevance: number
}

/**
 * The durable record of one compile. The session log already carries the
 * prompt text a placement was derived from, so this record holds the identity
 * a replay must reproduce rather than a copy of that text.
 */
export interface ContextCompilationRecord {
  /** Digest of the placement. */
  readonly digest: string
  /** The compiler version that produced the placement. */
  readonly compilerVersion: string
  /** The ceiling the placement was fitted to, or null when unbounded. */
  readonly maxTokens: number | null
  /** Sum of the placed sources' token prices. */
  readonly tokenEstimate: number
  /** The placed sources, in placement order. */
  readonly included: readonly ContextCompilationEntry[]
  /** The sources the compile left out. */
  readonly omitted: readonly ContextOmission[]
  /** Disagreements among the placed required sources. */
  readonly conflicts: readonly ContextConflict[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One compiled context, written once per model-step assembly that names an
     * agent. It holds the placement digest, the placed and omitted source ids,
     * and any retained conflict; the prompt text itself stays on the
     * `system/message` surface. Log-only: it never enters model context.
     */
    'context/compiled': ContextCompilationRecord
  }
}
