/**
 * @deepseek-ai/dsh-headless — one-shot direct Agent driver. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates one Agent through the core registry (or adopts the Session a
 * `--session-id`, `--resume`, or `--continue` names), applies the run flags to
 * that Agent's own scope (model, system prompt, tool allow list, step ceiling,
 * structured result) and to its Session's permission, drives the task to
 * quiescence, streams provider reasoning to stderr, flushes its Session, prints
 * the final assistant text (or the structured result) to stdout, and exits.
 * With `--json` it projects the run as newline-delimited events instead. A task
 * that is a command line (`/name [input]`) dispatches through the mounted
 * command registry instead of the model, like the SDK and Web adapters do.
 *
 * @module @deepseek-ai/dsh-headless
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { attachStructuredRuntime } from '@deepseek-ai/dsh-subagent-in-process-driver'
import type { StructuredAttachment } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
// Empty type imports carry the loader Context merge for the settlement await,
// the cmdline Context merge for the appExit host value, the sessionQuery
// Context merge for Session adoption, the permissionPresets merge for the
// permission flag's write, and the system-prompt/tools merges for the
// Agent-scoped run options.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { internals } from './runner-internals.ts'
import { projectJsonRun, boundJsonLine } from './json-stream.ts'

/** Stable Cordis plugin name. */
export const name = 'headless-runner'

/** Core services required before the one-shot turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the task and run options resolved from this app's injected provider service. */
export interface Config {
  /** The prompt text for the single run; absent when the task arrives on stdin. */
  task?: string
  /** Exact Session identity to adopt; absent for a fresh random identity. An id with no stored Session fails. */
  sessionId?: string
  /** Whether stdout carries the machine-readable event stream instead of final text. */
  json?: boolean
  /** Model id overriding the deployment default selection; absent keeps the composed selection. */
  model?: string
  /** Permission preset pinning this run's Session; absent keeps the composed default. */
  permissionMode?: string
  /** Ceiling on assistant steps this run's turn may enter; absent keeps the composed loop ceiling. */
  maxTurns?: number
  /** Text replacing this run's system prompt; absent keeps the composed prompt. */
  systemPrompt?: string
  /** Global tool names this run keeps visible; absent admits every composed tool. */
  allowedTools?: string[]
  /** Object-rooted JSON Schema the run's final answer must satisfy; absent reports the final text. */
  outputSchema?: ObjectJsonSchema
  /** Whether to adopt the newest Session recorded in this working directory. */
  continueLatest?: boolean
}

export const Config: z<Config> = z.object({
  task: z.string(),
  sessionId: z.string(),
  json: z.boolean(),
  model: z.string(),
  permissionMode: z.string(),
  maxTurns: z.number().step(1).min(1),
  systemPrompt: z.string(),
  // Preserve omission: an empty allow list is a materialized-empty-config bug
  // that `tools.restrict` refuses, so the field must stay absent when unset.
  allowedTools: z.array(z.string()).default(undefined as unknown as string[]),
  // A JSON Schema object is opaque to schemastery; the provider asserted the
  // object-rooted shape before publishing it.
  outputSchema: z.any(),
  continueLatest: z.boolean(),
})

/** Outcome of one owned run interval. */
interface RunOutcome {
  text: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
}

/** Process-facing effects of one run: output streams plus the launcher's bounded exit request. */
interface HeadlessIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(session: Session, firstSeq: SessionLogOffset): RunOutcome {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq++) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) {
      throw new Error(`headless summary cannot read seq ${String(seq)} below captured length ${String(length)}`)
    }
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/**
 * Project provider-reported reasoning from one owned run to stderr as it is
 * streamed, while keeping final outcome derivation on the durable log.
 * @param ctx - plugin context carrying the live Assistant frame feed.
 * @param agent - the exact Agent whose reasoning belongs to this invocation.
 * @param stderr - progress output sink.
 * @returns a disposer that also terminates an unterminated reasoning line.
 */
