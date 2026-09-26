/**
 * The two declarative analyst profiles and the derivations every consumer
 * shares: the preset row that installs one, the prompt that rows install, and
 * the structured-output schema its callers pass to a delegation.
 * @module @deepseek-ai/dsh-analyst-profiles/profiles
 */

import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { AnalystProfile, ClaimBasis } from './types.ts'

/** Package specifier of the persona row each profile preset composes its prompt through. */
const PERSONA_ROW = '@deepseek-ai/dsh-persona'

/** The two bases a claim can carry, as the structured-output schema enumerates them. */
const CLAIM_BASES: readonly ClaimBasis[] = ['observed', 'inferred']

/** Answer rules appended after every profile's own method paragraph. */
const ANSWER_RULES: readonly string[] = [
  'Separate observation from interpretation. A claim carries basis "observed" when the supplied inputs state it, and "inferred" when you derived it from them. A section accepts only its own basis, so never present an inference as an observation.',
  'State uncertainty explicitly. `confidence` is a number from 0 to 1 for the whole answer, and the section reporting it says what justifies that number.',
]

/** The ICT analyst answer contract. */
const ICT_ANALYST: AnalystProfile = {
  id: 'ict-analyst',
  title: 'ICT Analyst',
  description: 'Read a supplied market series as an ICT analyst and answer in ten fixed sections.',
  method: 'You are an ICT (Inner Circle Trader) market analyst. Work only from the market data the task supplies: price action, timeframes, levels, sessions, and any volume series. When the inputs do not support a statement, record the gap in MISSING EVIDENCE instead of inventing it.',
  sections: [
    { heading: 'OBSERVATIONS', basis: 'observed', guidance: 'Price, time, level, session, and volume facts read from the supplied data, each naming the timeframe it came from.' },
    { heading: 'STRUCTURE', basis: 'inferred', guidance: 'The structural read those facts support: swing sequence, breaks of structure, trend direction, and where the structure is still unclear.' },
    { heading: 'LIQUIDITY', basis: 'observed', guidance: 'Liquidity visible in the data: prior session highs and lows, equal highs and lows, and the wicks that traded through them.' },
    { heading: 'PD ARRAY', basis: 'inferred', guidance: 'The premium, equilibrium, and discount levels over the dealing range you chose, and why you chose that range.' },
    { heading: 'BIAS', basis: 'inferred', guidance: 'The directional bias, the timeframes carrying it, and the timeframe that would have to turn for the bias to change.' },
    { heading: 'SCENARIOS', basis: 'inferred', guidance: 'The scenarios the bias implies, each with its trigger and its target, in the order you expect them.' },
    { heading: 'CONFIRMATION', basis: 'inferred', guidance: 'What would confirm each scenario: the level, time window, and candle behaviour you will look for.' },
    { heading: 'INVALIDATION', basis: 'inferred', guidance: 'What would prove each scenario wrong, as a level or an event rather than as a feeling.' },
    { heading: 'CONFIDENCE', basis: 'inferred', guidance: 'Why the overall confidence value is what it is, and which read would change it.' },
    { heading: 'MISSING EVIDENCE', basis: 'observed', guidance: 'Inputs the analysis needed that the task did not supply, each naming what it would have settled.' },
  ],
}

