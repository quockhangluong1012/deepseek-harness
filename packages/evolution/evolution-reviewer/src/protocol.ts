/**
 * Structured extraction protocol for evolution lessons. The model reads one
 * turn's transcript against the relevance-bounded slice of the scope's own
 * artifacts and answers with a JSON array of `confirms` / `contradicts` /
 * `new` decisions, each referencing an existing artifact by the ordinal it was
 * shown under, plus — for a turn whose transcript records a failed tool call —
 * one `critique` naming the expectation, the failure, and the correction.
 * Ordinals are resolved back to artifact ids by the caller, so nothing
 * index-based ever crosses a persistence boundary.
 * @module @deepseek-ai/dsh-evolution-reviewer/protocol
 */

import { z } from 'zod'
import type { LessonArtifact, LessonArtifactScope, LessonEvidenceKind } from '@deepseek-ai/dsh-evolution-memory'

/** One relevance-bounded artifact and the ordinal the model references it by. */
export interface IndexedArtifact {
  /** 1-based position within the list one extraction call shows the model. */
  index: number
  /** The artifact that ordinal stands for. */
  artifact: LessonArtifact
}

/**
 * One critique of the turn the model was shown: §5's critique step in §4.2's
 * vocabulary. The three named fields are what a critique must state, so the
 * schema accepts them empty and the reviewer discards an unfilled critique
 * rather than the whole batch.
 */
export interface CritiqueDecision {
  action: 'critique'
  /** §4.2 `violated_expectation`: what this turn was supposed to achieve. */
  expectation: string
  /** §4.2 `what_failed`: what the transcript shows the turn did instead. */
  failure: string
  /** §4.2 `corrected_strategy`: the revision — what to do instead next time. */
  correction: string
  /** §4.2 `confidence` in the critique. */
  confidence: number
  /** §4.2 artifact scope the revision the critique licenses is recorded at. */
  scope: LessonArtifactScope
}

/** One decision the model emits about the turn it was shown. */
export type ExtractionDecision =
  | { action: 'confirms'; index: number }
  | { action: 'contradicts'; index: number; statement?: string | undefined; confidence?: number | undefined }
  | {
    action: 'new'
    statement: string
    conditions: string
    evidence: LessonEvidenceKind
    confidence: number
    scope: LessonArtifactScope
    ttlDays?: number | undefined
  }
  | CritiqueDecision

/**
 * Validated shape of one extraction decision: the model's own output
 * vocabulary, addressed by index rather than by artifact id.
 *
 * A critique's three named fields are `z.string()` rather than `.min(1)` so an
 * ungrounded critique costs itself and not the batch it arrived in: the
 * reviewer discards it, while every decision beside it still applies.
 */
export const extractionDecision: z.ZodType<ExtractionDecision> = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('confirms'),
    index: z.number().int().min(1),
  }),
  z.object({
    action: z.literal('contradicts'),
    index: z.number().int().min(1),
    statement: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
  }),
  z.object({
    action: z.literal('new'),
    statement: z.string().min(1),
    conditions: z.string(),
    evidence: z.enum(['fact', 'observation', 'inference']),
    confidence: z.number().min(0).max(1),
    scope: z.enum(['user', 'project', 'global']),
    ttlDays: z.number().int().min(1).optional(),
  }),
  z.object({
    action: z.literal('critique'),
    expectation: z.string(),
    failure: z.string(),
    correction: z.string(),
    confidence: z.number().min(0).max(1),
    scope: z.enum(['user', 'project', 'global']),
  }),
])

/**
 * Build the system prompt for one lessons-extraction call.
 * @returns deterministic instruction text naming the three decisions and forbidding derived, secret, and sensitive content.
 */
export function extractionSystemPrompt(): string {
  return [
    'You distill durable lessons for an agent scope from one turn of conversation.',
    'Reply with JSON only, no prose and no code fence: an array of decisions.',
    'Each decision is one of:',
    '- {"action":"confirms","index":1} — this turn\'s evidence supports the listed artifact at that index; no new text is needed.',
    '- {"action":"contradicts","index":2,"statement":"corrected fact","confidence":0.8} — this turn contradicts that artifact; the corrected statement and confidence are optional.',
    '- {"action":"new","statement":"a durable fact","conditions":"when it applies","evidence":"fact","confidence":0.7,"scope":"project","ttlDays":30} — a fact no listed artifact covers. evidence is one of fact, observation, inference; scope is one of user, project, global; ttlDays is optional.',
    '- {"action":"critique","expectation":"what this turn was supposed to achieve","failure":"what the transcript shows went wrong","correction":"what to do instead next time","confidence":0.7,"scope":"project"} — a critique of this turn, allowed only when the transcript records a failed tool call. Name all three of the expectation, the failure, and the correction.',
    'Rules:',
    '- A transcript row with role "tool" is a tool call whose result failed; critique against exactly that failure.',
    '- Emit at most one critique per recorded failure. A critique naming no expectation, no failure, or no correction is discarded.',
    '- Reference an existing artifact only by the index shown in the list, never by id.',
    '- Keep project purpose, user preferences, decisions taken, and stable references that future turns can reuse.',
    '- Leave out anything readable from the code or the scope instructions themselves.',
    '- Leave out credentials, tokens, keys, secrets, and health, race, religion, political, or gender-identity data.',
    '- Report nothing rather than guessing: with nothing worth keeping, reply [].',
  ].join('\n')
}

/**
 * Frame one extraction request: the transcript as JSON, so conversation text
 * cannot break delimiters, plus the numbered list of relevant artifacts the
 * decisions may reference.
 * @param rows - role/text rows in chronological order.
 * @param relevant - the relevance-bounded artifacts, already numbered for this call.
 * @returns the user prompt text.
 */
export function frameExtractionRequest(
  rows: readonly { role: string; text: string }[],
  relevant: readonly IndexedArtifact[],
): string {
  return [
    '<relevant-artifacts>',
    ...relevant.map(entry => `${entry.index}. ${entry.artifact.statement}`),
    '</relevant-artifacts>',
    `Emit decisions for this JSON transcript:\n${JSON.stringify(rows)}`,
  ].join('\n')
}

/**
 * Decode one extraction answer. The model output is a wire boundary, so every
 * decision is validated here: an unreadable or ill-formed answer throws and
 * nothing is stored. An empty answer is the model reporting nothing, which is
 * a valid outcome rather than an error.
 * @param text - the model's text.
 * @returns the accepted decisions, in the order the model emitted them.
 */
export function parseExtractionDecisions(text: string): ExtractionDecision[] {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  if (unfenced === '') return []
  let decoded: unknown
  try {
    decoded = JSON.parse(unfenced)
  } catch {
    throw new Error('evolution-reviewer: extraction did not return JSON')
  }
  const parsed = z.array(extractionDecision).safeParse(decoded)
  if (!parsed.success) throw new Error('evolution-reviewer: extraction returned an invalid decision list')
  return parsed.data
}
