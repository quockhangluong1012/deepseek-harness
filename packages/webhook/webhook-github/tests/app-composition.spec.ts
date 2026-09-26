/** Real Loader composition and delivery-id suppression for the GitHub app rules. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebhookRuntime, { WebhookDeliveryId, WebhookSourceId } from '@deepseek-ai/dsh-webhook'
import type { VerifiedWebhookDelivery, WebhookRule, WebhookSessionRequest } from '@deepseek-ai/dsh-webhook'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as GitHubApp from '../src/app.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** One delivery the app answers, or one it ignores when the event name differs. */
function delivery(deliveryId: string, eventName = 'pull_request'): VerifiedWebhookDelivery<'github'> {
  return {
    kind: 'github',
    source: WebhookSourceId('loader'),
    deliveryId: WebhookDeliveryId(deliveryId),
    event: eventName === 'pull_request'
      ? {
        name: eventName,
        payload: {
          action: 'ready_for_review',
          number: 314,
          repository: { full_name: 'deepseek-ai/deepseek-harness' },
          pull_request: { title: 'Add the app', head: { sha: 'head-sha' } },
        },
      }
      : { name: eventName, payload: {} },
    receivedAt: 1,
  }
}

/**
 * The shipped runtime with each registered rule observed on the way in. The
 * wrapper records the real rule's request and returns `null`, so this suite
 * needs no Agent, Workspace, preset, or Session stack.
 */
class ObservedRuntime extends WebhookRuntime {
  /** Delivery ids every rule invocation received, in invocation order. */
  readonly invocations: string[] = []
  /** Requests the wrapped rules returned, in invocation order. */
  readonly requests: (WebhookSessionRequest | null)[] = []
  /** Whether each invocation received the runtime's frozen delivery. */
  readonly frozen: boolean[] = []

  override register<K extends string>(rule: WebhookRule<K>): () => Promise<void> {
    return super.register({
      ...rule,
      run: async (delivery, signal) => {
        this.invocations.push(delivery.deliveryId)
        this.frozen.push(Object.isFrozen(delivery) && Object.isFrozen(delivery.event))
        const request = await rule.run(delivery, signal)
        this.requests.push(request)
        return null
      },
    })
  }
}

describe('real Loader composition', () => {
  it('answers one pull request once and ignores its redelivery', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-webhook-github-app-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: fixture-runtime',
      "- name: '@deepseek-ai/dsh-webhook-github/app'",
      '  config:',
      '    source: loader',
      '    repository: deepseek-ai/deepseek-harness',
      '    workspacePath: /workspace',
      '    agentPreset: standard',
      '    permissionPreset: read-only',
      '',
    ].join('\n'))

    let runtime!: ObservedRuntime
    const dependencies = {
      name: 'fixture-runtime',
      apply(ctx: Context) {
        runtime = new ObservedRuntime(ctx)
      },
    }
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules: Record<string, unknown> = {
      'fixture-runtime': dependencies,
      '@deepseek-ai/dsh-webhook-github/app': GitHubApp,
    }
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!(specifier in modules)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules[specifier]
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()
    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])

    context.webhookRuntime.dispatch(delivery('loader-delivery'))
    context.webhookRuntime.dispatch(delivery('loader-delivery'))
    context.webhookRuntime.dispatch(delivery('other-delivery', 'issues'))
    await vi.waitFor(() => { expect(runtime.invocations).toHaveLength(4) })
    expect(runtime.invocations).toEqual([
      'loader-delivery', 'loader-delivery', 'other-delivery', 'other-delivery',
    ])
    expect(runtime.requests).toEqual([
      {
        workspacePath: '/workspace',
        agentPreset: 'standard',
        permissionPreset: 'read-only',
        title: 'Review deepseek-ai/deepseek-harness#314',
        prompt: expect.stringContaining('event_metadata_json:') as string,
      },
      null,
      null,
      null,
    ])
    expect(runtime.frozen).toEqual([true, true, true, true])
  })
})