function streamReasoning(
  ctx: Context,
  agent: Agent,
  stderr: HeadlessIo['stderr'],
): () => void {
  let open = false
  let endsWithNewline = true
  const close = (): void => {
    if (!open) return
    if (!endsWithNewline) stderr.write('\n')
    open = false
    endsWithNewline = true
  }
  const dispose = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent) return
    if (frame.type === 'start') {
      close()
      return
    }
    if (frame.type === 'end') {
      close()
      return
    }
    const chunk = frame.chunk
    switch (chunk.type) {
      case 'reasoning-delta':
        if (chunk.text === '') return
        if (!open) {
          stderr.write('dsh: reasoning:\n')
          open = true
        }
        stderr.write(chunk.text)
        endsWithNewline = chunk.text.endsWith('\n')
        return
      case 'block-start':
        if (chunk.blockType !== 'reasoning') close()
        return
      case 'block-end':
        if (chunk.block.type !== 'reasoning') close()
        return
      case 'usage':
        return
      case 'text-delta':
      case 'tool-call-delta':
      case 'finish':
        close()
        return
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(chunk, 'headless reasoning stream')
    }
  })
  return () => {
    dispose()
    close()
  }
}

/** The Session facts that decide whether the runner may drive it directly. */
interface AdoptableHeader {
  cwd?: string | undefined
  origin?: 'subagent' | undefined
  parentSession?: SessionId | undefined
  agentPreset?: string | undefined
}

/** Iterate a live Session's durable events in order. */
function* liveEvents(session: Session): Generator<SessionEvent> {
  const length = session.seq
  for (let seq = 0; seq < length; seq++) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) {
      throw new Error(`headless adoption cannot read seq ${String(seq)} below captured length ${String(length)}`)
    }
    yield event
  }
}

/**
 * The preset a Session currently runs under: its creation header advanced by
 * the last `agent-preset/selected` event. The header is only a creation fact;
 * the presets plugin reconstructs a session's composition from the projection.
 */
function currentPreset(header: AdoptableHeader, events: Iterable<SessionEvent>, sessionId: SessionId): string | undefined {
  let preset = header.agentPreset
  for (const event of events) {
    // Owned by dsh-agent-preset-registry, which this bundle does not compose, so the
    // event is read structurally rather than through its module augmentation.
    const candidate = event as unknown as { type: string; data?: { agentPreset?: unknown } }
    if (candidate.type !== 'agent-preset/selected') continue
    const selected = candidate.data?.agentPreset
    // A corrupt record must not read as "no preset": that would let the run
    // continue under this bundle's composition instead of the recorded one.
    if (typeof selected !== 'string' || selected === '') {
      throw new Error(`session "${sessionId}" records a malformed agent-preset/selected event and cannot be adopted`)
    }
    preset = selected
  }
  return preset
}

/** Reject a Session the one-shot runner must not adopt. */
function assertAdoptable(header: AdoptableHeader, events: Iterable<SessionEvent>, sessionId: SessionId, cwd: string): void {
  const preset = currentPreset(header, events, sessionId)
  if (preset !== undefined) {
    // This bundle composes no preset roster, so resuming the session here would
    // silently run it under the headless tools and prompts instead of the
    // composition its log records.
    throw new Error(
      `session "${sessionId}" runs under agent preset "${preset}", which the one-shot runner does not compose`,
    )
  }
  if (header.origin === 'subagent' || header.parentSession !== undefined) {
    throw new Error(`session "${sessionId}" is a subagent or forked session and cannot be driven directly`)
  }
  if (header.cwd === undefined) {
    throw new Error(`session "${sessionId}" recorded no working directory, so it cannot be adopted`)
  }
  if (header.cwd !== cwd) {
    throw new Error(`session "${sessionId}" was recorded in "${header.cwd}", not "${cwd}"`)
  }
}

