/**
 * Bridge for unmodified Claude Code command and HTTP hooks on harness
 * interception extension points. It supports the session, prompt, tool,
 * permission, compaction, notification, subagent, model-request, and
 * tool-selection points listed in this package's README, discovered from a
 * layered project/user config. It owns Claude payloads, environment,
 * substitution, and decision mapping; shared execution, parsing, and the
 * run-level halt live in `dsh-hook-protocol`. `updatedInput` is logged and
 * warned but not honored. Bespoke behavior should use typed native plugins on
 * the same extension points.
 * @module @deepseek-ai/dsh-hooks-claude-code
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision, TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-compaction'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hooks-claude-code': { kind: 'hooks-claude-code' } & ContextFormed
  }
}

import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  appendHookInvoked,
  appendHookResult,
  applyRunHalt,
  createDetachedRuns,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  matchesMatcher,
  mergeHookOutputs,
  mergeMatcherGroups,
  readHookConfigLayers,
  runHook,
  UNTRUSTED_HOOK_CONTEXT_NOTICE,
  type HookOutput,
  type MatcherGroup,
  type MergedHookOutcome,
} from '@deepseek-ai/dsh-hook-protocol'
// Pulls in the declaration-merged subagent events and the identity pairing their
// start/end edges.
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { parseClaudeCodeConfig, type ClaudeCodeHookConfig } from './config.ts'

export const name = 'hooks-claude-code'
// `shell` runs command hooks and `sessionProjections` supplies turn numbers; the rest
// are read opportunistically via ctx.get so a deployment can omit them.
export const inject = ['shell', 'sessionProjections']

/** Plugin config: the hook-config layers + substitution roots. */
export interface Config {
  /**
   * Explicit hook config file — a `hooks.json` or a settings file whose `hooks`
   * key holds the config. Highest precedence, read after every discovered
   * layer; a path that repeats a discovered layer is read once, at this
   * position. Process-level: a relative path resolves against the process
   * launch cwd.
   */
  configPath?: string
  /**
   * Project root for discovery: its `.claude/settings.json` (Claude Code's
   * project layer) and `.dsh/hooks.json` (the harness's own project layer) are
   * read. Defaults to the process launch cwd.
   */
  projectRoot?: string
  /** User root for discovery: its `.claude/settings.json` is read. Defaults to the home directory. */
  userRoot?: string
  /**
   * Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings (the plugin's root dir).
   */
  pluginRoot?: string
  /**
   * Replaces `${CLAUDE_PROJECT_DIR}` in command strings AND is exported as the
   * `CLAUDE_PROJECT_DIR` env var for hook processes. When omitted, the env var
   * defaults per-run to the agent's session workspace (`session.header.cwd`, the
   * same dir the hook runs in) — Claude Code always exports this var, and common
   * unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths.
   */
  projectDir?: string
  /** Default per-hook timeout in ms when a hook sets none (CC default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
}

export const Config: z<Config> = z.object({
  configPath: z.string(),
  projectRoot: z.string(),
  userRoot: z.string(),
  pluginRoot: z.string(),
  projectDir: z.string(),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
})

/** A stable per-handler id so an invoked/result pair correlates in the log. */
let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `claude-code:${point}:${++handlerCounter}`
}

/** The `{kind:'hooks-claude-code'}` producer source stamped on every context this bridge injects. */
const CONTEXT_SOURCE: MessageSource = { kind: 'hooks-claude-code' }

/** Restriction signature recorded when a BeforeToolSelection hook stopped narrowing. */
const LIFTED_TOOL_SIGNATURE = '<lifted>'

