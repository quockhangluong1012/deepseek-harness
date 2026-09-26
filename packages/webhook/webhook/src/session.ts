/** Workspace-backed Session creation for one settled webhook rule result. */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { startWorkspaceSession } from '@deepseek-ai/dsh-workspace-session'
import type { WorkspaceSessionAgentOptions } from '@deepseek-ai/dsh-workspace-session'
import type { WebhookRuleId } from './brand.ts'
import type { VerifiedWebhookDelivery, WebhookSessionRequest } from './types.ts'

/** Detached values the creation transaction keeps across asynchronous preflight. */
interface ResolvedWebhookSessionRequest {
  readonly workspacePath: string
  readonly title: string
  readonly prompt: string
  readonly agentPreset: string
  readonly permissionPreset: string
  readonly modelSelection: ModelSelection
  readonly agentOptions: WorkspaceSessionAgentOptions
}

/** Require one non-empty string field from an untyped rule result. */
function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`webhook Session request ${field} must be a non-empty string`)
  }
  return value
}

/** Snapshot and validate a same-process rule result before crossing awaits. */
function resolveRequest(ctx: Context, input: WebhookSessionRequest): ResolvedWebhookSessionRequest {
  const candidate: unknown = input
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('webhook rule result must be null or a Session request object')
  }
  const record = candidate as Record<string, unknown>
  const workspacePath = requiredString(record, 'workspacePath')
  if (!isAbsolute(workspacePath)) {
    throw new TypeError(`webhook Session request workspacePath must be absolute, got ${JSON.stringify(workspacePath)}`)
  }
  const title = requiredString(record, 'title')
  const prompt = requiredString(record, 'prompt')
  const agentPreset = requiredString(record, 'agentPreset')
  const permissionPreset = requiredString(record, 'permissionPreset')
  const model = record['model']
  if (model !== undefined && (model === null || typeof model !== 'object' || Array.isArray(model))) {
    throw new TypeError('webhook Session request model must be an object')
  }
  let agentOptions: WorkspaceSessionAgentOptions
  let modelSelection: ModelSelection
  if (model === undefined) {
    const selected = ctx.agentDefaultModel.currentSelection()
    agentOptions = { provider: selected.provider, model: selected.model }
    modelSelection = { ...selected }
  } else {
    const modelRecord = model as Record<string, unknown>
    const provider = requiredString(modelRecord, 'provider')
    const modelId = requiredString(modelRecord, 'model')
    const maxTokens = modelRecord['maxTokens']
    if (maxTokens !== undefined
      && (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens <= 0)) {
      throw new TypeError('webhook Session request model.maxTokens must be a positive safe integer')
    }
    agentOptions = {
      provider,
      model: modelId,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }
    modelSelection = { provider, model: modelId }
  }
  return { workspacePath, title, prompt, agentPreset, permissionPreset, modelSelection, agentOptions }
}

/**
 * Create, attach, title, configure, and prompt one ordinary root Session.
 * Successful prompt admission ends webhook ownership of the operation; the
 * Agent remains lifecycle-owned by `ctx` and follows normal Session behavior.
 *
 * @param ctx - untraced runtime context that owns the resulting Agent.
 * @param delivery - exact verified provider delivery recorded in the message source.
 * @param ruleId - rule that returned the request.
 * @param request - same-process rule result.
 * @param signal - registration lifetime cancellation through publication.
 */
export async function createWebhookSession(
  ctx: Context,
  delivery: VerifiedWebhookDelivery,
  ruleId: WebhookRuleId,
  request: WebhookSessionRequest,
  signal: AbortSignal,
): Promise<void> {
  const resolved = resolveRequest(ctx, request)
  await startWorkspaceSession(
    ctx,
    {
      workspacePath: resolved.workspacePath,
      sessionId: brandString<SessionId>(`webhook-${randomUUID()}`),
      title: resolved.title,
      agentPreset: resolved.agentPreset,
      permissionPreset: resolved.permissionPreset,
      modelSelection: resolved.modelSelection,
      agentOptions: resolved.agentOptions,
      owner: 'webhook',
    },
    createUserMessage({
      content: [{ type: 'text', text: resolved.prompt }],
      source: {
        kind: 'webhook',
        provider: delivery.kind,
        source: delivery.source,
        deliveryId: delivery.deliveryId,
        ruleId,
        form: 'notice',
        summary: boundContextSummary(`${delivery.kind} webhook handled by ${ruleId}`),
      },
    }),
    signal,
  )
}
