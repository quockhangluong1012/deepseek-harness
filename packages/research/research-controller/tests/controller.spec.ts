/**
 * The research controller through the real tool registry, the real kernel, and
 * a real storage domain: a run advances only in the loop's order, a mechanism
 * stage fails loud without its provider, claims and observations are the
 * kernel's own records, and only a grounded answer settles a run.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentKernel from '@deepseek-ai/dsh-agent-kernel'
import type { RunId, TaskId } from '@deepseek-ai/dsh-agent-kernel'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ResearchController, { ResearchError } from '../src/index.ts'
import type { Config, ResearchStageProvider, StageRequest } from '../src/index.ts'

const CAPS = { maxTextBytes: 64, maxItems: 2, maxRuns: 2 } satisfies Config

/** One observation a provider reports, as the kernel's own evidence input. */
const OBSERVATION = {
  kind: 'web',
  contentRef: 'https://example.test/spec-0',
  sourceRef: { source: 'web', locator: 'spec-0' },
  trust: 'untrusted',
} as const

/** The two statements that state a settled answer. */
const ANSWER = (claimId: string) => [
  { bucket: 'documented', statement: 'clause 4 applies', claims: [claimId] },
  { bucket: 'unresolved', statement: 'nothing contradicts it' },
]

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** Mount the loop's services, the kernel, and the controller over a memory domain. */
async function mount(options: {
  readonly taskClass?: 'research' | 'conversational'
  readonly intake?: boolean
  readonly caps?: Partial<Config>
} = {}): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  context = ctx
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend()
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  await ctx.plugin(StorageDomain, { backend: 'memory', routes: {} })
  await ctx.plugin(AgentKernel, {})
  await ctx.plugin(ResearchController, { ...CAPS, ...options.caps })
  const driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(SessionId('research-run'), { provider: 'mock', model: 'mock' }, { cwd: process.cwd() })
  if (options.intake !== false) {
    ctx.agentKernel.intake(agent, {
      objective: 'answer the question',
      agentProfile: 'default',
      taskClass: options.taskClass ?? 'research',
    })
  }
  return { ctx, agent }
}

/** One provider that performs every mechanism stage the loop delegates. */
function provider(options: {
  readonly observations?: number
  readonly onRun?: (request: StageRequest, signal: AbortSignal) => void
  readonly onSearch?: (signal: AbortSignal) => Promise<void>
} = {}): ResearchStageProvider {
  return {
    id: 'test-provider',
    stages: ['search', 'source-triage', 'contradiction-search'],
    async run(request, signal) {
      options.onRun?.(request, signal)
      if (request.stage === 'search') {
        await options.onSearch?.(signal)
        const found = Array.from({ length: options.observations ?? 1 }, (_, index) => ({
          ...OBSERVATION,
          contentRef: `https://example.test/spec-${String(index)}`,
        }))
        return { output: ['found the specification'], observations: found }
      }
      if (request.stage === 'source-triage') return { output: ['primary: https://example.test/spec-0'] }
      return { output: ['no counter-evidence was found'] }
    },
  }
}

/** Call one registered tool through the real registry pipeline. */
function call(ctx: Context, name: string, agent: Agent, args: Record<string, unknown>, callId: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name,
    arguments: args,
    agent,
  })
}

/** Read one tool result's model-facing text. */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Advance one stage, asserting the call succeeded. */
async function advance(ctx: Context, agent: Agent, args: Record<string, unknown>, callId: string): Promise<string> {
  const result = await call(ctx, 'research_advance', agent, args, callId)
  expect(result.isError, text(result)).toBe(false)
  return text(result)
}

/** Advance one stage, asserting the call failed, and return its message. */
async function refused(ctx: Context, agent: Agent, args: Record<string, unknown>, callId: string): Promise<string> {
  const result = await call(ctx, 'research_advance', agent, args, callId)
  expect(result.isError, text(result)).toBe(true)
  return text(result)
}

/** Open one run and advance it to the search stage, with the provider registered. */
async function toSearch(
  ctx: Context,
  agent: Agent,
  stageProvider: ResearchStageProvider,
): Promise<{ runId: string; report: string }> {
  await advance(ctx, agent, { stage: 'question', items: ['Does clause 4 hold?'] }, 'q')
  const runId = ctx.research.state(agent)?.runId ?? ''
  await advance(ctx, agent, { stage: 'decompose', items: ['Which clause applies?'] }, 'd')
  await advance(ctx, agent, { stage: 'research-plan', items: ['Read the specification'] }, 'p')
  ctx.research.registerStageProvider(stageProvider)
  const report = await advance(ctx, agent, { stage: 'search' }, 's')
  return { runId, report }
}

