import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { profiles, getProfile, profileOutputSchema, profilePreset, profilePrompt } from '../src/profiles.ts'
import { validateProfileArtifact } from '../src/validate.ts'
import type { AnalystProfile } from '../src/types.ts'
import AnalystProfiles from '../src/index.ts'

type MutableClaim = { statement?: unknown; basis?: unknown } | string
interface MutableSection { heading?: unknown; claims?: MutableClaim[] | undefined }
interface MutableArtifact { profile?: unknown; confidence?: unknown; sections: MutableSection[] }

const ict = getProfile('ict-analyst')
const advocate = getProfile('devil-advocate')

/** A complete, correctly based answer for one profile, mutable so a case can break one member. */
function artifactFor(profile: AnalystProfile): MutableArtifact {
  return {
    profile: profile.id,
    confidence: 0.35,
    sections: profile.sections.map(section => ({
      heading: section.heading,
      claims: [{ statement: `${section.heading} states one thing`, basis: section.basis }],
    })),
  }
}

/** A deep copy so a case can mutate one member without touching another case's fixture. */
function copy(artifact: MutableArtifact): MutableArtifact {
  const sections = artifact.sections.map((section): MutableSection => ({
    heading: section.heading,
    claims: section.claims?.map(claim => (typeof claim === 'string' ? claim : { ...claim })),
  }))
  return { profile: artifact.profile, confidence: artifact.confidence, sections }
}

/** The first section of a profile whose claims carry the given basis. */
function sectionWithBasis(profile: AnalystProfile, basis: 'observed' | 'inferred'): ProfileSectionPosition {
  const position = profile.sections.findIndex(candidate => candidate.basis === basis)
  const section = profile.sections[position]
  if (position < 0 || section === undefined) throw new Error(`no ${basis} section in ${profile.id}`)
  return { heading: section.heading, position }
}

interface ProfileSectionPosition { heading: string; position: number }

describe('the profile contracts', () => {
  it('declare the required sections of each profile in order', () => {
    expect(ict.sections.map(section => section.heading)).toEqual([
      'OBSERVATIONS', 'STRUCTURE', 'LIQUIDITY', 'PD ARRAY', 'BIAS',
      'SCENARIOS', 'CONFIRMATION', 'INVALIDATION', 'CONFIDENCE', 'MISSING EVIDENCE',
    ])
    expect(advocate.sections.map(section => section.heading)).toEqual([
      'Thesis', 'Assumptions', 'Supporting Evidence', 'Weaknesses', 'Counterarguments',
      'Alternative Explanations', 'Falsifiers', 'Missing Evidence', 'Confidence',
    ])
    for (const profile of profiles) {
      expect(profile.sections.some(section => section.basis === 'observed')).toBe(true)
      expect(profile.sections.some(section => section.basis === 'inferred')).toBe(true)
    }
  })

  it('render every section, in order, with its basis into the prompt', () => {
    for (const profile of profiles) {
      const prompt = profilePrompt(profile)
      let cursor = -1
      for (const [index, section] of profile.sections.entries()) {
        const line = `${String(index + 1)}. ${section.heading} (${section.basis}): ${section.guidance}`
        const at = prompt.indexOf(line)
        expect(at).toBeGreaterThan(cursor)
        cursor = at
      }
      expect(prompt).toContain(profile.method)
      expect(prompt).toContain(`profile set to "${profile.id}"`)
      expect(prompt).not.toContain('{{')
    }
  })

  it('express the same section order and bases in the structured-output schema', () => {
    for (const profile of profiles) {
      const schema = profileOutputSchema(profile)
      expect(schema.required).toEqual(['profile', 'confidence', 'sections'])
      expect(schema.properties?.sections?.items?.properties?.heading?.enum)
        .toEqual(profile.sections.map(section => section.heading))
      expect(schema.properties?.sections?.items?.properties?.claims?.items?.properties?.basis?.enum)
        .toEqual(['observed', 'inferred'])
      expect(schema.properties?.profile?.const).toBe(profile.id)
    }
  })

  it('are declared in the tool-runtime JSON-schema subset, which accepts a valid and rejects a shaped-wrong answer', () => {
    for (const profile of profiles) {
      const schema = profileOutputSchema(profile)
      expect(() => { assertObjectJsonSchema(schema) }).not.toThrow()
      expect(validateJsonSchemaValue(schema, artifactFor(profile))).toEqual([])
      expect(validateJsonSchemaValue(schema, { ...artifactFor(profile), confidence: 'high' })).not.toEqual([])
      expect(validateJsonSchemaValue(schema, { profile: profile.id, confidence: 0.5 })).not.toEqual([])
    }
  })

  it('declare each profile as a preset whose persona carries the contract prompt', () => {
    for (const profile of profiles) {
      const preset = profilePreset(profile)
      expect(preset).toMatchObject({ id: profile.id, name: profile.title, description: profile.description })
      expect(preset.plugins).toEqual([
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: profilePrompt(profile) } },
      ])
    }
  })

  it('resolves a declared profile by id and rejects an undeclared one', () => {
    expect(getProfile('ict-analyst')).toBe(ict)
    expect(() => getProfile('ict-analysts')).toThrow('Unknown analyst profile "ict-analysts"; declared profiles: ict-analyst, devil-advocate')
  })
})

