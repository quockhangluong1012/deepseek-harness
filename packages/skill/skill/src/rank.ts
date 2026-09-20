/**
 * Query-time skill ranking: a BM25 rough rank over routing text, re-ranked
 * by embedding similarity and downstream utility. Pure and synchronous —
 * no I/O, no model calls — so an offline gate can run a real selector while
 * the per-turn catalog path stays untouched.
 *
 * The rough rank scores each skill's name, description, and `whenToUse`
 * with BM25 (`k1 = 1.2`, `b = 0.75`, the Robertson defaults), counted
 * directly over the candidate set: catalogs are tens of skills, so the
 * straightforward count beats an index nobody would maintain. The re-rank
 * blends three fixed-weight signals: normalized lexical fit, embedding
 * cosine similarity when the caller supplies vectors, and utility evidence
 * the caller maps from telemetry (trust standing plus the recorded failure
 * rate). Weights are algorithm constants, not deployment choices: lexical
 * fit leads because descriptions are curated routing text, semantics
 * second, utility breaks near-ties toward skills with clean evidence.
 *
 * Ranking never invents evidence: a skill without a utility signal ranks on
 * lexical fit alone at a neutral utility, and a skill without a vector gets
 * no semantic support. A skill whose declared prerequisites are absent from
 * the candidate set scores zero instead: the gate is on routability, not
 * quality. Results are deterministic: score, then name.
 * @module @deepseek-ai/dsh-skill/src/rank
 */

/** Lexical-fit weight in the final score. */
const LEXICAL_WEIGHT = 0.5

/** Embedding-similarity weight in the final score. */
const SEMANTIC_WEIGHT = 0.3

/** Downstream-utility weight in the final score. */
const UTILITY_WEIGHT = 0.2

/** BM25 term-frequency saturation. */
const BM25_K1 = 1.2

/** BM25 document-length normalization. */
const BM25_B = 0.75

/**
 * Downstream utility evidence for one skill, mapped by the caller from
 * whatever store owns it. The ranker takes this structural shape rather
 * than a store record, so no package dependency follows the signal.
 */
export interface SkillRankSignal {
  /** Whether independent evidence currently vouches for the skill. */
  readonly trusted: boolean
  /** Successful model loads through the skill tool. */
  readonly useCount: number
  /** Failed skill-tool loads. */
  readonly failureCount: number
}

/** Embedding vectors for one ranking call. */
export interface SkillRankVectors {
  /** The query vector. */
  readonly query: readonly number[]
  /** Skill vectors by skill name; a skill without one gets no semantic support. */
  readonly byName: ReadonlyMap<string, readonly number[]>
}

/** Options for one ranking call. */
export interface RankSkillsOptions {
  /** Utility evidence by skill name; skills without an entry keep neutral utility. */
  readonly signals?: ReadonlyMap<string, SkillRankSignal> | undefined
  /** Embedding vectors; omission ranks on lexical fit and utility alone. */
  readonly vectors?: SkillRankVectors | undefined
  /**
   * Prerequisite skill names by skill name, from frontmatter `requires`;
   * skills without an entry declare none. A skill with at least one
   * prerequisite missing from the candidate set scores zero: routing to a
   * skill that cannot work without an absent sibling is never the right call.
   */
  readonly requires?: ReadonlyMap<string, readonly string[]> | undefined
}

/** One ranked skill. */
export interface RankedSkill<T> {
  /** The candidate as supplied. */
  readonly skill: T
  /** BM25 rough-rank score over the routing text. */
  readonly roughScore: number
  /** Final score after the semantic and utility re-rank. */
  readonly score: number
}

/**
 * Split text into indexable tokens: unicode letters and numbers,
 * case-folded. Kebab-case names split at their separators, so a `code`
 * query matches the `code-review` skill.
 * @param text - routing text.
 * @returns the tokens, in occurrence order.
 */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * Cosine similarity clamped to no support: a negative alignment is
 * evidence against routing, never a partial credit.
 * @param left - one vector.
 * @param right - the other, with the same length.
 * @returns similarity in `[0, 1]`, or 0 for mismatched or empty vectors.
 */
function cosineSupport(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftSquared = 0
  let rightSquared = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] as number
    const rightValue = right[index] as number
    dot += leftValue * rightValue
    leftSquared += leftValue * leftValue
    rightSquared += rightValue * rightValue
  }
  const magnitude = Math.sqrt(leftSquared) * Math.sqrt(rightSquared)
  if (magnitude === 0) return 0
  return Math.max(0, dot / magnitude)
}

/**
 * Rank skills for one query: BM25 rough rank over routing text, re-ranked
 * by embedding similarity and downstream utility.
 * @param query - the routing query, e.g. a task statement or trigger phrase.
 * @param skills - candidates in any order.
 * @param nameOf - skill name for signal and vector lookup.
 * @param textOf - routing text (name, description, `whenToUse`) of one skill.
 * @param options - utility signals and embedding vectors.
 * @returns the skills, best first, each with its rough and final scores.
 */
export function rankSkills<T>(
  query: string,
  skills: readonly T[],
  nameOf: (skill: T) => string,
  textOf: (skill: T) => string,
  options: RankSkillsOptions = {},
): RankedSkill<T>[] {
  const queryTokens = new Set(tokenize(query))
  const documents = skills.map(skill => tokenize(textOf(skill)))
  const count = skills.length
  const averageLength = documents.reduce((total, tokens) => total + tokens.length, 0) / Math.max(1, count)
  const rough = documents.map((tokens): number => {
    let score = 0
    for (const token of queryTokens) {
      const occurrences = tokens.filter(candidate => candidate === token).length
      if (occurrences === 0) continue
      const documentsWithToken = documents.filter(document => document.includes(token)).length
      const idf = Math.log(1 + (count - documentsWithToken + 0.5) / (documentsWithToken + 0.5))
      const lengthNorm = 1 - BM25_B + BM25_B * (tokens.length / Math.max(1, averageLength))
      score += (idf * occurrences * (BM25_K1 + 1)) / (occurrences + BM25_K1 * lengthNorm)
    }
    return score
  })
  const bestRough = Math.max(0, ...rough)
  const vectors = options.vectors
  const signals = options.signals
  const names = new Set(skills.map(skill => nameOf(skill)))
  const requires = options.requires
  return skills
    .map((skill, index): RankedSkill<T> => {
      const roughScore = rough[index] as number
      const lexical = bestRough === 0 ? 0 : roughScore / bestRough
      const name = nameOf(skill)
      const vector = vectors?.byName.get(name)
      const semantic = vectors === undefined || vector === undefined ? 0 : cosineSupport(vectors.query, vector)
      const signal = signals?.get(name)
      const utility = signal === undefined
        ? 0.75
        : (signal.trusted ? 1 : 0.5) * (1 - signal.failureCount / Math.max(1, signal.useCount + signal.failureCount))
      const prerequisites = requires?.get(name) ?? []
      const routable = prerequisites.every(prerequisite => names.has(prerequisite))
      return {
        skill,
        roughScore,
        score: routable ? LEXICAL_WEIGHT * lexical + SEMANTIC_WEIGHT * semantic + UTILITY_WEIGHT * utility : 0,
      }
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      const leftName = nameOf(left.skill)
      const rightName = nameOf(right.skill)
      if (leftName === rightName) return 0
      return leftName < rightName ? -1 : 1
    })
}
