import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, {
  admitSkill,
  capabilitiesWithin,
  type SkillCandidate,
  type SkillDefinition,
  type SkillLookupOptions,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

function candidate(name: string, overrides: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    name,
    description: `${name} description`,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'memory',
    source: 'memory',
    rank: 0,
    locator: { content: `${name} body.` },
    ...overrides,
  }
}

class MemoryProvider implements SkillProvider {
  name = 'memory'
  constructor(private readonly candidates: SkillCandidate[]) {}
  /** Rename this provider so a test can mount a second one beside it. */
  withName(name: string): this {
    this.name = name
    return this
  }
  list(_options: SkillLookupOptions): Promise<SkillCandidate[]> {
    return Promise.resolve(this.candidates)
  }
  get(skill: SkillCandidate): Promise<SkillDefinition | undefined> {
    return Promise.resolve({ ...skill, content: (skill.locator as { content: string }).content })
  }
}

/** A registry over one provider, plus the skill names counted as quarantined. */
async function mounted(candidates: SkillCandidate[]): Promise<{ ctx: Context; quarantined: number[] }> {
  const ctx = new Context()
  const quarantined: number[] = []
  ctx.on('skills/change', payload => { quarantined.push(payload.quarantinedCount) })
  await ctx.plugin(SkillRegistry, {})
  ctx.skills.registerProvider(() => new MemoryProvider(candidates))
  return { ctx, quarantined }
}

describe('skill admission gate', () => {
  it('refuses a quarantined skill whatever the caller holds', () => {
    const verdict = admitSkill({ admission: 'quarantined', capabilities: ['fs.read'], granted: ['fs.read'] })

    expect(verdict.admitted).toBe(false)
    expect(verdict.reasons).toEqual(['the provider quarantined this skill'])
  })

  it('refuses untrusted content that no review admitted', () => {
    expect(admitSkill({ trust: 'untrusted' }).admitted).toBe(false)
    expect(admitSkill({ trust: 'untrusted' }).reasons[0]).toContain('needs an explicit admission')
    expect(admitSkill({ trust: 'untrusted', admission: 'user-approved' }).admitted).toBe(true)
    expect(admitSkill({ trust: 'untrusted', admission: 'project-reviewed' }).admitted).toBe(true)
    expect(admitSkill({ trust: 'trusted' }).admitted).toBe(true)
  })

  it('lets a skill narrow the caller s grant but never widen it', () => {
    expect(capabilitiesWithin(['fs.read'], ['fs.read', 'process.exec'])).toBe(true)
    expect(capabilitiesWithin(['network.write'], ['fs.read'])).toBe(false)
    expect(capabilitiesWithin(['network.write'], undefined)).toBe(true)

    const widened = admitSkill({ capabilities: ['network.write'], granted: ['fs.read'] })
    expect(widened.admitted).toBe(false)
    expect(widened.reasons).toEqual(['capability "network.write" is outside the authority this caller holds'])

    expect(admitSkill({ capabilities: ['fs.read'], granted: ['fs.read', 'process.exec'] }).admitted).toBe(true)
    expect(admitSkill({ capabilities: ['fs.read'] }).admitted).toBe(true)
  })
})

describe('registry quarantine', () => {
  it('neither advertises nor loads a quarantined candidate, and counts it', async () => {
    const held = candidate('held')
    const { ctx, quarantined } = await mounted([
      held,
      candidate('risky', { admission: 'quarantined', trust: 'untrusted' }),
    ])

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['held'])
    await expect(ctx.skills.get('risky')).resolves.toBeUndefined()
    // The count is published on the next catalog change; collection itself
    // already counted the quarantined candidate.
    ctx.skills.registerProvider(() => new MemoryProvider([]).withName('second'))
    expect(quarantined.at(-1)).toBe(1)
  })

  it('advertises a reviewed project skill with its admission and source digest', async () => {
    const { ctx } = await mounted([
      candidate('reviewed', {
        admission: 'project-reviewed',
        trust: 'untrusted',
        sourceDigest: 'a'.repeat(64),
        rollbackArtifact: 'skills/reviewed.previous.md',
      }),
    ])

    const [summary] = await ctx.skills.list()
    expect(summary).toMatchObject({
      name: 'reviewed',
      admission: 'project-reviewed',
      trust: 'untrusted',
      sourceDigest: 'a'.repeat(64),
      rollbackArtifact: 'skills/reviewed.previous.md',
    })
    expect(await ctx.skills.get('reviewed')).toMatchObject({ admission: 'project-reviewed' })
  })
})
