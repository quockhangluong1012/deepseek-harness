/**
 * The agent-backed criterion verifiers' behavior: which families they claim, and
 * what one criterion's verdict is after its reviewer settles. Every case drives
 * the real `@deepseek-ai/dsh-agent` initiator boundary and a stub `subagents`
 * service, so the spawn path under test is the one production uses.
 */
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AcceptanceCriterion, TaskId, VerificationRequest } from '@deepseek-ai/dsh-agent-kernel'
import { brandString } from '@deepseek-ai/dsh-brand'
import { REVIEW_OUTPUT_SCHEMA } from '@deepseek-ai/dsh-command-review'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { SUPPORTED_FAMILIES } from '../src/families.ts'
import type { Config } from '../src/index.ts'
import { AgentCriterionVerifier } from '../src/verifier.ts'

/** The `subagents` service under test's control: it records every start and replies as the case says. */
class StubSubagents extends Service {
  /** Every start request the verifier made, in order. */
  readonly starts: SubagentStartRequest[] = []

  /**
   * @param ctx - the context to register the service in.
   * @param reply - how one start settles, from the count of starts so far.
   */
  constructor(ctx: Context, private readonly reply: (started: number) => Promise<SubagentResult> | SubagentResult) {
    super(ctx, 'subagents')
  }

  /**
   * Record one start and settle it as the case says.
   * @param _name - the provider name the caller selected.
   * @param request - the start request the caller made.
   * @returns the settled run.
   */
  async start(_name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    this.starts.push(request)
    const result = await this.reply(this.starts.length)
    return {
      id: SessionId(`reviewer-${String(this.starts.length)}`),
      localAgent: undefined,
      result: Promise.resolve(result),
      dispose: () => Promise.resolve(),
    }
  }
}

/** One settled reviewer result carrying a structured report. */
function completed(structured: unknown): SubagentResult {
  return { output: [], structured, stopReason: 'completed' }
}

/** One acceptance criterion of the given family. */
function criterion(verifier: AcceptanceCriterion['verifier'], id: string = verifier): AcceptanceCriterion {
  return { id, description: `${id} must hold`, verifier, required: true }
}

/** One verification request over the given criteria. */
function request(criteria: readonly AcceptanceCriterion[], changedScopes: readonly string[] = []): VerificationRequest {
  return { taskId: brandString<TaskId>('task-1'), revision: 1, criteria, changedScopes, repositoryDigest: 'digest-1' }
}