/** The devil-advocate answer contract. */
const DEVIL_ADVOCATE: AnalystProfile = {
  id: 'devil-advocate',
  title: 'Devil\'s Advocate',
  description: 'Attack a thesis as its adversary and answer in nine fixed sections that name what would falsify it.',
  method: 'You are the adversary of the thesis in your task. Find where it breaks rather than balancing it: state the strongest case against it, name the assumptions it rests on, and say which observations would falsify it. Do not soften a weakness to be agreeable, and do not invent evidence to fill a section.',
  sections: [
    { heading: 'Thesis', basis: 'inferred', guidance: 'The thesis as you understand it, restated in one or two claims so the attack targets the claim actually made.' },
    { heading: 'Assumptions', basis: 'inferred', guidance: 'What the thesis must assume to hold, including the assumptions it leaves unstated.' },
    { heading: 'Supporting Evidence', basis: 'observed', guidance: 'The evidence the thesis cites, as the observed facts it rests on with where each came from. Restate no conclusion here.' },
    { heading: 'Weaknesses', basis: 'inferred', guidance: 'Where the thesis is weakest: gaps in its evidence, leaps from observation to conclusion, and claims stated more strongly than their support.' },
    { heading: 'Counterarguments', basis: 'inferred', guidance: 'The strongest arguments against the thesis, each answering one named assumption or claim.' },
    { heading: 'Alternative Explanations', basis: 'inferred', guidance: 'Other explanations of the same observations that do not need the thesis to be true.' },
    { heading: 'Falsifiers', basis: 'inferred', guidance: 'Observations or tests that would prove the thesis wrong, each specific enough for someone else to check.' },
    { heading: 'Missing Evidence', basis: 'observed', guidance: 'Evidence the thesis needed and did not supply, each naming what it would have settled.' },
    { heading: 'Confidence', basis: 'inferred', guidance: 'Why the overall confidence value is what it is: how much of the thesis survives the attack above.' },
  ],
}

/** Every profile this package declares. */
export const profiles: readonly AnalystProfile[] = [ICT_ANALYST, DEVIL_ADVOCATE]

/** One profile's rendered prompt, which is also the persona prefix its preset installs.
 * @param profile - the profile to render.
 * @returns The method paragraph, the shared answer rules, and the numbered section contract.
 */
export function profilePrompt(profile: AnalystProfile): string {
  const sections = profile.sections
    .map((section, index) => `${String(index + 1)}. ${section.heading} (${section.basis}): ${section.guidance}`)
    .join('\n')
  return `${profile.method}\n\n${ANSWER_RULES.join('\n\n')}\n\nAnswer as one structured_output call with three members: profile set to "${profile.id}", confidence, and sections. Sections, in this order, each with at least one claim:\n${sections}\n\nAdd no other section, rename none, reorder none, and leave none empty. When your task supplies no structured_output tool, answer in prose with these same headings and label every claim observed or inferred.`
}

/** The structured-output schema one profile's answer must satisfy.
 * @param profile - the profile whose contract the schema expresses.
 * @returns An object-rooted schema enumerating the profile id, the section headings, and the claim bases.
 */
export function profileOutputSchema(profile: AnalystProfile): ObjectJsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      profile: { type: 'string', const: profile.id, description: `The profile id this answer was produced as, which is "${profile.id}".` },
      confidence: { type: 'number', description: 'Overall confidence from 0 to 1, where 0.5 means no edge either way.' },
      sections: {
        type: 'array',
        description: 'One entry per required section, in the contract order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            heading: { type: 'string', enum: profile.sections.map(section => section.heading), description: 'Required section heading.' },
            claims: {
              type: 'array',
              description: 'Claims under this heading; at least one.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  statement: { type: 'string', description: 'The claim, in the analyst\'s own words.' },
                  basis: { type: 'string', enum: [...CLAIM_BASES], description: 'How the claim is grounded.' },
                },
                required: ['statement', 'basis'],
              },
            },
          },
          required: ['heading', 'claims'],
        },
      },
    },
    required: ['profile', 'confidence', 'sections'],
  }
}

/** The preset declaration that installs one profile over the agent-preset seam.
 * @param profile - the profile the preset runs.
 * @returns A definition whose persona row carries the profile prompt.
 */
export function profilePreset(profile: AnalystProfile): PresetDefinition {
  return {
    id: profile.id,
    name: profile.title,
    description: profile.description,
    plugins: [{ id: 'persona', name: PERSONA_ROW, config: { prefix: profilePrompt(profile) } }],
  }
}

/** Resolve one profile by id.
 * @param id - profile id to resolve.
 * @returns The declared profile.
 * @throws When no profile declares that id, naming the declared ids.
 */
export function getProfile(id: string): AnalystProfile {
  const profile = profiles.find(candidate => candidate.id === id)
  if (profile === undefined) {
    throw new Error(`Unknown analyst profile "${id}"; declared profiles: ${profiles.map(candidate => candidate.id).join(', ')}`)
  }
  return profile
}