/**
 * Resolve the Agent for one run: adopt the persisted Session with the requested
 * id. The identity must already exist, and no Agent may be live under it; a
 * first round omits the option instead, so a typo cannot pass as a brand-new
 * conversation.
 * @param ctx - plugin context carrying the Session query service.
 * @param agents - the core Agent registry.
 * @param sessionId - exact Session identity to adopt.
 * @param agentOptions - provider/model pair for this run.
 * @param setup - per-Agent scope setup installing the model selection.
 * @param cwd - working directory resolved in the mounted filesystem.
 * @returns the resumed Agent.
 */
async function resolveAgent(
  ctx: Context,
  agents: Context['agents'],
  sessionId: SessionId,
  agentOptions: { provider: string; model: string },
  setup: (agentCtx: Context) => void,
  cwd: string,
): Promise<Agent> {
  // Resuming promises the caller a log a later process can continue. Without a
  // durable log the run would succeed, print the id, and still lose the whole
  // history at exit, so a miscomposed profile fails loud before the resume.
  if (ctx.get('sessionPersistence') === undefined) {
    throw new Error('headless --session-id requires the sessionPersistence service; the Session would not survive this process')
  }
  // A later process holds no live Agent and has to find the id through the
  // query service, so every --session-id run requires it.
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    throw new Error('headless --session-id requires the sessionQuery service; dsh-base provides it')
  }
  const live = agents.get(sessionId)
  if (live !== undefined) {
    // A live Agent already has an owner that may still drive it, and `whenIdle`
    // is not a single-message signal: folding its next interval into this run
    // would mix that owner's events — even its final answer — into the stream.
    // The runner cannot claim an exclusive interval over an Agent it did not
    // create, so it refuses the identity; the adoptability rules run first so a
    // real mismatch is named instead of the generic refusal.
    assertAdoptable(live.session.header, liveEvents(live.session), sessionId, cwd)
    throw new Error(`session "${sessionId}" is live in this process, so the one-shot runner cannot own an exclusive run interval`)
  }
  try {
    using observation = await query.observeSession(sessionId)
    assertAdoptable(observation.header, observation.events, sessionId, cwd)
    const { agent } = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    // The observation is a snapshot: another writer may have appended a preset
    // selection before this process took the write lease. Re-check the log
    // resume actually attached, now that no other process can append.
    assertAdoptable(agent.session.header, liveEvents(agent.session), sessionId, cwd)
    return agent
  } catch (error: unknown) {
    if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
    // --session-id resumes a conversation that already exists; starting a new
    // one is the no-id path, which generates its own identity and reports it in
    // the `session` event. Creating the requested id here would turn a typo
    // into a brand-new empty history the caller believes it is continuing.
    throw new Error(`session "${sessionId}" does not exist; omit --session-id to start a new Session`)
  }
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: HeadlessIo, error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error)
  if (json) io.stdout.write(`${boundJsonLine({ type: 'error', message })}\n`)
  io.stderr.write(`dsh: ${message}\n`)
  io.exit(1)
}

/**
 * Resolve the newest Session recorded in one working directory, for
 * `--continue`. Only a top-level Session is a candidate: the adoption checks
 * refuse a subagent or forked Session, so considering one would fail a
 * directory whose newest record is a child instead of continuing the
 * conversation the caller meant.
 * @param ctx - plugin context carrying the Session query service.
 * @param cwd - the working directory this run resolved through the filesystem service.
 * @returns the newest candidate's identity.
 */
async function latestSessionId(ctx: Context, cwd: string): Promise<SessionId> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    throw new Error('headless --continue requires the sessionQuery service; dsh-base provides it')
  }
  // The query lists newest-first, so the first top-level record in this
  // directory is the conversation being continued.
  const records = await query.filterSessions([{ kind: 'cwd', values: [cwd] }])
  const candidate = records.find(record =>
    record.header.origin !== 'subagent' && record.header.parentSession === undefined)
  if (candidate === undefined) {
    throw new Error(`no top-level Session is recorded in "${cwd}"; omit --continue to start a new one`)
  }
  return candidate.header.id
}

