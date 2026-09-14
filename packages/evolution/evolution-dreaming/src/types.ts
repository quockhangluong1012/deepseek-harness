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
  /** Candidates promoted by this phase. */
  promoted: number
  /** Promotions dropped by this phase. */
  pruned: number
}

/** What one complete cycle did for one scope. */
export interface DreamReport extends Omit<DreamPhaseReport, 'phase'> {
  /** The phases that ran, in order. */
  phases: readonly DreamPhaseReport[]
}
