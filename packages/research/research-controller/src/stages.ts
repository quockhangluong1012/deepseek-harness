/**
 * The ordered stage table of the research quality-control loop. Runtime module:
 * `types.ts` declares the vocabulary these tables are typed by.
 * @module @deepseek-ai/dsh-research-controller/src/stages
 */

import type { ResearchStage, StageDefinition } from './types.ts'

/**
 * Every stage of the loop, in the order one run advances through them. The
 * order is the loop's contract: a run advances the first stage that has not
 * produced, so no stage can be skipped and none can run twice in place.
 */
export const RESEARCH_STAGES: readonly ResearchStage[] = [
  'question',
  'decompose',
  'research-plan',
  'search',
  'source-triage',
  'claim-extraction',
  'evidence',
  'contradiction-search',
  'synthesis',
  'epistemic-review',
]

/**
 * The stages whose work is a registered provider's. Every other stage's work
 * is the agent loop's: the model supplies the stage's output through the tool.
 * A run whose next stage is one of these fails loud when no provider is
 * registered for it.
 */
export const PROVIDER_STAGES: readonly ResearchStage[] = ['search', 'source-triage', 'contradiction-search']

/** What each stage establishes, in the order the loop runs them. */
export const STAGE_DEFINITIONS: readonly StageDefinition[] = [
  { stage: 'question', producer: 'agent-loop', purpose: 'State the question the run answers.' },
  { stage: 'decompose', producer: 'agent-loop', purpose: 'Break the question into sub-questions.' },
  { stage: 'research-plan', producer: 'agent-loop', purpose: 'State the steps that answer the sub-questions.' },
  { stage: 'search', producer: 'provider', purpose: 'Find sources, each recorded as an observation.' },
  { stage: 'source-triage', producer: 'provider', purpose: 'Class and rank the sources the search found.' },
  { stage: 'claim-extraction', producer: 'agent-loop', purpose: 'Assert claims that cite recorded observations.' },
  { stage: 'evidence', producer: 'agent-loop', purpose: 'Collect the observations and claims the session recorded.' },
  { stage: 'contradiction-search', producer: 'provider', purpose: 'Search for what would make the claims false.' },
  { stage: 'synthesis', producer: 'agent-loop', purpose: 'State the answer in the six epistemic buckets.' },
  { stage: 'epistemic-review', producer: 'agent-loop', purpose: 'Check the answer against its claims and settle the run.' },
]