/**
 * Dispatch one leading slash-command line through the composed command registry.
 *
 * The SDK's session controller and the Web composer reach the same registry
 * through their own host transport, so the one-shot app is a third dispatcher
 * with the same admission semantics. A host without the registry, a line the
 * registry cannot admit, and a handler that reports an error all fail this run
 * instead of being submitted to the model as chat.
 *
 * @param ctx - plugin context that may carry the command registry.
 * @param agent - the exact Agent the command runs against.
 * @param line - complete slash-command line.
 * @returns the settled handler's success text, or `undefined` when it supplied none.
 */
async function dispatchCommand(ctx: Context, agent: Agent, line: string): Promise<string | undefined> {
  const commands = ctx.get('commands')
  if (commands === undefined) {
    throw new Error(`${line} is a command line, but this profile composes no command registry`)
  }
  // The one-shot app owns no cancellation: this signal satisfies the registry's
  // abort contract, and the launcher keeps sole ownership of process exit.
  const signal = new AbortController().signal
  const execution = await commands.execute(agent, line, [], signal)
  if (execution === undefined) throw new Error(`unknown or malformed command: ${line}`)
  if (execution.result.kind === 'error') throw new Error(execution.result.text)
  return execution.result.text
}

/**
 * Run one task through one Agent and request process exit.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param config - task, optional exact Session identity, and output mode.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, config: Config, io: HeadlessIo): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  // A Cordis overlay sets the row directly and bypasses the CLI trim check, so
  // the same public setting must fail here rather than become a blank identity.
  if (config.sessionId !== undefined && config.sessionId.trim() === '') {
    throw new Error('headless-runner: sessionId must not be blank')
  }
  // The provider rejects the two selectors together, so an overlay that sets
  // both is refused here instead of letting one silently win.
  if (config.continueLatest === true && config.sessionId !== undefined) {
    throw new Error('headless-runner: sessionId and continueLatest are mutually exclusive')
  }

  const task = config.task === undefined || config.task === '-'
    ? await internals.readStdin()
    : config.task
  if (task.trim() === '') {
    throw new Error('a task is required, for example: dsh --profile headless "run the tests"')
  }

  const selection = defaultModel.currentSelection()
  // --model replaces the model id only: the provider route, its credentials,
  // and the reasoning effort stay the deployment's, so a flag cannot point a
  // run at an unrouted provider.
  const agentOptions = { provider: selection.provider, model: config.model ?? selection.model }
  const runOptions: { structured: StructuredAttachment | undefined } = { structured: undefined }
  // This bundle composes no preset roster, so the model-facing rows sit in the
  // host plane and the agent reads them from the global layer. A deployment
  // that DOES configure one has to join it here first
  // (@deepseek-ai/dsh-agent-preset-registry README, "Composing a child agent").
  // Every run flag below is registered in the Agent's own scope, so none of
  // them outlives that Agent or reaches a sibling.
  const setup = (agentCtx: Context): void => {
    const selected: ModelSelectionRef = { current: { ...selection, model: agentOptions.model }, assembled: undefined }
    installModelSelection(agentCtx, selected)
    if (config.systemPrompt !== undefined) {
      // A complete section is the harness's whole-prompt mechanism: assembly
      // still resolves tools, contexts, and variables, then this text is the
      // only section the request carries.
      agentCtx.systemPrompt.section({
        name: 'headless:system-prompt',
        order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: config.systemPrompt,
        complete: true,
      })
    }
    if (config.allowedTools !== undefined) agentCtx.tools.restrict({ allow: config.allowedTools })
    if (config.maxTurns !== undefined) {
      const ceiling = config.maxTurns
      // The proposed step number is 1-based, so the ceiling admits exactly
      // `ceiling` steps and refuses the next one; the loop then ends the turn
      // through its ordinary blocked-rejection path.
      agentCtx.on('agent/pre-step', ({ step }, next): Promise<PreStepDecision> =>
        step > ceiling ? Promise.resolve({ kind: 'reject' }) : next())
    }
    if (config.outputSchema !== undefined) {
      runOptions.structured = attachStructuredRuntime(agentCtx, config.outputSchema)
    }
  }
  const fs = ctx.get('fs')
  const cwd = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'))
  const requested = config.sessionId
    ?? (config.continueLatest === true ? await latestSessionId(ctx, cwd) : undefined)
  const sessionId = brandString<SessionId>(requested ?? `session-${randomUUID()}`)
  const agent = requested === undefined
    ? (await agents.create({
      sessionId,
      meta: { cwd },
      agentOptions,
      setup,
    })).agent
    : await resolveAgent(ctx, agents, sessionId, agentOptions, setup, cwd)
  if (config.permissionMode !== undefined) {
    const presets = ctx.get('permissionPresets')
    if (presets === undefined) {
      throw new Error('headless --permission-mode requires the permissionPresets service; dsh-base provides it')
    }
    // `set` validates the name against the composed preset table and writes the
    // preset's knob bundle durably, so a resumed Session keeps the permission
    // this run pinned and the flag outranks the deployment's process-wide
    // default for exactly this Session.
    presets.set(agent.session, config.permissionMode)
  }
  await agent.whenIdle()
  if (requested !== undefined) {
    // The resume-time check read a snapshot; an overlay can still append a
    // preset selection between it and the interval this run now owns, so
    // re-read the log the runner holds before submitting the task.
    assertAdoptable(agent.session.header, liveEvents(agent.session), sessionId, cwd)
  }
  const firstSeq = agent.session.seq
  const projection = config.json === true ? projectJsonRun(ctx, agent, io.stdout, { cwd }) : undefined
  const stopReasoning = projection === undefined ? streamReasoning(ctx, agent, io.stderr) : undefined
  try {
    let dispatched = false
    let commandText: string | undefined
    try {
      // A command line is a human control, not a prompt: the registry admits it
      // and its handler owns any model work it schedules.
      if (parseCommand(task) === undefined) {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: task }],
          source: { kind: 'user' },
        }))
      } else {
        commandText = await dispatchCommand(ctx, agent, task)
        dispatched = true
      }
      await agent.whenIdle()
    } finally {
      stopReasoning?.()
    }
    await sessions.flush(agent.session)
    const outcome = summarize(agent.session, firstSeq)
    const captured = runOptions.structured?.captured()
    if (config.outputSchema !== undefined && captured === undefined) {
      // The caller asked for a schema-constrained result; a prose answer is not
      // one, and reporting the text as if it satisfied the schema would be a
      // silent contract miss.
      throw new Error('the run finished without a structured result: the model never called '
        + '`structured_output` with arguments matching --output-schema')
    }
    // A command that scheduled no model work is its own answer; one that
    // submitted a message answers through the turn it started.
    const answer = outcome.text !== '' ? outcome.text : commandText ?? ''
    if (projection === undefined) {
      io.stdout.write(`${captured === undefined ? answer : JSON.stringify(captured.value)}\n`)
    } else projection.finish(answer, captured?.value)
    if (outcome.reason?.kind === 'error') {
      io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
    }
    // A dispatched command owns the outcome when the interval holds no turn: its
    // own settlement is the result. A turn the interval does hold decides as
    // before, so a model failure inside a command's run still fails this run.
    const settled = outcome.reason === undefined
      ? dispatched
      : outcome.reason.kind === 'completed'
    io.exit(settled ? 0 : 1)
  } finally {
    projection?.dispose()
  }
}

/**
 * Mount the one-shot direct driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated task and run options.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('headless-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: HeadlessIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => { fail(io, error, config.json === true) })
}