/** The summary cap bounds a persisted event field — a positive integer or the slice misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`hooks-claude-code: ${name} must be a positive integer`)
  }
}

export function apply(ctx: Context, config: Config): void {
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger('stderrSummaryMaxChars', stderrSummaryMaxChars)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const projectRoot = config.projectRoot ?? process.cwd()
  const userRoot = config.userRoot ?? homedir()
  const warn = (message: string): void => { ctx.logger.warn(`hooks-claude-code: ${message}`) }

  // Discovery is layered, lowest precedence first: the user's settings, the
  // project's settings, the harness's own project hooks, then an explicit file.
  // Every layer that parses contributes its groups in that order; a layer that
  // is absent contributes nothing, and a present-but-broken layer is skipped
  // with a diagnostic so it cannot hide the layers around it.
  const layerPaths = [
    join(userRoot, '.claude', 'settings.json'),
    join(projectRoot, '.claude', 'settings.json'),
    join(projectRoot, '.dsh', 'hooks.json'),
    ...config.configPath !== undefined ? [config.configPath] : [],
  ]
  const layerConfigs: ClaudeCodeHookConfig[] = []
  for (const layer of readHookConfigLayers(layerPaths, warn)) {
    try {
      const result = parseClaudeCodeConfig(layer.raw, {
        ...config.pluginRoot !== undefined ? { pluginRoot: config.pluginRoot } : {},
        ...config.projectDir !== undefined ? { projectDir: config.projectDir } : {},
      })
      for (const s of result.skipped) {
        warn(`skipping unsupported "${s.type}" hook on ${s.event} (only command and http hooks run)`)
      }
      layerConfigs.push(result.config)
    } catch (error: unknown) {
      warn(`skipping hook config layer "${layer.path}": ${String(error)}`)
    }
  }
  const parsed: ClaudeCodeHookConfig = mergeMatcherGroups(layerConfigs)

  // Emit-shaped points run detached, so track their chains; disposal aborts
  // active hooks and drains continuations before resolving.
  const detached = createDetachedRuns()
  // Only the start edge guarantees registry access. Retain each local child
  // through its paired end so stop hooks keep the session workspace after the
  // handle unregisters the agent. Every retained entry relies on that paired
  // end; a producer that can omit it must provide another release edge.
  const subagentChildren = new Map<SubagentRunId, Agent>()
  // Tool restrictions a BeforeToolSelection hook asked for, per session: the
  // hook is re-evaluated at every assembly, so the map holds only the current
  // intent and lifts the previous restriction when it changes.
  const toolRestrictions = new Map<SessionId, { signature: string; dispose: () => void }>()
  ctx.effect(() => () => {
    for (const entry of toolRestrictions.values()) entry.dispose()
    toolRestrictions.clear()
  }, 'hooks-claude-code: lift tool restrictions')
  ctx.effect(() => () => detached.drain(), 'hooks-claude-code: drain detached hook runs')
  // The approval-ask correlation that lets the denial hook name the tool it
  // refused; each entry is removed when its audit pair closes.
  const pendingApprovals = new Map<string, { toolName: string }>()

  /**
   * Mirror a BeforeToolSelection narrowing onto the agent's own tool scope, so a
   * narrowed-away tool is not merely hidden from the model: a call that still
   * names it is denied before dispatch. The restriction is lifted as soon as a
   * later assembly no longer narrows. A name `tools.restrict()` refuses (an
   * unknown or reserved global tool) leaves the assembly narrowing in force.
   */
  function restrictTools(agent: Agent, allowTools: string[] | undefined): void {
    const key = agent.session.header.id
    const signature = allowTools === undefined ? LIFTED_TOOL_SIGNATURE : [...allowTools].sort().join('\u0000')
    const current = toolRestrictions.get(key)
    if (current?.signature === signature) return
    current?.dispose()
    toolRestrictions.delete(key)
    if (allowTools === undefined) return
    const tools = agent.ctx.get('tools')
    if (tools === undefined) return
    try {
      toolRestrictions.set(key, { signature, dispose: tools.restrict({ allow: allowTools }) })
    } catch (error: unknown) {
      warn(`could not restrict the tool set for session "${key}": ${String(error)}`)
    }
  }

  /**
   * Run every handler configured for `point` whose matcher selects
   * `matchQuery`, with the per-event `payload` (stdin for a command hook, POST
   * body for an HTTP hook), and fold the results. Writes a
   * `hook/invoked`/`hook/result` pair per handler when `opts.turn` names an open
   * turn. Detached lifecycle points omit the pair. Returns the merged outcome (a
   * neutral, already-most-restrictive view) for the caller to map onto its
   * extension point decision. `matchQuery` is the event's matcher subject (tool
   * name, session source, …); `''` for events that ignore matchers.
   */
  async function runPoint(
    point: string,
    matchQuery: string,
    payload: unknown,
    opts: { agent?: Agent; turn?: number; readonly signal: AbortSignal },
  ): Promise<MergedHookOutcome> {
    const groups: MatcherGroup[] = parsed[point] ?? []
    const outputs: HookOutput[] = []
    // Run the hook in the agent's session workspace (the `session/new` cwd on the session
    // header), not the executor or entry-point process's launch dir.
    const workdir = opts.agent?.session.header.cwd
    // CLAUDE_PROJECT_DIR: an explicit config value wins; otherwise default it to the session
    // workspace (the same dir the hook runs in).
    const projectDir = config.projectDir ?? workdir
    const hookEnv = projectDir !== undefined ? { CLAUDE_PROJECT_DIR: projectDir } : undefined
    for (const group of groups) {
      if (!matchesMatcher(group.matcher, matchQuery, 'claude-code')) continue
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'claude-code', handlerId,
            ...group.matcher !== undefined ? { matcher: group.matcher } : {},
          })
        }
        const { output, durationMs } = await runHook(ctx.shell, hook, {
          payload,
          defaultTimeoutMs,
          ...hookEnv ? { env: hookEnv } : {},
          ...workdir !== undefined ? { cwd: workdir } : {},
          signal: opts.signal,
          trailingNewline: true,
          // Discard a `hookSpecificOutput` block whose `hookEventName` names a
          // different event than the one firing (the schemas key it by event).
          expectedEventName: point,
        }, () => performance.now())
        outputs.push(output)
        if (output.updatedInput !== undefined) {
          warn(`${point} hook requested updatedInput, which is not yet honored (ignored)`)
        }
        if (output.systemMessage !== undefined) {
          warn(`${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`)
        }
        if (session && opts.turn !== undefined) {
          appendHookResult(session, { turn: opts.turn, point, handlerId, output, stderrSummaryMaxChars, durationMs })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  /**
   * Run one detached observer point: no extension point awaits it, so its chain
   * is tracked for disposal, a halt request is reported (a point without a live
   * run cannot halt), and a failure is contained.
   */
  function runDetached(point: string, matchQuery: string, payload: unknown, agent: Agent | undefined, turn: number | undefined): void {
    detached.track(runPoint(point, matchQuery, payload, {
      ...agent !== undefined ? { agent } : {},
      ...turn !== undefined ? { turn } : {},
      signal: detached.signal,
    })
      .then((merged) => { applyRunHalt(merged, point, undefined, warn) })
      .catch((error: unknown) => { warn(`${point} hook failed: ${String(error)}`) }))
  }

  /**
   * Start one detached point from a `session/event` observer, one microtask
   * after the append that reported the event returns. `session.append` refuses
   * a reentrant publication, and the observer runs with that append still in
   * flight, so a start here would be refused exactly when the point has a turn
   * to record into: the point would write no `hook/invoked` pair and the hook
   * itself would never run. Deferring past the append is what keeps the three
   * points that report from the session stream alive.
   */
  function runAfterAppend(point: string, matchQuery: string, payload: unknown, agent: Agent | undefined, turn: number | undefined): void {
    queueMicrotask(() => { runDetached(point, matchQuery, payload, agent, turn) })
  }

  /** Build additional model context from hook output, or return undefined when empty. */
  function contextFrom(merged: MergedHookOutcome): UserMessage | undefined {
    if (merged.additionalContext.length === 0) return undefined
    const content: ContentBlock[] = [
      { type: 'text', text: UNTRUSTED_HOOK_CONTEXT_NOTICE },
      ...merged.additionalContext.map(text => ({ type: 'text' as const, text })),
    ]
    return createUserMessage({ content, source: CONTEXT_SOURCE })
  }

  /** Prepend one context without flattening source fields or other downstream metadata. */
  function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
    return [ours, ...theirs ?? []]
  }

  ctx.on('agent/created', async ({ agent, source, signal }) => {
    const ownerSignal = signal === undefined ? detached.signal : AbortSignal.any([signal, detached.signal])
    const run = runPoint('SessionStart', source, sessionStartPayload(agent, source), { agent, signal: ownerSignal })
      .then((merged) => {
        // SessionStart runs before the run is live, so a halt here has no run
        // to cancel: it is reported and only the hook/result record remains.
        applyRunHalt(merged, 'SessionStart', undefined, warn)
        const context = contextFrom(merged)
        if (context) agent.inject(context)
      })
      .catch((error: unknown) => {
        warn(`SessionStart hook failed: ${String(error)}`)
      })
    detached.track(run)
    await run
  })

  // --- UserPromptSubmit → PreStepDecision. The prompt text is the payload; no
  // matcher subject (CC ignores matchers for this event). ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    if (messages.length === 0) return next()
    const content = messages.flatMap(message => message.content)
    const merged = await runPoint('UserPromptSubmit', '', promptPayload(agent, content), { agent, turn, signal })
    // A halting hook stops the run here; the turn then closes as an abort
    // carrying this hook's reason, so the decision below is never consumed.
    if (applyRunHalt(merged, 'UserPromptSubmit', agent, warn)) return { kind: 'reject' }
    if (merged.decision === 'deny') {
      return { kind: 'reject' }
    }
    // Delegate so later listeners may still rewrite or reject, then prepend our
    // context only to a downstream enter decision.
    const downstream = await next()
    const ours = contextFrom(merged)
    if (!ours || downstream.kind !== 'enter') return downstream
    return {
      ...downstream,
      messages: [...downstream.messages, ours],
    }
  })

  // --- PreToolUse → PreToolDecision. Matcher subject is the tool name. ---
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(ctx, exec.agent)
    const merged = await runPoint('PreToolUse', exec.name, preToolPayload(exec), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    // The halt cancels the run; canceling the call too keeps the tool from
    // dispatching while the abort travels back through the loop.
    if (applyRunHalt(merged, 'PreToolUse', exec.agent, warn)) return { kind: 'cancel' }
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    if (merged.decision === 'ask') return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
    return next()
  })

  // --- PostToolUse (a successful call) and PostToolUseFailure (a failed one)
  // → PostToolDecision. Matcher subject is the tool name; the failure point
  // carries the failure text as `error` as well as in `tool_response`. ---
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const turn = lastTurn(ctx, exec.agent)
    const point =  result.isError ? 'PostToolUseFailure' : 'PostToolUse'
    const merged = await runPoint(point, exec.name, postToolPayload(exec, result, point), {
      ...exec.agent ? { agent: exec.agent } : {},
      turn,
      signal: exec.signal,
    })
    applyRunHalt(merged, point, exec.agent, warn)
    const context = contextFrom(merged)
    if (merged.decision === 'deny') {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? `blocked by ${point} hook` }], ...context ? { additionalContexts: [context] } : {} }
    }
    // Our hooks did not block. DELEGATE so a later listener can still block/replace,
    // then fold our context onto its decision (a downstream block carries it too).
    const downstream = await next()
    if (!context) return downstream
    if (downstream.kind === 'block') {
      return { ...downstream, additionalContexts: prependContext(context, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(context, downstream.additionalContexts),
    }
  })

  // --- PermissionRequest: a tool call is about to ask the user for approval.
  // The bridge runs its hooks BEFORE delegating, so a hook gets first refusal;
  // a hook may refuse (deny → `rejected`) but can never grant, because the
  // approval channel owns grants. ---
  ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
    const turn = openTurn(ctx, req.agent.session)
    const merged = await runPoint('PermissionRequest', req.toolName, permissionRequestPayload(req.agent, req.toolName), {
      agent: req.agent,
      ...turn !== undefined ? { turn } : {},
      signal: req.signal ?? detached.signal,
    })
    applyRunHalt(merged, 'PermissionRequest', req.agent, warn)
    if (merged.decision === 'deny') return 'rejected'
    return await next()
  })

  // --- SessionEnd and PreCompact may run outside any turn, so they only
  // observe: no `hook/*` record without an open turn, no context to inject.
  // Approval notifications and denials come from the approval audit pair.
  // Every start below defers past the reporting append (see {@link runAfterAppend}). ---
  ctx.on('session/event', (session, event) => {
    if (event.type === 'compaction/start') {
      const agent = ctx.get('agents')?.get(session.header.id)
      const trigger = event.data.sourceCommandId !== undefined ? 'manual' : 'auto'
      runAfterAppend('PreCompact', trigger, preCompactPayload(agent, trigger), agent, openTurn(ctx, session))
      return
    }
    if (event.type === 'approval/asked') {
      pendingApprovals.set(event.data.id, { toolName: event.data.toolName })
      const agent = ctx.get('agents')?.get(session.header.id)
      runAfterAppend('Notification', 'permission_prompt', notificationPayload(agent, event.data.toolName), agent, openTurn(ctx, session))
      return
    }
    if (event.type === 'approval/decided') {
      const asked = pendingApprovals.get(event.data.id)
      pendingApprovals.delete(event.data.id)
      // A withdrawal is a cancellation, not a refusal, so it fires nothing; an
      // unavailable answerer is a fail-closed refusal and does.
      if (event.data.outcome !== 'rejected' && event.data.outcome !== 'unavailable') return
      const agent = ctx.get('agents')?.get(session.header.id)
      runAfterAppend('PermissionDenied', asked?.toolName ?? '', permissionDeniedPayload(agent, asked?.toolName ?? '', event.data.outcome), agent, openTurn(ctx, session))
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    runDetached('SessionEnd', '', sessionEndPayload(agent), agent, undefined)
  })

  // --- BeforeModel → the model request. The hook sees the config the machine
  // would use and may replace the four patchable fields; anything it cannot
  // patch (messages, tools, the system prompt, the signal) is unchanged. ---
  ctx.on('agent/request', async ({ agent, turn, step, signal }, next): Promise<LlmCallConfig> => {
    const config = await next()
    if ((parsed.BeforeModel ?? []).length === 0) return config
    const merged = await runPoint('BeforeModel', '', beforeModelPayload(agent, turn, step, config), { agent, turn, signal })
    applyRunHalt(merged, 'BeforeModel', agent, warn)
    const patch = merged.requestPatch
    if (patch === undefined) return config
    return {
      ...config,
      ...patch.provider !== undefined ? { provider: patch.provider } : {},
      ...patch.model !== undefined ? { model: patch.model } : {},
      ...patch.reasoningEffort !== undefined ? { reasoningEffort: ReasoningEffortId(patch.reasoningEffort) } : {},
      ...patch.maxTokens !== undefined ? { maxTokens: patch.maxTokens } : {},
    }
  })

  // --- BeforeToolSelection → the assembled tool set. A hook may only NARROW:
  // the result filters the visible schemas and the same narrowing is mirrored
  // onto the agent's tool scope, so the execution side denies a tool the model
  // no longer sees. ---
  ctx.on('system-prompt/assemble', async (_assembly, context, next): Promise<PromptAssembly> => {
    const downstream = await next()
    const agent = context.agent
    if (agent === undefined || (parsed.BeforeToolSelection ?? []).length === 0) return downstream
    const turn = openTurn(ctx, agent.session)
    const merged = await runPoint('BeforeToolSelection', '', beforeToolSelectionPayload(agent, turn, downstream.tools.map(tool => tool.name)), {
      agent,
      ...turn !== undefined ? { turn } : {},
      signal: context.signal ?? detached.signal,
    })
    applyRunHalt(merged, 'BeforeToolSelection', agent, warn)
    const allowed = merged.allowTools
    restrictTools(agent, allowed)
    if (allowed === undefined) return downstream
    return { ...downstream, tools: downstream.tools.filter(tool => allowed.includes(tool.name)) }
  })

  // A blocking Stop hook steers at the stopping boundary, which makes the
  // machine observe pending input and run another step. A halting Stop hook
  // stops the run instead.
  // TODO(stop-loop-guard): cap consecutive forced continuations; hooks must self-limit meanwhile.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const merged = await runPoint('Stop', '', stopPayload(agent), { agent, turn, signal })
    if (applyRunHalt(merged, 'Stop', agent, warn)) return
    if (merged.decision === 'deny') {
      // A blocking Stop hook forces continuation.
      const text = merged.reason ?? 'continue: blocked by Stop hook'
      agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: CONTEXT_SOURCE }))
    }
  })

  // SubagentStart may inject child context; SubagentStop only observes. Both
  // use the live child's workspace and the generic agent-type matcher subject.
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    if (child !== undefined) subagentChildren.set(info.runId, child)
    detached.track(runPoint('SubagentStart', SUBAGENT_TYPE, subagentPayload('SubagentStart', info, child), { ...child ? { agent: child } : {}, signal: detached.signal })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context && child) child.inject(context)
      })
      .catch((error: unknown) => { warn(`SubagentStart hook failed: ${String(error)}`) }))
  })
  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info.runId) ?? ctx.get('agents')?.get(info.id)
    subagentChildren.delete(info.runId)
    detached.track(runPoint('SubagentStop', SUBAGENT_TYPE, subagentPayload('SubagentStop', info, child), { ...child ? { agent: child } : {}, signal: detached.signal }))
  })
}

