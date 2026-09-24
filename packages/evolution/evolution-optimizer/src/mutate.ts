/**
 * Mutation: frame one skill rewrite request, stream it over the host LLM, and
 * parse the machine-readable candidate bodies. The framing mirrors the
 * curator's consolidation input (fixed instruction plus a byte budget that
 * drops from the end); the parse accepts only complete replacement SKILL.md
 * bodies, so a chatty or empty answer mutates nothing.
 * @module @deepseek-ai/dsh-evolution-optimizer/mutate
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed, GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** @persistenceAttribution */
    'evolution-optimizer': { kind: 'evolution-optimizer' } & ContextFormed
  }
}

/**
 * Instruction opening every mutation request: the fixed protocol plus the
 * selected operator's own line.
 * @param count - bodies the request must return.
 * @param instruction - the selected operator's instruction line.
 * @returns the instruction block the request opens with.
 */
export function mutationInstructions(count: number, instruction: string): string {
  return [
    'You improve one skill package in a single pass.',
    instruction,
    `Reply with a JSON array of exactly ${count} strings, each a complete replacement SKILL.md body.`,
    'Every body must differ from the current one; keep what works, fix what the evidence implicates.',
    'Every body must start with --- frontmatter naming the same skill and a one-line routing description.',
    'No prose outside the array.',
  ].join('\n')
}

/** One mutation operator: a stable id and the instruction line it contributes. */
export interface MutationOperator {
  /** Stable id a deployment selects in Config. */
  id: string
  /** Instruction line appended to the request header. */
  instruction: string
}

/**
 * Built-in mutation operators. One prompt as the only mutation mechanism
 * converges on one rewrite style, so a run may draw candidates from several.
 *
 * Selection guide: `rewrite` clarifies without changing behavior; `compress`
 * shortens a body the evidence shows is ignored for length; `guard` adds the
 * missing precondition; `exemplify` teaches by example; `generalize` widens a
 * rule that only covers the failing instance; `decompose` splits an
 * uncheckable procedure into steps; `compose` merges overlapping rules;
 * `reorder` moves the implicated check earlier without touching rule text;
 * `remove-step` deletes a step the evidence shows never fires;
 * `change-tool` swaps the implicated tool call; `change-retrieval` changes
 * only what the body looks up; `change-evaluator` changes only how the body
 * checks its own result. Two portfolio members from the specification stay
 * out deliberately: `merge-two-candidates` needs two input bodies and the
 * frame carries one, and `adversarial-patch` belongs to the contamination
 * review, not to repair mutation.
 */
export const MUTATION_OPERATORS: readonly MutationOperator[] = [
  { id: 'rewrite', instruction: 'Rewrite the body for clarity and ordering; change only what the evidence implicates.' },
  { id: 'compress', instruction: 'Cut the body to the shortest text that still states every rule the evidence shows matters.' },
  { id: 'guard', instruction: 'Add the precondition, refusal, or validation the evidence implicates, and nothing else.' },
  { id: 'exemplify', instruction: 'Add one worked example per rule the evidence implicates; drop nothing that already works.' },
  { id: 'generalize', instruction: 'Widen each rule the evidence implicates so it covers the failure class, not just the failing instance.' },
  { id: 'decompose', instruction: 'Split the procedure the evidence implicates into separately checkable steps; keep every existing rule.' },
  { id: 'compose', instruction: 'Merge duplicated or overlapping rules the evidence implicates into one rule that states both.' },
  { id: 'reorder', instruction: 'Move the check the evidence implicates earlier in the procedure; change no rule text.' },
  { id: 'remove-step', instruction: 'Delete the step the evidence shows never fires or always passes; keep everything else byte-identical.' },
  { id: 'change-tool', instruction: 'Replace the tool call the evidence implicates with the tool that actually answers the question.' },
  { id: 'change-retrieval', instruction: 'Change only what the body retrieves — queries, sources, or lookup order — as the evidence implicates.' },
  { id: 'change-evaluator', instruction: 'Change only how the body checks its own result — thresholds, assertions, or verification steps — as the evidence implicates.' },
]

/**
 * Resolve configured operator ids against the built-in portfolio.
 * @param ids - operator ids a deployment selected, in request order.
 * @returns the operators in the configured order.
 * @throws when a selected id is not a built-in operator.
 */
export function resolveOperators(ids: readonly string[]): readonly MutationOperator[] {
  return ids.map((id) => {
    const operator = MUTATION_OPERATORS.find(candidate => candidate.id === id)
    if (operator === undefined) {
      throw new Error(`evolution-optimizer: unknown mutation operator '${id}'`)
    }
    return operator
  })
}

