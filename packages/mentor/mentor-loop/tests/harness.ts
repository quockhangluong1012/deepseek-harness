import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent, AgentCancelCause, InboxTarget } from '@deepseek-ai/dsh-agent'
import type { KernelView, TaskClaim, TaskClaimId, TaskClaimInput } from '@deepseek-ai/dsh-agent-kernel'
import { brandString } from '@deepseek-ai/dsh-brand'
import LearnerModel, { LearnerId } from '@deepseek-ai/dsh-learner-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import MisconceptionEngine from '@deepseek-ai/dsh-misconception'
import type { MisconceptionPattern } from '@deepseek-ai/dsh-misconception'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import MentorLoop from '../src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

export const signal = new AbortController().signal

/** The learner the fixture deployment mentors. */
export const LEARNER = 'learner-1'

/** The thesis the fixture learner states, exactly as the spec's example quotes it. */
export const THESIS = 'MSS happened, therefore the entry is valid.'

/** Turns the same misconception back on after the mentor taught it. */
export const REPEATED_THESIS = 'MSS happened again on the H4, so the entry still stands.'

/** Turns the misconception off after the mentor taught it. */
export const RESOLVED_THESIS = 'The MSS only confirmed structure; I waited for the demand-array test before entering.'

/** The recorded observation the learner's own claim does not cite. */
export const COUNTER_EVIDENCE = 'ev-eurusd-h1-mss-into-supply'

/** The catalogued misconception the fixture deployment declares. */
export const MSS_PATTERN: MisconceptionPattern = {
  id: 'mss-standalone-entry',
  misconception: 'MSS treated as a standalone entry criterion',
  designError: 'MSS confirms structure; it is not an entry trigger until a PD-array test follows it',
  objective: 'Place MSS inside a full entry model before taking an entry',
  triggers: ['MSS happened', 'the entry is valid'],
  explanation: 'An MSS marks a shift in delivery, not permission to enter.',
  counterexample: 'EURUSD H1 printed an MSS into a supply zone and reversed from it.',
  exercise: 'Mark the last three MSS on EURUSD H1 and name the PD-array test that followed each.',
}

/** The kernel surface the loop uses, kept as a stub so the session view can be set per test. */
export interface StubKernel {
  /** Observations the session recorded. */
  recorded: string[]
  /** Claims the session asserted, each citing evidence identities. */
  claims: TaskClaimInput[]
  readonly state: { view(session: unknown): KernelView | undefined }
  recordClaim(agent: Agent, input: TaskClaimInput): TaskClaim
}

/** A kernel stub whose session view reports whatever the test set. */
export function stubKernel(): StubKernel {
  const kernel: StubKernel = {
    recorded: [],
    claims: [],
    state: {
      view: () => ({
        task: { taskId: 'task-1' },
        claims: kernel.claims.map((claim, index) => ({
          claimId: `claim-${index + 1}`,
          statement: claim.statement,
          evidence: claim.evidence ?? [],
          confidence: claim.confidence,
          status: claim.status ?? 'proposed',
        })),
        evidence: kernel.recorded.map(evidenceId => ({ evidenceId })),
      } as never),
    },
    recordClaim(_agent, input) {
      const claimId = `claim-${kernel.claims.length + 1}`
      kernel.claims.push(input)
      return {
        claimId: brandString<TaskClaimId>(claimId),
        statement: input.statement,
        evidence: input.evidence ?? [],
        confidence: input.confidence,
        status: input.status ?? 'proposed',
      }
    },
  }
  return kernel
}

/** An Agent stub over a real session, with no driver behind it. */
export function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  return {
    id: session.id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: new Context(),
    send(_message: UserMessage, _target: InboxTarget, _wakeup: boolean) {},
    runMaintenance: task => task(signal),
    cancel(_cause: AgentCancelCause) {},
    whenIdle: () => Promise.resolve(),
    followup(_message: UserMessage) {},
    steer(_message: UserMessage) {},
    inject(_message: UserMessage) {},
  }
}

/** Append one identified message to the session log, as the loop or the learner would. */
export function say(agent: Agent, text: string, source: MessageSource = { kind: 'user' }): UserMessage {
  const message = createUserMessage({ content: [{ type: 'text', text }], source })
  agent.session.append('user/message', message, { surfaceOp: 'append' })
  return message
}

/** The text of one message, as the model would read it. */
export function textOf(message: UserMessage): string {
  let text = ''
  for (const block of message.content) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/** One booted mentor loop over real storage, a real learner record, the real engine, and a stub kernel. */
export interface MentorLoopHarness {
  readonly ctx: Context
  readonly loop: MentorLoop
  readonly agent: Agent
  readonly kernel: StubKernel
  readonly learnerId: LearnerId
  readonly fiber: Fiber
}

/**
 * Boot the mentor loop over the seams it consumes.
 * @param learnerId - the learner every session on the context mentors.
 * @param withKernel - whether an agent kernel is mounted at all.
 * @returns the booted loop, its agent stub, its kernel stub, and its fiber.
 */
export async function bootMentorLoop(
  learnerId = LEARNER,
  withKernel = true,
): Promise<MentorLoopHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const kernel = stubKernel()
  if (withKernel) ctx.provide('agentKernel', kernel as never)
  await ctx.plugin(LearnerModel)
  await ctx.plugin(MisconceptionEngine, { patterns: [MSS_PATTERN] })
  const fiber = await ctx.plugin(MentorLoop, { learnerId })
  return {
    ctx,
    loop: ctx.mentorLoop,
    agent: stubAgent(ctx, 'mentor-session'),
    kernel,
    learnerId: LearnerId(learnerId),
    fiber,
  }
}

/** Drive one pre-step through the registered waterfall listeners. */
export async function preStep(
  ctx: Context,
  agent: Agent,
): Promise<{ messages: UserMessage[] }> {
  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 1, signal },
    async () => ({ kind: 'enter' as const, messages: [] }),
  )
  return decision.kind === 'enter' ? { messages: [...decision.messages] } : { messages: [] }
}