/**
 * The `agent_type` value the bridge reports for SubagentStart/Stop. The harness
 * subagent seam carries no per-kind label, so the bridge uses Claude Code's own
 * Task-tool default — a hooks.json with a default/`*`/empty `agent_type` matcher
 * fires; a config matching a specific kind (e.g. `code-reviewer`) does not.
 */
const SUBAGENT_TYPE = 'general-purpose'

// --- Per-event stdin payloads (the CC DIALECT shape). Field names match CC's
// hook input schema; this is the part a bridge owns. ---

/** The last open turn number in the agent's log, or 0 without an agent. */
function lastTurn(ctx: Context, agent: Agent | undefined): number {
  if (!agent) return 0
  const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary') as TurnBoundaryProjection
  return boundary.lastTurn
}

/**
 * The open turn number for `session`, or `undefined` between turns. Approval
 * requests and compaction can run outside a turn, where a `hook/*` record has
 * no turn to live in — those points run without one.
 */
function openTurn(ctx: Context, session: Session): number | undefined {
  const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
  /* v8 ignore next -- the agent loop registers this projection before any hook point runs. */
  if (boundary === undefined) return undefined
  return boundary.openTurnStartSeq === null ? undefined : boundary.lastTurn
}

/** Flatten content blocks to the text a hook payload carries (the common case). */
function blocksToText(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}

