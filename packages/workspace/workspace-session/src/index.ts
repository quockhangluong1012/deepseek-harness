/**
 * Creation of one ordinary root Session inside a Workspace, shared by every
 * producer that publishes a Workspace-backed Session (webhook rules, scheduled
 * routines).
 *
 * @module @deepseek-ai/dsh-workspace-session
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'

/** Provider, model, and optional output cap one producer asks a new Session to start with. */
export interface WorkspaceSessionAgentOptions {
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
}

/** Everything one producer fixes before the Session's first message is admitted. */
export interface WorkspaceSessionSpec {
  /** Existing local directory to resolve or create as a Workspace. */
  readonly workspacePath: string
  /** Producer-minted Session identity; the Agent and Workspace both adopt it. */
  readonly sessionId: SessionId
  /** Explicit Session title. */
  readonly title: string
  /** Agent composition mounted before publication. */
  readonly agentPreset: string
  /** Sandbox and approval preset applied before prompt admission. */
  readonly permissionPreset: string
  /** Complete selection for the creation-time request header. */
  readonly modelSelection: ModelSelection
  /** Provider and model the Agent starts with. */
  readonly agentOptions: WorkspaceSessionAgentOptions
  /** Producer-owned label used when a rollback step fails. */
  readonly owner: string
}

/** Log a rollback failure without replacing the operation's original failure. */
function reportRollbackFailure(ctx: Context, owner: string, subject: string, error: unknown): void {
  ctx.logger.warn(`${owner}: ${subject} rollback failed: ${errorChain(error)}`)
}

/** Apply the creation-time selection until its first durable request header exists. */
function installInitialModelSelection(agentCtx: Context, selection: ModelSelection): void {
  agentCtx.on('agent/request', async ({ agent }, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (agent.session.requestHeader() !== undefined
      || resolved.provider !== selection.provider
      || resolved.model !== selection.model) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }
  })
}

/**
 * Create, attach, title, configure, and prompt one ordinary root Session.
 * Successful prompt admission ends the caller's ownership of the operation; the
 * Agent remains lifecycle-owned by `ctx` and follows normal Session behavior.
 * A failure before admission rolls the Workspace attachment and the Agent back.
 *
 * @param ctx - runtime context that owns the resulting Agent.
 * @param spec - Workspace, identity, composition, and model the Session starts with.
 * @param message - the producer-built first user message, carrying its own source.
 * @param signal - producer lifetime cancellation through publication.
 * @returns nothing; the Session is live and owns the message on success.
 */
export async function startWorkspaceSession(
  ctx: Context,
  spec: WorkspaceSessionSpec,
  message: UserMessage,
  signal: AbortSignal,
): Promise<void> {
  ctx.permissionPresets.resolve(spec.permissionPreset)
  const preset = await ctx.agentPresets.resolve(spec.agentPreset)
  await using presetScope = await ctx.agentPresets.acquireScope(preset.id)
  void presetScope
  signal.throwIfAborted()

  const workspace = await ctx.workspaceRegistry.create(spec.workspacePath)
  signal.throwIfAborted()
  const handle = await ctx.agents.create({
    sessionId: spec.sessionId,
    signal,
    meta: { cwd: workspace.path, agentPreset: preset.id },
    agentOptions: spec.agentOptions,
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, preset.id)
      installInitialModelSelection(agentCtx, spec.modelSelection)
    },
  })

  let attached = false
  try {
    signal.throwIfAborted()
    await workspace.attachSession(spec.sessionId)
    attached = true
    signal.throwIfAborted()
    ctx.permissionPresets.set(handle.agent.session, spec.permissionPreset)
    ctx.sessionTitle.rename(handle.agent.session, spec.title)
    handle.agent.followup(message)
  } catch (error: unknown) {
    if (attached) {
      try {
        await workspace.detachSession(spec.sessionId)
      } catch (rollbackError: unknown) {
        reportRollbackFailure(ctx, spec.owner, `Workspace detach for Session "${spec.sessionId}"`, rollbackError)
      }
    }
    try {
      await handle.dispose()
    } catch (rollbackError: unknown) {
      reportRollbackFailure(ctx, spec.owner, `Agent disposal for Session "${spec.sessionId}"`, rollbackError)
    }
    throw error
  }
}