/**
 * Split a candidate budget across the portfolio: candidates go to operators in
 * order, and the leading operators take the remainder.
 * @param total - candidates the run may evaluate.
 * @param operators - selected operators, in request order.
 * @returns one entry per operator that receives at least one candidate.
 */
export function distributeCandidates(
  total: number,
  operators: readonly MutationOperator[],
): readonly { operator: MutationOperator; count: number }[] {
  const each = Math.floor(total / operators.length)
  const remainder = total % operators.length
  return operators
    .map((operator, index) => ({ operator, count: each + (index < remainder ? 1 : 0) }))
    .filter(entry => entry.count > 0)
}

/**
 * Frame one mutation request, truncating the evidence (never the skill body)
 * until the frame fits the byte budget.
 * @param skill - skill name the bodies replace.
 * @param body - current SKILL.md body the candidates must differ from.
 * @param evidence - failure evidence the rewrite should address.
 * @param count - bodies requested.
 * @param maxBytes - byte budget for the framed text.
 * @param instruction - the selected operator's instruction line.
 * @returns the framed text, its byte size, and whether evidence was dropped.
 */
export function frameMutationInput(
  skill: string,
  body: string,
  evidence: string,
  count: number,
  maxBytes: number,
  instruction: string,
): { text: string; inputBytes: number; truncated: boolean } {
  const header = mutationInstructions(count, instruction)
  let kept = evidence.length
  let text = ''
  for (;;) {
    text = `${header}\n\nSkill: ${skill}\n\nCurrent SKILL.md:\n${body}\n\nEvidence:\n${evidence.slice(0, kept)}`
    if (Buffer.byteLength(text) <= maxBytes || kept === 0) break
    kept = Math.floor(kept / 2)
  }
  return { text, inputBytes: Buffer.byteLength(text), truncated: kept < evidence.length }
}

/**
 * Parse one mutation answer into candidate bodies: complete, distinct,
 * different from the baseline, capped at the requested count.
 * @param text - model answer, optionally fenced as json.
 * @param body - current body every candidate must differ from.
 * @param count - maximum bodies to keep, in answer order.
 * @returns the usable bodies, possibly empty.
 */
export function parseMutationResponse(text: string, body: string, count: number): string[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  let parsed: unknown
  try {
    parsed = JSON.parse((fenced?.[1] ?? text).trim())
  } catch {
    // A non-JSON answer is the model's error to absorb, not a crash.
    return []
  }
  if (!Array.isArray(parsed)) return []
  const seen = new Set<string>([body])
  const candidates: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'string' || entry.trim().length === 0) continue
    if (seen.has(entry)) continue
    seen.add(entry)
    candidates.push(entry)
    if (candidates.length >= count) break
  }
  return candidates
}

/** Model stream the mutation loop reads one answer from. */
export interface MutationFork {
  /**
   * Stream one model request.
   * @param options - the fully assembled request.
   * @returns the chunk stream.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Fixed request fields for one mutation call. */
export interface MutationOptions {
  /** Provider route for the request. */
  provider: string
  /** Model id for the request. */
  model: string
  /** Output-token cap for the request. */
  maxOutputTokens: number
  /** Framed mutation input. */
  input: string
  /** Upstream cancellation forwarded to the request. */
  signal: AbortSignal
}

/**
 * Stream one mutation answer and parse its candidate bodies.
 * @param fork - model stream.
 * @param options - route, budget, framing, and cancellation.
 * @param body - current body every candidate must differ from.
 * @param count - maximum bodies to keep.
 * @returns the usable bodies, possibly empty.
 */
export async function mutateOnce(
  fork: MutationFork,
  options: MutationOptions,
  body: string,
  count: number,
): Promise<string[]> {
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: options.input }],
    source: { kind: 'evolution-optimizer' },
  })]
  const assembler = new BlockAssembler()
  for await (const chunk of fork.stream({
    provider: options.provider,
    model: options.model,
    messages,
    maxTokens: options.maxOutputTokens,
    temperature: 0,
    purpose: 'evolution-optimize',
    signal: options.signal,
  })) {
    assembler.push(chunk)
  }
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const error = new Error(finish.failure.message) as Error & { code?: string }
    error.code = finish.failure.code
    throw error
  }
  const texts = assembler.blocks()
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
  return parseMutationResponse(texts.join(''), body, count)
}