describe('validateProfileArtifact', () => {
  it('accepts a complete answer for each profile', () => {
    for (const profile of profiles) {
      expect(validateProfileArtifact(profile, artifactFor(profile))).toEqual({ ok: true })
    }
  })

  it('rejects an answer that omits a required section', () => {
    const artifact = copy(artifactFor(ict))
    artifact.sections.splice(1, 1)
    const verdict = validateProfileArtifact(ict, artifact)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    const missing = verdict.violations.filter(violation => violation.rule === 'missing-section')
    expect(missing).toHaveLength(1)
    expect(missing[0]?.at).toBe('sections[1]')
    expect(missing[0]?.message).toContain('STRUCTURE')
    // The removed entry shifts every later section, and each shift is reported.
    expect(verdict.violations.filter(violation => violation.rule === 'section-order')).toHaveLength(8)
  })

  it('rejects an observation placed in an interpretation field', () => {
    for (const profile of profiles) {
      const artifact = copy(artifactFor(profile))
      const { heading, position } = sectionWithBasis(profile, 'inferred')
      artifact.sections[position] = { heading, claims: [{ statement: 'price swept the prior low', basis: 'observed' }] }
      const verdict = validateProfileArtifact(profile, artifact)
      expect(verdict.ok).toBe(false)
      if (verdict.ok) return
      expect(verdict.violations).toEqual([{
        rule: 'basis-mismatch',
        at: `sections[${String(position)}].claims[0].basis`,
        message: `${heading} accepts only "inferred" claims, and this claim is "observed"; move it to a section that accepts that basis or restate it as inferred`,
      }])
    }
  })

  it('rejects an interpretation placed in an observation field', () => {
    const artifact = copy(artifactFor(ict))
    artifact.sections[0] = { heading: 'OBSERVATIONS', claims: [{ statement: 'the trend is turning up', basis: 'inferred' }] }
    const verdict = validateProfileArtifact(ict, artifact)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.violations).toHaveLength(1)
    expect(verdict.violations[0]?.rule).toBe('basis-mismatch')
    expect(verdict.violations[0]?.at).toBe('sections[0].claims[0].basis')
    expect(verdict.violations[0]?.message).toContain('OBSERVATIONS accepts only "observed"')
  })

  it('rejects a section the contract does not declare', () => {
    const artifact = copy(artifactFor(advocate))
    artifact.sections.push({ heading: 'Vibes', claims: [{ statement: 'unclear', basis: 'inferred' }] })
    const verdict = validateProfileArtifact(advocate, artifact)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.violations).toEqual([{
      rule: 'unexpected-section',
      at: `sections[${String(advocate.sections.length)}].heading`,
      message: `"Vibes" is not a section of devil-advocate; the contract declares ${advocate.sections.map(section => section.heading).join(', ')}`,
    }])
  })

  it('rejects a repeated section and a reordered pair', () => {
    const repeated = copy(artifactFor(advocate))
    repeated.sections.push({ heading: 'Thesis', claims: [{ statement: 'again', basis: 'inferred' }] })
    const repeatedVerdict = validateProfileArtifact(advocate, repeated)
    expect(repeatedVerdict.ok).toBe(false)
    if (!repeatedVerdict.ok) {
      expect(repeatedVerdict.violations).toEqual([{
        rule: 'duplicate-section',
        at: `sections[${String(advocate.sections.length)}].heading`,
        message: 'Thesis appears more than once',
      }])
    }

    const swapped = copy(artifactFor(ict))
    const [first, second] = [swapped.sections[0], swapped.sections[1]]
    if (first === undefined || second === undefined) throw new Error('expected two sections')
    swapped.sections[0] = second
    swapped.sections[1] = first
    const swappedVerdict = validateProfileArtifact(ict, swapped)
    expect(swappedVerdict.ok).toBe(false)
    if (!swappedVerdict.ok) {
      expect(swappedVerdict.violations.map(violation => violation.at)).toEqual(['sections[0]', 'sections[1]'])
      expect(swappedVerdict.violations.every(violation => violation.rule === 'section-order')).toBe(true)
    }
  })

  it('rejects an empty section', () => {
    const artifact = copy(artifactFor(ict))
    artifact.sections[3] = { heading: 'PD ARRAY', claims: [] }
    const verdict = validateProfileArtifact(ict, artifact)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.violations).toEqual([{
      rule: 'empty-section',
      at: 'sections[3]',
      message: 'PD ARRAY must state at least one claim, even when the answer is that nothing applies',
    }])
  })

  it('rejects malformed claims', () => {
    const artifact = copy(artifactFor(ict))
    artifact.sections[0] = {
      heading: 'OBSERVATIONS',
      claims: ['not a map', { basis: 'observed' }, { statement: '   ', basis: 'observed' }, { statement: 'priced a sweep', basis: 'guessed' }],
    }
    const verdict = validateProfileArtifact(ict, artifact)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.violations.map(violation => violation.message)).toEqual([
      'OBSERVATIONS: each claim must be a map with a "statement" and a "basis"',
      'OBSERVATIONS: each claim must be a map with a "statement" and a "basis"',
      'OBSERVATIONS: each claim needs a non-empty "statement" string',
      'OBSERVATIONS: each claim needs a "basis" of "observed" or "inferred"',
    ])
    expect(verdict.violations.every(violation => violation.rule === 'invalid-claim')).toBe(true)
  })

  it('rejects a section entry that carries no usable heading or claims array', () => {
    const artifact = copy(artifactFor(ict))
    artifact.sections[2] = { heading: 7, claims: [] }
    const verdict = validateProfileArtifact(ict, artifact)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.violations).toEqual([{
      rule: 'invalid-section',
      at: 'sections[2]',
      message: 'each section entry needs a "heading" string and a "claims" array',
    }])
  })

  it('rejects a confidence outside the unit interval and a missing one', () => {
    for (const confidence of [1.5, -0.1, 'high', undefined]) {
      const artifact = { ...copy(artifactFor(ict)), confidence }
      const verdict = validateProfileArtifact(ict, artifact)
      expect(verdict.ok).toBe(false)
      if (verdict.ok) return
      expect(verdict.violations).toEqual([{
        rule: 'confidence-out-of-range',
        at: 'confidence',
        message: `confidence must be a number from 0 to 1, received ${JSON.stringify(confidence)}`,
      }])
    }
  })

  it('rejects an answer produced for another profile', () => {
    const verdict = validateProfileArtifact(advocate, artifactFor(ict))
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.violations[0]).toEqual({
      rule: 'wrong-profile',
      at: 'profile',
      message: 'the artifact answers as "ict-analyst" and devil-advocate was requested',
    })
  })

  it('rejects a value that is not an artifact at all', () => {
    const verdict = validateProfileArtifact(ict, 'prose instead of data')
    expect(verdict).toEqual({
      ok: false,
      violations: [{ rule: 'not-an-artifact', at: 'artifact', message: 'expected a map with "profile", "confidence", and "sections", received string' }],
    })
    for (const artifact of [null, [], { profile: ict.id, confidence: 0.5, sections: 'all of them' }]) {
      const rejected = validateProfileArtifact(ict, artifact)
      expect(rejected.ok).toBe(false)
    }
    const missing = validateProfileArtifact(ict, {})
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.violations.map(violation => violation.at)).toEqual(['profile', 'confidence', 'sections'])
  })

  it('reports every broken contract in one pass', () => {
    const artifact = copy(artifactFor(ict))
    artifact.confidence = 4
    artifact.sections = artifact.sections.filter(section => section.heading !== 'LIQUIDITY')
    const verdict = validateProfileArtifact(ict, artifact)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(new Set(verdict.violations.map(violation => violation.rule)))
      .toEqual(new Set(['confidence-out-of-range', 'missing-section', 'section-order']))
  })
})

describe('the analystProfiles service', () => {
  it('resolves contracts, schemas, and verdicts by name', async () => {
    const ctx = new Context()
    await ctx.plugin(AnalystProfiles)
    expect(ctx.analystProfiles.list()).toEqual(['ict-analyst', 'devil-advocate'])
    expect(ctx.analystProfiles.get('devil-advocate')).toBe(advocate)
    expect(ctx.analystProfiles.outputSchema('devil-advocate')).toEqual(profileOutputSchema(advocate))
    expect(ctx.analystProfiles.validate('devil-advocate', artifactFor(advocate))).toEqual({ ok: true })
    expect(ctx.analystProfiles.validate('devil-advocate', artifactFor(ict)).ok).toBe(false)
    expect(() => ctx.analystProfiles.get('nope')).toThrow('Unknown analyst profile "nope"')
    expect(() => ctx.analystProfiles.validate('nope', {})).toThrow('Unknown analyst profile "nope"')
    expect(() => ctx.analystProfiles.outputSchema('nope')).toThrow('Unknown analyst profile "nope"')
    await ctx.fiber.dispose()
  })
})
