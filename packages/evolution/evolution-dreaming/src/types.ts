/**
 * Vocabulary of the dreaming consolidation: the phases, the candidates they
 * scan, and the durable record they write.
 * @module @deepseek-ai/dsh-evolution-dreaming/types
 */

import type { DreamSignals } from './signals.ts'

/**
 * One phase of the cycle. Light gathers and stages, REM summarizes what was
 * staged, and deep is the only phase that writes durable memory.
 */
export type DreamPhase = 'light' | 'rem' | 'deep'

/**
 * Where one candidate's sightings come from. `attributed` is a failure the
 * feedback seam observed itself, which records the tool call and the session
 * beside the message; `unattributed` is an episodic note, which the memory
 * store records as text with a day and nothing that identifies its author.
 */
export type DreamAttribution = 'attributed' | 'unattributed'

/** The gate that refused a candidate the durable promotion path. */
export type DreamRefusalReason =
  | 'unattributed-sighting'
  | 'below-score'
  | 'below-recall'
  | 'below-diversity'

/** One staged candidate, as the light phase produced it. */
export interface DreamCandidate {
  /** Stable identity: the normalized statement. */
  id: string
  /** The statement as observed. */
  statement: string
  /** Tool whose failure produced it, or null when the failure named no tool. */
  tool: string | null
  /** Times it was observed across the summarized sessions. */
  count: number
  /** Distinct sessions that reported it. */
  sessions: number
  /** ISO-8601 instant of the first observation. */
  firstAt: string
  /** ISO-8601 instant of the most recent observation. */
  lastAt: string
  /** Where its sightings came from; `attributed` if any one of them was observed. */
  attribution: DreamAttribution
}

/** The evidence the promotion gate judged, recorded on the narrative it admitted. */
export interface DreamPromotionEvidence {
  /** Attribution of the candidate the gate admitted. */
  attribution: DreamAttribution
  /** Sightings the candidate carried when it was admitted. */
  count: number
  /** Distinct sessions the candidate carried when it was admitted. */
  sessions: number
}

/** One candidate the deep phase promoted into the scope's durable dreams. */
export interface DreamPromotion {
  /** Identity of the promoted candidate. */
  id: string
  /** The statement promoted. */
  statement: string
  /** Tool whose failure produced it, or null. */
  tool: string | null
  /** The composite that qualified it. */
  score: number
  /** The per-dimension contributions behind that composite. */
  signals: DreamSignals
  /** ISO-8601 instant of promotion. */
  promotedAt: string
  /** Attribution and counts the gate judged when it admitted this narrative. */
  evidence: DreamPromotionEvidence
  /** Statements folded into this one, oldest fold first, bounded by `maxRestatements`. */
  restatements: readonly string[]
  /** Identity of the narrative that corrected this one, or null while it answers. */
  supersededBy: string | null
  /** ISO-8601 instant of the supersession, or null. */
  supersededAt: string | null
}

/** Who wrote one ledger entry. */
export type DreamLedgerActor = 'dreaming' | 'operator'

/** What one ledger entry recorded: a promotion pass, or a rollback of one. */
export type DreamLedgerAction = 'promote' | 'rollback'

/** What one promotion pass did, at the durable boundary. */
export interface DreamLedgerEvidence {
  /** Narratives the pass added. */
  promoted: number
  /** Candidates the pass folded into a narrative it already held. */
  merged: number
  /** Narratives the pass retired. */
  superseded: number
  /** Narratives the pass dropped. */
  pruned: number
  /** Ledger entry this one reverses, or null for a promotion pass. */
  rollbackOf: string | null
}

/**
 * One entry of a scope's promotion ledger. `before` and `after` are the
 * preimage and postimage of the promotions array the write replaced — the
 * record is its own blob store, so a preimage cannot go missing between the
 * write and the rollback that reads it.
 */
export interface DreamLedgerEntry {
  /** Stable entry identity, for rollback and for a rollback's own reversal. */
  id: string
  /** ISO-8601 instant the entry was appended. */
  at: string
  /** Who wrote the entry. */
  actor: DreamLedgerActor
  /** Entry kind. */
  action: DreamLedgerAction
  /** What the write did. */
  evidence: DreamLedgerEvidence
  /** The promotions array this write replaced. */
  before: readonly DreamPromotion[]
  /** The promotions array this write installed. */
  after: readonly DreamPromotion[]
}

/** One narrative a rollback put back into answering. */
export interface DreamRestored {
  /** Identity of the narrative. */
  id: string
  /** The statement it carries. */
  statement: string
}

/** Outcome of one rollback. */
export interface DreamRollbackReport {
  /** ISO-8601 instant the rollback ran. */
  at: string
  /** Human label of the rolled-back unit, such as `pass '<id>'`. */
  label: string
  /** Narratives restored to answering, in preimage order. */
  restored: readonly DreamRestored[]
  /** Ledger entry recording this rollback, whose preimage is what it replaced. */
  preRollback: string
}

/** Candidates one phase refused, by named gate. */
export interface DreamRefusal {
  /** The gate that refused them. */
  reason: DreamRefusalReason
  /** How many candidates it refused. */
  count: number
}

/** One theme of the REM narrative: a group of candidates sharing a subject. */
export interface DreamTheme {
  /** The shared subject: the failing tool, or the statement's own identity. */
  key: string
  /** Candidates in this theme. */
  candidates: number
  /** Highest composite among them. */
  bestScore: number
}

/** What one complete cycle observed, written by the REM phase. */
export interface DreamNarrative {
  /** ISO-8601 instant the cycle ran. */
  at: string
  /** Candidates the light phase scanned. */
  scanned: number
  /** Candidates that survived deduplication. */
  staged: number
  /** Themes the REM phase derived from the staged candidates. */
  themes: readonly DreamTheme[]
  /** Candidates the deep phase promoted. */
  promoted: number
  /** Promotions dropped by the decay rule. */
  pruned: number
}

/** Durable per-scope dreaming state. */
export interface DreamsRecord {
  /** Narratives, newest first, bounded by `maxNarratives`. */
  narratives: readonly DreamNarrative[]
  /** Promotions, newest first, bounded by `maxPromotions`. */
  promotions: readonly DreamPromotion[]
  /** Promotion ledger, newest first, bounded by `maxLedgerEntries`. */
  ledger: readonly DreamLedgerEntry[]
  /** ISO-8601 instant of the last write. */
  updatedAt: string
}

/** What one phase did for one scope. */
export interface DreamPhaseReport {
  /** The phase that ran. */
  phase: DreamPhase
  /** Scope identity the phase ran for. */
  scopeId: string
  /** Candidates scanned by this phase. */
  scanned: number
  /** Candidates staged by this phase. */
  staged: number
  /** Narratives this phase added, the replacement a correction installs among them. */
  promoted: number
  /** Candidates this phase folded into an existing narrative. */
  merged: number
  /** Narratives this phase retired in favor of a correction. */
  superseded: number
  /** Promotions dropped by this phase. */
  pruned: number
  /** Candidates the promotion gate refused, by named gate, alphabetically. */
  refused: readonly DreamRefusal[]
}

/** What one complete cycle did for one scope. */
export interface DreamReport extends Omit<DreamPhaseReport, 'phase'> {
  /** The phases that ran, in order. */
  phases: readonly DreamPhaseReport[]
}