/** Open one run and advance it to the claim-extraction stage. */
async function toClaims(ctx: Context, agent: Agent): Promise<string> {
  await toSearch(ctx, agent, provider())
  await advance(ctx, agent, { stage: 'source-triage' }, 't')
  const evidenceId = String((await ctx.agentKernel.snapshot(agent))?.evidence[0]?.evidenceId ?? '')
  await advance(ctx, agent, {
    stage: 'claim-extraction',
    claims: [{ statement: 'clause 4 applies', evidence: [evidenceId], confidence: 0.6 }],
  }, 'c')
  return String((await ctx.agentKernel.snapshot(agent))?.claims[0]?.claimId ?? '')
}

/** Walk one whole run to an accepted answer and return its identity. */
async function accept(ctx: Context, agent: Agent, question: string): Promise<string> {
  await advance(ctx, agent, { stage: 'question', items: [question] }, `q:${question}`)
  const runId = ctx.research.state(agent)?.runId ?? ''
  await advance(ctx, agent, { stage: 'decompose', items: ['Which clause applies?'] }, `d:${question}`)
  await advance(ctx, agent, { stage: 'research-plan', items: ['Read the specification'] }, `p:${question}`)
  await advance(ctx, agent, { stage: 'search' }, `s:${question}`)
  await advance(ctx, agent, { stage: 'source-triage' }, `t:${question}`)
  const evidenceId = String((await ctx.agentKernel.snapshot(agent))?.evidence.at(-1)?.evidenceId ?? '')
  await advance(ctx, agent, {
    stage: 'claim-extraction',
    claims: [{ statement: 'clause 4 applies', evidence: [evidenceId], confidence: 0.6 }],
  }, `c:${question}`)
  const claimId = ctx.research.state(agent)?.stages.find(stage => stage.stage === 'claim-extraction')?.claims[0] ?? ''
  await advance(ctx, agent, { stage: 'evidence' }, `e:${question}`)
  await advance(ctx, agent, { stage: 'contradiction-search' }, `x:${question}`)
  await advance(ctx, agent, { stage: 'synthesis', sections: ANSWER(claimId) }, `n:${question}`)
  await advance(ctx, agent, { stage: 'epistemic-review' }, `r:${question}`)
  return runId
}