function base(agent: Agent | undefined, event: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    // The persistence seam exposes no artifact path; the field stays empty
    // (a durable consumer gap recorded in this package's README).
    transcript_path: '',
    cwd: agent?.session.header.cwd ?? process.cwd(),
    hook_event_name: event,
  }
}

function sessionStartPayload(agent: Agent, source: string): Record<string, unknown> {
  return { ...base(agent, 'SessionStart'), source }
}
function promptPayload(agent: Agent, content: ContentBlock[]): Record<string, unknown> {
  return { ...base(agent, 'UserPromptSubmit'), prompt: blocksToText(content) }
}
function preToolPayload(exec: ToolExecution): Record<string, unknown> {
  return { ...base(exec.agent, 'PreToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId }
}
function postToolPayload(exec: ToolExecution, result: ToolExecutionResult, event: 'PostToolUse' | 'PostToolUseFailure'): Record<string, unknown> {
  return {
    ...base(exec.agent, event),
    tool_name: exec.name,
    tool_input: exec.arguments,
    tool_use_id: exec.callId,
    tool_response: blocksToText(result.content),
    // The failure point names the failure separately from the response text;
    // both carry the same rendered content because the harness stores one.
    ...result.isError ? { error: blocksToText(result.content) } : {},
  }
}
function permissionRequestPayload(agent: Agent, toolName: string): Record<string, unknown> {
  // The approval request carries no parsed arguments, so `tool_input` is empty;
  // the README records that gap.
  return { ...base(agent, 'PermissionRequest'), tool_name: toolName, tool_input: {}, permission_suggestions: [] }
}
function permissionDeniedPayload(agent: Agent | undefined, toolName: string, outcome: string): Record<string, unknown> {
  return { ...base(agent, 'PermissionDenied'), tool_name: toolName, tool_input: {}, reason: outcome }
}
function notificationPayload(agent: Agent | undefined, toolName: string): Record<string, unknown> {
  return {
    ...base(agent, 'Notification'),
    message: `Approval requested for tool "${toolName}"`,
    title: '',
    notification_type: 'permission_prompt',
  }
}
function preCompactPayload(agent: Agent | undefined, trigger: string): Record<string, unknown> {
  return { ...base(agent, 'PreCompact'), trigger, custom_instructions: '' }
}
function sessionEndPayload(agent: Agent): Record<string, unknown> {
  return { ...base(agent, 'SessionEnd'), reason: 'other' }
}
function beforeModelPayload(agent: Agent, turn: number, step: number, config: LlmCallConfig): Record<string, unknown> {
  return {
    ...base(agent, 'BeforeModel'),
    turn,
    step,
    request: {
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {},
      ...config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {},
    },
  }
}
function beforeToolSelectionPayload(agent: Agent, turn: number | undefined, tools: string[]): Record<string, unknown> {
  return { ...base(agent, 'BeforeToolSelection'), ...turn !== undefined ? { turn } : {}, tools }
}
function stopPayload(agent: Agent): Record<string, unknown> {
  return { ...base(agent, 'Stop'), stop_hook_active: false }
}
/**
 * Build a SubagentStart/SubagentStop payload from the CC base (the child's
 * `session_id`/`cwd` when the child agent is available) plus the subagent-hook
 * fields. `agent_type` is the CC-default {@link SUBAGENT_TYPE}; `stop_hook_active`
 * is present on SubagentStop only (the loop-guard flag, always false).
 */
function subagentPayload(event: 'SubagentStart' | 'SubagentStop', info: { id: string }, child: Agent | undefined): Record<string, unknown> {
  return {
    ...base(child, event),
    agent_id: info.id,
    agent_type: SUBAGENT_TYPE,
    ...event === 'SubagentStop' ? { stop_hook_active: false } : {},
  }
}