/** A directly constructed Agent, so the initiator boundary has one to carry. */
function stubAgent(ctx: Context): Agent {
  const id = SessionId('agent-verifiers-agent')
  const scope = ctx.plugin(() => {})
  return {
    id,
    options: {},
    session: Session.create(id),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/**
 * Mount the agents registry, a stub subagents service, and one agent.
 * @param reply - how one reviewer start settles.
 * @param config - the deployment configuration the verifier reads.
 * @returns the context, the stub service, the agent, and the verifier.
 */
async function rig(
  reply: (started: number) => Promise<SubagentResult> | SubagentResult,
  config: Config = {},
): Promise<{ ctx: Context; subagents: StubSubagents; agent: Agent; verifier: AgentCriterionVerifier }> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const subagents = new StubSubagents(ctx, reply)
  const agent = stubAgent(ctx)
  return { ctx, subagents, agent, verifier: new AgentCriterionVerifier(ctx, config) }
}

describe('agent-backed criterion verifiers', () => {
  it('claims exactly the review, security, and browser families', async () => {
    const { verifier } = await rig(() => completed({ summary: 'ok', findings: [] }))
    expect(SUPPORTED_FAMILIES).toEqual(['security', 'browser', 'review'])
    for (const family of SUPPORTED_FAMILIES) expect(verifier.supports(criterion(family))).toBe(true)
    for (const family of ['test', 'build', 'lint', 'typecheck', 'diff', 'assertion', 'human', 'research'] as const) {
      expect(verifier.supports(criterion(family)), `${family} is not an agent-backed family`).toBe(false)
    }
  })

  it('answers nothing for a criterion it does not claim', async () => {
    const { ctx, subagents, agent, verifier } = await rig(() => completed({ summary: 'ok', findings: [] }))
    const unclaimed = criterion('test')

    const verdict = await ctx.agents.withInitiator(agent, () => verifier.verify(request([unclaimed]), unclaimed))
    expect(verdict).toBeUndefined()
    expect(subagents.starts).toEqual([])
  })

  it('fails a review criterion on a finding at or above the severity floor', async () => {
    const { ctx, subagents, agent, verifier } = await rig(() => completed({
      summary: 'the change drops an authorization check',
      findings: [{ file: 'src/a.ts', line: '12', severity: 'high', message: 'missing authorization' }],
    }))
    const subject = criterion('review')

    const verdict = await ctx.agents.withInitiator(agent, () => verifier.verify(request([subject], ['src/a.ts']), subject))
    expect(verdict?.result).toMatchObject({ criterionId: 'review', status: 'fail', evidence: ['src/a.ts'] })
    expect(verdict?.result.detail).toContain('1 finding(s) at or above high')
    expect(verdict?.result.detail).toContain('[high] src/a.ts:12 — missing authorization')
    expect(subagents.starts).toHaveLength(1)
  })

  it('passes a criterion whose findings stay below the configured floor', async () => {
    const { ctx, agent, verifier } = await rig(
      () => completed({ summary: 'one nit', findings: [{ file: 'src/a.ts', severity: 'low', message: 'unclear name' }] }),
      { minSeverity: 'medium' },
    )
    const subject = criterion('review')

    const verdict = await ctx.agents.withInitiator(agent, () => verifier.verify(request([subject]), subject))
    expect(verdict?.result.status).toBe('pass')
    expect(verdict?.result.detail).toContain('no finding at or above medium')
  })

  it('starts exactly one reviewer with the family prompt, schema, and parent', async () => {
    const { ctx, subagents, agent, verifier } = await rig(() => completed({ summary: 'no defect', findings: [] }))
    const subject = criterion('security')

    const verdict = await ctx.agents.withInitiator(agent, () => verifier.verify(request([subject], ['src/b.ts']), subject))
    expect(verdict?.result.status).toBe('pass')
    expect(subagents.starts).toHaveLength(1)
    const [start] = subagents.starts
    expect(start?.label).toBe('security-review')
    expect(start?.outputSchema).toEqual(REVIEW_OUTPUT_SCHEMA)
    expect(start?.parent).toBe(agent)
    const prompt = start?.prompt.map(block => block.type === 'text' ? block.text : '').join('') ?? ''
    expect(prompt).toContain('independent security reviewer')
    expect(prompt).toContain('Acceptance criterion "security": security must hold')
  })

  it('decides a browser criterion from the scenario report the reviewer returned', async () => {
    const { ctx, subagents, agent, verifier } = await rig(() => completed({
      passed: false,
      detail: 'the save button reloaded the page instead of saving',
      evidence: ['http://localhost:3000/settings'],
    }))
    const subject = criterion('browser')

    const verdict = await ctx.agents.withInitiator(agent, () => verifier.verify(request([subject], ['app/settings.tsx']), subject))
    expect(verdict?.result).toMatchObject({
      criterionId: 'browser',
      status: 'fail',
      evidence: ['http://localhost:3000/settings'],
      detail: 'the save button reloaded the page instead of saving',
    })
    expect(subagents.starts[0]?.label).toBe('browser-check')
  })

  it('fails a criterion whose reviewer finished without a report of its family shape', async () => {
    const { ctx, agent, verifier } = await rig(() => completed('not a report'))
    const subject = criterion('browser')

    const verdict = await ctx.agents.withInitiator(agent, () => verifier.verify(request([subject]), subject))
    expect(verdict?.result.status).toBe('fail')
    expect(verdict?.result.detail).toBe('the browser verifier finished without a scenario report stating whether the scenario held')
  })

  it('fails a criterion whose reviewer did not finish', async () => {
    const { ctx, agent, verifier } = await rig(() => ({ output: [], stopReason: 'error', diagnostic: 'provider refused' }))
    const subject = criterion('review')

    const verdict = await ctx.agents.withInitiator(agent, () => verifier.verify(request([subject], ['src/a.ts']), subject))
    expect(verdict?.result.status).toBe('fail')
    expect(verdict?.result.detail).toBe('the independent reviewer did not finish (error): provider refused')
    expect(verdict?.result.evidence).toEqual(['src/a.ts'])
  })

  it('fails a criterion whose reviewer could not start', async () => {
    const { ctx, agent, verifier } = await rig(() => { throw new Error('no such provider') })
    const subject = criterion('review')

    const verdict = await ctx.agents.withInitiator(agent, () => verifier.verify(request([subject], ['src/a.ts']), subject))
    expect(verdict?.result.status).toBe('fail')
    expect(verdict?.result.detail).toContain('the independent reviewer could not be started')
    expect(verdict?.result.detail).toContain('no such provider')
  })

  it('fails a criterion an agentless verification cannot start a reviewer for', async () => {
    const { subagents, verifier } = await rig(() => completed({ summary: 'ok', findings: [] }))
    const subject = criterion('review')

    const verdict = await verifier.verify(request([subject]), subject)
    expect(verdict?.result).toMatchObject({ status: 'fail', evidence: [] })
    expect(verdict?.result.detail).toBe('no initiating agent is active, so no independent reviewer could be started for this criterion')
    expect(subagents.starts).toEqual([])
  })

  it('decides every criterion of one request from its own reviewer', async () => {
    const { ctx, subagents, agent, verifier } = await rig(started => completed(started === 1
      ? { passed: true, detail: 'the page saved' }
      : { summary: 'no defect', findings: [] }))
    const criteria = [criterion('browser', 'scenario'), criterion('review', 'code')]
    const subject = request(criteria, ['app/settings.tsx'])

    const verdicts = await ctx.agents.withInitiator(agent, async () => {
      const collected: unknown[] = []
      for (const single of criteria) collected.push(await verifier.verify(subject, single))
      return collected
    })
    expect(verdicts).toHaveLength(2)
    expect(subagents.starts).toHaveLength(2)
    expect(subagents.starts.map(start => start.label)).toEqual(['browser-check', 'review'])
  })
})
