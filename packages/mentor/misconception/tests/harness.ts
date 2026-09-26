import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent, AgentCancelCause, InboxTarget } from '@deepseek-ai/dsh-agent'
import type { EvidenceId, TaskClaim, TaskClaimId, TaskClaimInput } from '@deepseek-ai/dsh-agent-kernel'
import { brandString } from '@deepseek-ai/dsh-brand'
import LearnerModel, { CaseReference, LearnerId } from '@deepseek-ai/dsh-learner-model'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import MisconceptionEngine from '../src/index.ts'
import type { MisconceptionId, MisconceptionPattern } from '../src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

export const signal = new AbortController().signal

/** The thesis the fixture learner states, exactly as the spec's example quotes it. */
export const THESIS = 'MSS happened, therefore the entry is valid.'

/** One observation contradicting that thesis. */
export const EVIDENCE = brandString<EvidenceId>('ev-h1-mss-into-supply')

/** The catalogued misconception the fixture deployment declares. */
export const MSS_PATTERN: MisconceptionPattern = {
  id: 'mss-standalone-entry',
  misconception: 'MSS treated as a standalone entry criterion',
  designError: 'MSS confirms structure; it is not an entry trigger until a PD-array test follows it',
  objective: 'Place MSS inside a full entry model before taking an entry',
  triggers: ['MSS happened', 'therefore the entry is valid'],
  explanation: 'An MSS marks a shift in delivery, not permission to enter.',
  counterexample: 'EURUSD H1 printed an MSS into a supply zone and reversed from it.',
  exercise: 'Mark the last three MSS on EURUSD H1 and name the PD-array test that followed each.',
}

/** One recorded claim, as the stub kernel kept it. */
export interface RecordedClaim extends TaskClaimInput {
  readonly claimId: string
}

/** The kernel surface the engine uses, kept as a stub so a detection can be read back. */
export interface StubKernel {
  readonly claims: RecordedClaim[]
  recordClaim(agent: Agent, input: TaskClaimInput): TaskClaim
}

/** A kernel that records every claim it is handed. */
export function stubKernel(): StubKernel {
  const claims: RecordedClaim[] = []
  return {
    claims,
    recordClaim(_agent, input) {
      const claimId = `claim-${claims.length + 1}`
      claims.push({ ...input, claimId })
      return {
        claimId: brandString<TaskClaimId>(claimId),
        statement: input.statement,
        evidence: input.evidence ?? [],
        confidence: input.confidence,
        status: input.status ?? 'proposed',
      }
    },
  }
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

/** One booted engine over a memory-backed domain and a real learner record. */
export interface MisconceptionHarness {
  readonly ctx: Context
  readonly engine: MisconceptionEngine
  readonly agent: Agent
  readonly kernel: StubKernel
  readonly learnerId: LearnerId
  readonly fiber: Fiber
}

/**
 * Boot the engine over real storage, a real learner record, and a stub kernel.
 * @param patterns - the catalogue the engine runs with.
 * @param withKernel - whether an agent kernel is mounted at all.
 * @returns the booted engine, its agent stub, and its fiber.
 */
export async function bootMisconception(
  patterns: readonly MisconceptionPattern[] = [MSS_PATTERN],
  withKernel = true,
): Promise<MisconceptionHarness> {
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
  const fiber = await ctx.plugin(MisconceptionEngine, { patterns: [...patterns] })
  return {
    ctx,
    engine: ctx.misconception,
    agent: stubAgent(ctx, 'mentor-misconception'),
    kernel,
    learnerId: LearnerId('learner-1'),
    fiber,
  }
}

/** Walk one pipeline from its first stage to `reassess`, returning the occurrence id. */
export async function advanceToReassess(harness: MisconceptionHarness): Promise<MisconceptionId> {
  const detection = await harness.engine.detect({
    agent: harness.agent,
    learnerId: harness.learnerId,
    thesis: THESIS,
    evidence: [EVIDENCE],
  })
  const misconceptionId = detection.misconceptionId
  await harness.engine.advance({ misconceptionId, fact: { kind: 'delivered' } })
  await harness.engine.advance({ misconceptionId, fact: { kind: 'delivered' } })
  await harness.engine.advance({ misconceptionId, fact: { kind: 'attempted', attempt: 'My reading of the exercise.' } })
  await harness.engine.advance({
    misconceptionId,
    fact: { kind: 'case-selected', caseId: CaseReference('case-eurusd') },
  })
  return misconceptionId
}
