import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest, SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as commandReview from '../src/index.ts'

/** Build a live idle agent, matching the command-goal test's fixture shape. */
function stubAgent(ctx: Context, id: string): { agent: Agent; session: Session } {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = createInboxStub()
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { this.inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

/** Captures the last start request and answers with a scripted result. */
class FakeReviewProvider implements SubagentProvider {
  readonly name = 'fake-review'
  readonly capabilities = {
    agentOptions: true,
    outputSchema: true,
    depthLimit: false,
    toolFilter: false,
    persona: false,
    workerLimits: false,
  }
  readonly inheritsParentContext = false
  lastRequest: ResolvedSubagentStartRequest | undefined
  disposed = false
  private result: SubagentResult = { output: [], stopReason: 'completed', structured: { summary: 'no issues', findings: [] } }
  private startError: Error | undefined

  scriptResult(result: SubagentResult): void { this.result = result }
  scriptStartError(error: Error): void { this.startError = error }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.lastRequest = request
    if (this.startError !== undefined) throw this.startError
    const result = this.result
    return {
      id: SessionId('fake-review-child'),
      localAgent: undefined,
      result: Promise.resolve(result),
      dispose: () => { this.disposed = true; return Promise.resolve() },
    }
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly provider: FakeReviewProvider
}

async function harness(config: commandReview.Config = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SubagentRuntime)
  const provider = new FakeReviewProvider()
  ctx.subagents.registerProvider(provider)
  // Object.assign: the Config interface shares its name with the schema value,
  // which trips no-misused-spread's class-instance check.
  await ctx.plugin(commandReview, Object.assign({ subagentProvider: 'fake-review' }, config))
  const { agent } = stubAgent(ctx, `command-review-${Math.random()}`)
  return { ctx, agent, provider }
}

async function executeCommand(test: Harness, line: string) {
  const execution = await test.ctx.commands.execute(test.agent, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`command was not registered: ${line}`)
  return execution
}

async function run(test: Harness, suffix = '', command = '/review'): Promise<string> {
  const execution = await executeCommand(test, `${command}${suffix}`)
  const result = execution.result
  if (result.kind === 'error') return `ERROR: ${result.text}`
  return result.text ?? ''
}

/** The task prompt the fake provider last received, or a failure when it sent none. */
function lastPrompt(test: Harness): string {
  const block = test.provider.lastRequest?.prompt[0]
  if (block === undefined || block.type !== 'text') throw new Error('the reviewer received no text prompt')
  return block.text
}

describe('@deepseek-ai/dsh-command-review', () => {
  it('registers the review command with Loader-safe exports and disposes it', async () => {
    expect(commandReview.name).toBe('command-review')
    expect(commandReview.inject).toEqual(['commands', 'subagents'])
    const test = await harness()
    const registered = test.ctx.commands.list(test.agent)
    expect(registered).toContainEqual(expect.objectContaining({ name: 'review' }))
    expect(registered).toContainEqual(expect.objectContaining({ name: 'security-review' }))
  })

  it('asks the reviewer to inspect uncommitted changes when no ref is given', async () => {
    const test = await harness()
    await run(test)
    expect(test.provider.lastRequest?.prompt).toEqual([
      { type: 'text', text: expect.stringContaining('uncommitted working-tree changes') as unknown },
    ])
  })

  it('asks the reviewer to inspect the diff against a given ref', async () => {
    const test = await harness()
    await run(test, ' main')
    const text = lastPrompt(test)
    expect(text).toContain('"main"')
    expect(text).toContain('git diff main')
  })

  it('renders findings grouped by severity, high first', async () => {
    const test = await harness()
    test.provider.scriptResult({
      output: [],
      stopReason: 'completed',
      structured: {
        summary: 'Two issues found.',
        findings: [
          { file: 'a.ts', line: '10', severity: 'low', message: 'minor nit' },
          { file: 'b.ts', line: '20-25', severity: 'high', message: 'SQL injection risk' },
        ],
      },
    })
    const text = await run(test)
    const highIndex = text.indexOf('[high]')
    const lowIndex = text.indexOf('[low]')
    expect(highIndex).toBeGreaterThan(-1)
    expect(lowIndex).toBeGreaterThan(highIndex)
    expect(text).toContain('b.ts:20-25 — SQL injection risk')
    expect(text).toContain('a.ts:10 — minor nit')
  })

  it('reports "No findings." when the reviewer finds nothing', async () => {
    const test = await harness()
    test.provider.scriptResult({ output: [], stopReason: 'completed', structured: { summary: 'Clean diff.', findings: [] } })
    const text = await run(test)
    expect(text).toContain('Clean diff.')
    expect(text).toContain('No findings.')
  })

  it('errors when the reviewer does not complete', async () => {
    const test = await harness()
    test.provider.scriptResult({ output: [], stopReason: 'max-tokens', diagnostic: 'ran out of budget' })
    const text = await run(test)
    expect(text).toContain('ERROR')
    expect(text).toContain('max-tokens')
    expect(text).toContain('ran out of budget')
  })

  it('errors when the reviewer completes without a structured report', async () => {
    const test = await harness()
    test.provider.scriptResult({ output: [], stopReason: 'completed' })
    const text = await run(test)
    expect(text).toContain('ERROR')
    expect(text).toContain('without returning a structured report')
  })

  it('errors when the provider fails to start', async () => {
    const test = await harness()
    test.provider.scriptStartError(new Error('provider unavailable'))
    const text = await run(test)
    expect(text).toContain('ERROR')
    expect(text).toContain('provider unavailable')
  })

  it('always disposes the run', async () => {
    const test = await harness()
    await run(test)
    expect(test.provider.disposed).toBe(true)
  })

  it('passes provider and model overrides as agentOptions', async () => {
    const test = await harness({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    await run(test)
    expect(test.provider.lastRequest?.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  })

  it('omits agentOptions entirely when no override is configured', async () => {
    const test = await harness()
    await run(test)
    expect(test.provider.lastRequest?.agentOptions).toBeUndefined()
  })

  it('shows usage text for --help without starting a reviewer', async () => {
    const test = await harness()
    const text = await run(test, ' --help')
    expect(text).toContain('Usage: /review')
    expect(test.provider.lastRequest).toBeUndefined()
  })

  it('records one durable review/report event and cites it from the command outcome', async () => {
    const test = await harness()
    const report = {
      summary: 'One issue found.',
      findings: [{ file: 'b.ts', line: '20-25', severity: 'high', message: 'SQL injection risk' }],
    }
    test.provider.scriptResult({ output: [], stopReason: 'completed', structured: report })
    const execution = await executeCommand(test, '/review')
    const seq = execution.result.kind === 'success' ? execution.result.sourceEventSeq : undefined
    if (seq === undefined) throw new Error('the command outcome cited no recorded report')
    const event = test.agent.session.eventAt(seq)
    expect(event?.type).toBe('review/report')
    expect(event?.data).toEqual({
      commandId: execution.commandId,
      kind: 'code',
      target: '',
      summary: report.summary,
      findings: report.findings,
    })
  })

  it('uses a security prompt against the same report schema for /security-review', async () => {
    const test = await harness()
    await run(test, '', '/security-review')
    const text = lastPrompt(test)
    expect(text).toContain('independent security reviewer')
    expect(text).toContain('uncommitted working-tree changes')
    expect(text).toContain('injection')
    expect(text).not.toContain('Do not report style preferences')
    expect(test.provider.lastRequest?.outputSchema).toEqual(commandReview.REVIEW_OUTPUT_SCHEMA)
  })

  it('reviews a named ref for security and records its kind and target', async () => {
    const test = await harness()
    test.provider.scriptResult({
      output: [],
      stopReason: 'completed',
      structured: { summary: 'No security defects.', findings: [] },
    })
    const execution = await executeCommand(test, '/security-review main')
    const seq = execution.result.kind === 'success' ? execution.result.sourceEventSeq : undefined
    if (seq === undefined) throw new Error('the command outcome cited no recorded report')
    expect(test.agent.session.eventAt(seq)?.data).toMatchObject({ kind: 'security', target: 'main', findings: [] })
  })

  it('shows security usage text for /security-review --help', async () => {
    const test = await harness()
    const text = await run(test, ' --help', '/security-review')
    expect(text).toContain('Usage: /security-review')
    expect(test.provider.lastRequest).toBeUndefined()
  })
})