describe('research controller', () => {
  it('drives one run through every stage and settles a grounded answer', async () => {
    const { ctx, agent } = await mount()
    const { runId, report } = await toSearch(ctx, agent, provider())
    expect(runId).not.toBe('')
    expect(report).toContain('- search: produced by test-provider')
    expect(report).toContain('next: source-triage')

    await advance(ctx, agent, { runId, stage: 'source-triage' }, 't')
    const evidenceId = String((await ctx.agentKernel.snapshot(agent))?.evidence[0]?.evidenceId ?? '')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'evidence/recorded')).toHaveLength(1)

    await advance(ctx, agent, {
      stage: 'claim-extraction',
      claims: [{ statement: 'clause 4 applies', evidence: [evidenceId], confidence: 0.6 }],
    }, 'c')
    const claimId = String((await ctx.agentKernel.snapshot(agent))?.claims[0]?.claimId ?? '')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'claim/updated')).toHaveLength(1)

    const collected = await advance(ctx, agent, { stage: 'evidence' }, 'e')
    expect(collected).toContain('evidence: produced')
    expect(collected).toContain('web: https://example.test/spec-0')

    await advance(ctx, agent, { stage: 'contradiction-search' }, 'x')
    await advance(ctx, agent, { stage: 'synthesis', sections: ANSWER(claimId) }, 'n')
    const settled = await advance(ctx, agent, { stage: 'epistemic-review' }, 'r')
    expect(settled).toContain('next: none')
    expect(settled).toContain('answer:')
    expect(settled).toContain('documented: clause 4 applies [claims:')

    const run = ctx.research.state(agent)
    expect(run?.settledAt).not.toBeNull()
    expect(run?.answer?.documented[0]?.claims).toEqual([claimId])
    expect(run?.stages.every(stage => stage.status === 'produced')).toBe(true)
    // The run reads back from the durable domain, not from the return value.
    const read = await call(ctx, 'research_state', agent, { runId }, 'read')
    expect(read.isError).toBe(false)
    expect(text(read)).toContain(`research run ${runId} (10/10 stages produced)`)
  }, 30_000)

  it('fails loud for a stage out of order and for a mechanism stage with no provider', async () => {
    const { ctx, agent } = await mount()
    await advance(ctx, agent, { stage: 'question', items: ['Does clause 4 hold?'] }, 'q')

    expect(await refused(ctx, agent, { stage: 'synthesis' }, 'bad'))
      .toContain('is at stage "decompose"; "synthesis" cannot run before it')

    await advance(ctx, agent, { stage: 'decompose', items: ['Which clause applies?'] }, 'd')
    await advance(ctx, agent, { stage: 'research-plan', items: ['Read the specification'] }, 'p')
    expect(await refused(ctx, agent, { stage: 'search' }, 'search'))
      .toContain('no provider is registered for the "search" stage')
    expect(ctx.research.state(agent)?.stages.find(stage => stage.stage === 'search')?.status).toBe('pending')

    expect(await refused(ctx, agent, { stage: 'question', items: ['Another question?'] }, 'again'))
      .toContain('is still at an unsettled stage')
  }, 30_000)

  it('refuses a claim that cites no observation, an unrecorded one, or an impossible confidence', async () => {
    const { ctx, agent } = await mount()
    await toSearch(ctx, agent, provider())
    await advance(ctx, agent, { stage: 'source-triage' }, 't')
    const evidenceId = String((await ctx.agentKernel.snapshot(agent))?.evidence[0]?.evidenceId ?? '')

    expect(await refused(ctx, agent, {
      stage: 'claim-extraction',
      claims: [{ statement: 'clause 4 applies', evidence: [], confidence: 0.5 }],
    }, 'c0')).toContain('cites no observation')

    expect(await refused(ctx, agent, {
      stage: 'claim-extraction',
      claims: [{ statement: 'clause 4 applies', evidence: ['made-up'], confidence: 0.5 }],
    }, 'c1')).toContain('cites evidence "made-up", which this session never recorded')

    expect(await refused(ctx, agent, {
      stage: 'claim-extraction',
      claims: [{ statement: 'clause 4 applies', evidence: [evidenceId], confidence: 2 }],
    }, 'c2')).toContain('confidence 2 is outside [0, 1]')

    expect(await refused(ctx, agent, { stage: 'claim-extraction', claims: [] }, 'c3'))
      .toContain('claim-extraction states at least one claim')
    expect(await refused(ctx, agent, { stage: 'claim-extraction' }, 'c4'))
      .toContain('claim-extraction states at least one claim')
    expect(ctx.research.state(agent)?.stages.find(stage => stage.stage === 'claim-extraction')?.status).toBe('pending')
  }, 30_000)

  it('refuses an answer that leaves a recorded claim unstated, then accepts the revision', async () => {
    const { ctx, agent } = await mount()
    const claimId = await toClaims(ctx, agent)
    await advance(ctx, agent, { stage: 'evidence' }, 'e')
    await advance(ctx, agent, { stage: 'contradiction-search' }, 'x')
    await advance(ctx, agent, {
      stage: 'synthesis',
      sections: [
        { bucket: 'documented', statement: 'clause 4 applies', claims: [] },
        { bucket: 'unresolved', statement: 'nothing contradicts it', claims: [] },
      ],
    }, 'n')

    const refusal = await refused(ctx, agent, { stage: 'epistemic-review' }, 'r')
    expect(refusal).toContain('the answer was refused')
    expect(refusal).toContain('rests on no claim')
    expect(refusal).toContain(`claim "${claimId}" is stated in no bucket`)
    expect(ctx.research.state(agent)?.settledAt).toBeNull()

    await advance(ctx, agent, { stage: 'synthesis', sections: ANSWER(claimId) }, 'n2')
    const accepted = await advance(ctx, agent, { stage: 'epistemic-review' }, 'r2')
    expect(accepted).toContain('next: none')
    expect(ctx.research.state(agent)?.settledAt).not.toBeNull()
  }, 30_000)

  it('labels each synthesis statement with its bucket and refuses a citation of an unknown claim', async () => {
    const { ctx, agent } = await mount()
    const claimId = await toClaims(ctx, agent)
    await advance(ctx, agent, { stage: 'evidence' }, 'e')
    await advance(ctx, agent, { stage: 'contradiction-search' }, 'x')

    expect(await refused(ctx, agent, {
      stage: 'synthesis',
      sections: [{ bucket: 'documented', statement: 'clause 4 applies', claims: ['invented'] }],
    }, 'n0')).toContain('cites claim "invented", which this run never recorded')

    expect(await refused(ctx, agent, { stage: 'synthesis', sections: [] }, 'n1'))
      .toContain('synthesis states at least one answer statement')
    expect(await refused(ctx, agent, { stage: 'synthesis' }, 'n2b'))
      .toContain('synthesis states at least one answer statement')

    expect(await refused(ctx, agent, {
      stage: 'synthesis',
      sections: [{ bucket: 'documented', statement: '   ', claims: [claimId] }],
    }, 'n2')).toContain('an answer statement is empty')

    const report = await advance(ctx, agent, { stage: 'synthesis', sections: ANSWER(claimId) }, 'n3')
    expect(report).toContain('synthesis: produced')
    expect(report).toContain('  documented: clause 4 applies')
    expect(report).toContain('  unresolved: nothing contradicts it')
  }, 30_000)

  it('records a failed provider stage and propagates the provider error', async () => {
    const { ctx, agent } = await mount()
    await advance(ctx, agent, { stage: 'question', items: ['Does clause 4 hold?'] }, 'q')
    await advance(ctx, agent, { stage: 'decompose', items: ['Which clause applies?'] }, 'd')
    await advance(ctx, agent, { stage: 'research-plan', items: ['Read the specification'] }, 'p')
    ctx.research.registerStageProvider(provider({
      onSearch: async () => { throw new Error('search backend is down') },
    }))

    const failed = await refused(ctx, agent, { stage: 'search' }, 's')
    expect(failed).toContain('search backend is down')
    // A caller that passes no signal still runs the provider, on a fresh signal.
    await expect(ctx.research.advance(agent, { stage: 'search' })).rejects.toThrow('search backend is down')
    const search = ctx.research.state(agent)?.stages.find(stage => stage.stage === 'search')
    expect(search?.status).toBe('failed')
    expect(search?.failure).toContain('the "search" provider "test-provider" failed: search backend is down')
  }, 30_000)

  it('refuses a search that records no observation of its own', async () => {
    const { ctx, agent } = await mount()
    await toSearch(ctx, agent, provider({ observations: 0 }))
    await advance(ctx, agent, { stage: 'source-triage' }, 't')
    const recalled = ctx.agentKernel.recordEvidence(agent, {
      kind: 'file',
      contentRef: 'src/spec.md',
      sourceRef: { source: 'model', locator: 'recall' },
      trust: 'trusted',
    })
    await advance(ctx, agent, {
      stage: 'claim-extraction',
      claims: [{ statement: 'clause 4 applies', evidence: [String(recalled.evidenceId)], confidence: 0.5 }],
    }, 'c')
    expect(await refused(ctx, agent, { stage: 'evidence' }, 'e'))
      .toContain('recorded no observation of its own')
  }, 30_000)

  it('lists at most the configured number of observations and keeps every identity', async () => {
    const { ctx, agent } = await mount({ caps: { maxItems: 1 } })
    await toSearch(ctx, agent, provider({ observations: 1 }))
    await advance(ctx, agent, { stage: 'source-triage' }, 't')
    const first = String((await ctx.agentKernel.snapshot(agent))?.evidence[0]?.evidenceId ?? '')
    ctx.agentKernel.recordEvidence(agent, {
      kind: 'file',
      contentRef: 'src/spec.md',
      sourceRef: { source: 'model', locator: 'recall' },
      trust: 'trusted',
    })
    await advance(ctx, agent, {
      stage: 'claim-extraction',
      claims: [{ statement: 'clause 4 applies', evidence: [first], confidence: 0.5 }],
    }, 'c')

    const evidence = await advance(ctx, agent, { stage: 'evidence' }, 'e')
    expect(evidence).toContain('1 further observations are not listed')
    const run = ctx.research.state(agent)
    expect(run?.stages.find(stage => stage.stage === 'evidence')?.evidence).toHaveLength(2)
  }, 30_000)

  it('retains only the configured number of settled runs and reads the current one', async () => {
    const { ctx, agent } = await mount({ caps: { maxRuns: 1 } })
    ctx.research.registerStageProvider(provider())
    const first = await accept(ctx, agent, 'First question?')
    const second = await accept(ctx, agent, 'Second question?')
    expect(first).not.toBe(second)
    expect(ctx.research.state(agent)?.runId).toBe(second)

    const gone = await call(ctx, 'research_state', agent, { runId: first }, 'read')
    expect(gone.isError).toBe(true)
    expect(text(gone)).toContain(`has no research run "${first}"`)
  }, 30_000)

  it('reads the recorded runs for a caller with no live agent', async () => {
    const { ctx, agent } = await mount()
    ctx.research.registerStageProvider(provider())
    const first = await accept(ctx, agent, 'First question?')
    const second = await accept(ctx, agent, 'Second question?')

    const all = ctx.research.runs()

    expect(all.map(run => run.runId).sort()).toEqual([first, second].sort())
    expect(all[0]?.stages).toHaveLength(10)
    expect(all[0]?.settledAt).not.toBeNull()
    // The record is detached from the stored table, so a reader cannot write through it.
    expect(ctx.research.runs()[0]).not.toBe(all[0])
    expect(ctx.research.runs(String(agent.session.id))).toHaveLength(2)
    expect(ctx.research.runs('another-session')).toEqual([])
  }, 30_000)

  it('refuses a run under a task that is not a research task', async () => {
    const { ctx, agent } = await mount({ taskClass: 'conversational' })
    expect(await refused(ctx, agent, { stage: 'question', items: ['Q?'] }, 'q'))
      .toContain('the session\'s kernel task is class "conversational"')
    await ctx.fiber.dispose()
    context = undefined

    // A task/created record written before the class field existed reads as unclassified.
    const unclassified = await mount({ intake: false })
    const taskId = brandString<TaskId>('legacy-task')
    const runId = brandString<RunId>('legacy-run')
    unclassified.agent.session.append('task/created', {
      taskId,
      runId,
      objective: 'answer the question',
      constraints: [],
      acceptance: [],
      dependencies: [],
      evidence: [],
      agentProfile: 'default',
      policyProfile: 'default',
      budget: {},
      status: 'intake',
      revision: 1,
      metadata: {
        version: 1,
        runId,
        taskId,
        actor: 'kernel',
        timestamp: Date.now(),
        sourceRef: { source: 'kernel', locator: 'legacy' },
      },
    })
    expect(await refused(unclassified.ctx, unclassified.agent, { stage: 'question', items: ['Q?'] }, 'q'))
      .toContain('records no class')
  }, 30_000)

  it('reports a provider failure that is not an Error', async () => {
    const { ctx, agent } = await mount()
    await advance(ctx, agent, { stage: 'question', items: ['Does clause 4 hold?'] }, 'q')
    await advance(ctx, agent, { stage: 'decompose', items: ['Which clause applies?'] }, 'd')
    await advance(ctx, agent, { stage: 'research-plan', items: ['Read the specification'] }, 'p')
    ctx.research.registerStageProvider({
      ...provider(),
      run: async () => { throw 'the search service refused' },
    })

    expect(await refused(ctx, agent, { stage: 'search' }, 's')).toContain('the search service refused')
    expect(ctx.research.state(agent)?.stages.find(stage => stage.stage === 'search')?.failure)
      .toContain('the "search" provider "test-provider" failed: the search service refused')
  }, 30_000)

  it('fails loud without a kernel task and without a run', async () => {
    const { ctx, agent } = await mount({ intake: false })
    expect(await refused(ctx, agent, { stage: 'question', items: ['Q?'] }, 'q'))
      .toContain('has no kernel task')
    await ctx.fiber.dispose()
    context = undefined

    const second = await mount()
    expect(await refused(second.ctx, second.agent, { stage: 'decompose', items: ['A?'] }, 'd'))
      .toContain('has no research run; start one by advancing the question stage')
  }, 30_000)

  it('refuses a question that is not one line and a list over the configured caps', async () => {
    const { ctx, agent } = await mount()
    expect(await refused(ctx, agent, { stage: 'question', items: ['One?', 'Two?'] }, 'q'))
      .toContain('takes exactly one line, not 2')

    await advance(ctx, agent, { stage: 'question', items: ['Does clause 4 hold?'] }, 'q1')
    expect(await refused(ctx, agent, { stage: 'decompose', items: ['a', 'b', 'c'] }, 'd'))
      .toContain('holds 3 items, over the configured cap of 2')
    expect(await refused(ctx, agent, { stage: 'decompose', items: ['x'.repeat(70)] }, 'd2'))
      .toContain('is 70 bytes, over the configured 64-byte cap')
    expect(await refused(ctx, agent, { stage: 'decompose', items: ['   '] }, 'd3'))
      .toContain('a decompose line is empty')
    expect(await refused(ctx, agent, { stage: 'decompose' }, 'd4'))
      .toContain('the decompose stage states at least one line')
    expect(ctx.research.state(agent)?.stages.find(stage => stage.stage === 'decompose')?.status).toBe('pending')
  }, 30_000)

  it('requires an agent Session for both tools', async () => {
    const { ctx } = await mount()
    const withoutAgent = async (name: string, args: Record<string, unknown>, callId: string) =>
      await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(callId), name, arguments: args })

    expect(text(await withoutAgent('research_advance', { stage: 'question', items: ['Q?'] }, 'a')))
      .toContain('research_advance requires an agent Session')
    expect(text(await withoutAgent('research_state', {}, 'b')))
      .toContain('research_state requires an agent Session')
  }, 30_000)

  it('reports the absence of a run when nothing has started', async () => {
    const { ctx, agent } = await mount()
    const result = await call(ctx, 'research_state', agent, {}, 'read')
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('No research run in this session. Advance the question stage to start one.')
  }, 30_000)

  it('removes a provider on disposal, and refuses a duplicate, a non-mechanism stage, and an empty provider', async () => {
    const { ctx, agent } = await mount()
    await advance(ctx, agent, { stage: 'question', items: ['Does clause 4 hold?'] }, 'q')
    await advance(ctx, agent, { stage: 'decompose', items: ['Which clause applies?'] }, 'd')
    await advance(ctx, agent, { stage: 'research-plan', items: ['Read the specification'] }, 'p')

    const dispose = ctx.research.registerStageProvider(provider())
    expect(() => ctx.research.registerStageProvider(provider()))
      .toThrow(/the "search" stage already has provider "test-provider"/)
    expect(() => ctx.research.registerStageProvider({ ...provider(), id: 'agent-loop-claim', stages: ['evidence'] }))
      .toThrow(/claims the "evidence" stage, whose work is the agent loop's/)
    expect(() => ctx.research.registerStageProvider({ ...provider(), id: 'empty', stages: [] }))
      .toThrow(/provider "empty" declares no stage/)

    expect((await call(ctx, 'research_advance', agent, { stage: 'search' }, 's')).isError).toBe(false)
    dispose()
    dispose()
    expect(await refused(ctx, agent, { stage: 'source-triage' }, 't'))
      .toContain('no provider is registered for the "source-triage" stage')
  }, 30_000)

  it('hands a cancelled call to the provider and fails the stage with its error', async () => {
    const { ctx, agent } = await mount()
    const cancelled: boolean[] = []
    const cancelling = provider({
      onSearch: async (signal) => {
        cancelled.push(signal.aborted)
        if (signal.aborted) throw new Error('the search was cancelled')
      },
    })
    await advance(ctx, agent, { stage: 'question', items: ['Does clause 4 hold?'] }, 'q')
    await advance(ctx, agent, { stage: 'decompose', items: ['Which clause applies?'] }, 'd')
    await advance(ctx, agent, { stage: 'research-plan', items: ['Read the specification'] }, 'p')
    ctx.research.registerStageProvider(cancelling)

    const controller = new AbortController()
    controller.abort()
    await expect(ctx.research.advance(agent, { stage: 'search' }, controller.signal)).rejects.toThrow('the search was cancelled')
    expect(cancelled).toEqual([true])
    const search = ctx.research.state(agent)?.stages.find(stage => stage.stage === 'search')
    expect(search?.status).toBe('failed')
    expect(search?.failure).toContain('the search was cancelled')
  }, 30_000)

  it('exposes the failure taxonomy through ResearchError', () => {
    const error = new ResearchError('run-not-found', 'research: no run')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ResearchError')
    expect(error.code).toBe('run-not-found')
  })
})
