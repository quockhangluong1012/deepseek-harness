import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { makeBridgeHarness, textResponse, type BridgeHarness, type CapturedUpdate } from './harness.ts'

/** The last command advertisement the client received, if any. */
function lastAdvertisement(harness: BridgeHarness): CapturedUpdate | undefined {
  return harness.updates.filter(update => update.sessionUpdate === 'available_commands_update').at(-1)
}

describe('ACP command advertisement', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    const bridge = harness
    harness = undefined
    await bridge?.dispose()
  })

  it('publishes the registry view when a session is published and on every registry change', async () => {
    harness = await makeBridgeHarness()
    const bridge = harness
    await bridge.ctx.plugin(CommandRuntime)
    const unregisterCost = bridge.ctx.commands.register({
      name: 'cost',
      description: 'Show accumulated cost',
      input: { hint: 'window' },
      handler: () => ({ kind: 'success', text: 'ok' }),
    })
    await bridge.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await vi.waitFor(() => {
      expect(lastAdvertisement(bridge)).toEqual({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{
          name: 'cost',
          description: 'Show accumulated cost',
          input: { hint: 'window' },
        }],
      })
    })
    expect(bridge.sessionUpdates.at(-1)).toMatchObject({ sessionId })

    const unregisterDoctor = bridge.ctx.commands.register({ name: 'doctor', description: 'Inspect', handler: () => ({ kind: 'success' }) })
    await vi.waitFor(() => {
      const advertisement = lastAdvertisement(bridge)
      expect(advertisement?.sessionUpdate === 'available_commands_update'
        ? advertisement.availableCommands.map(command => command.name)
        : []).toEqual(['cost', 'doctor'])
    })

    unregisterCost()
    unregisterDoctor()
    await vi.waitFor(() => {
      const advertisement = lastAdvertisement(bridge)
      expect(advertisement?.sessionUpdate === 'available_commands_update'
        ? advertisement.availableCommands
        : undefined).toEqual([])
    })
  })

  it('advertises the resumed session view again', async () => {
    harness = await makeBridgeHarness()
    const bridge = harness
    await bridge.ctx.plugin(CommandRuntime)
    bridge.ctx.commands.register({ name: 'help', description: 'List commands', handler: () => ({ kind: 'success' }) })
    await bridge.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await bridge.client.closeSession({ sessionId })
    bridge.updates.length = 0

    await bridge.client.resumeSession({ sessionId, cwd: process.cwd(), mcpServers: [] })

    await vi.waitFor(() => {
      expect(lastAdvertisement(bridge)).toMatchObject({ availableCommands: [{ name: 'help' }] })
    })
  })

  it('advertises nothing when no command registry is composed', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('done')] })
    const bridge = harness
    expect(bridge.ctx.get('commands')).toBeUndefined()
    await bridge.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await bridge.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    expect(lastAdvertisement(bridge)).toBeUndefined()
  })
})

describe('ACP command dispatch', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    const bridge = harness
    harness = undefined
    await bridge?.dispose()
  })

  /** Publish one session over a fresh bridge client. */
  async function openSession(bridge: BridgeHarness): Promise<string> {
    await bridge.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    return (await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
  }

  it('executes a submitted command line and settles the work its handler starts', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('deployed')] })
    const bridge = harness
    await bridge.ctx.plugin(CommandRuntime)
    const inputs: string[] = []
    bridge.ctx.commands.register({
      name: 'deploy',
      description: 'Deploy the service',
      handler: (invocation) => {
        inputs.push(invocation.rawInput)
        invocation.agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'Deploy staging.' }],
          source: { kind: 'user' },
        }))
        return { kind: 'success', text: 'Submitted /deploy' }
      },
    })
    const sessionId = await openSession(bridge)

    await expect(bridge.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/deploy staging' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })

    // The handler received the line exactly and its model work reached the client
    // before the prompt settled.
    expect(inputs).toEqual([' staging'])
    expect(bridge.updates.some(update => update.sessionUpdate === 'agent_message_chunk'
      && update.content.type === 'text' && update.content.text === 'deployed')).toBe(true)
  })

  it('fails an unknown command instead of submitting the slash line as chat', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answered')] })
    const bridge = harness
    await bridge.ctx.plugin(CommandRuntime)
    bridge.ctx.commands.register({ name: 'help', description: 'List commands', handler: () => ({ kind: 'success' }) })
    const sessionId = await openSession(bridge)

    await expect(bridge.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/missing' }] }))
      .rejects.toThrow(/unknown or malformed command: \/missing/)
    // The only text on the wire is the advertisement: no turn ran.
    expect(bridge.updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(false)
  })

  it('fails a command line when the host composes no command registry', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answered')] })
    const bridge = harness
    expect(bridge.ctx.get('commands')).toBeUndefined()
    const sessionId = await openSession(bridge)

    await expect(bridge.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/help' }] }))
      .rejects.toThrow(/composes no command registry/)
  })

  it('leaves a leading-slash task that is not a command line to the model', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answered')] })
    const bridge = harness
    await bridge.ctx.plugin(CommandRuntime)
    bridge.ctx.commands.register({ name: 'help', description: 'List commands', handler: () => ({ kind: 'success' }) })
    const sessionId = await openSession(bridge)

    // `/tmp` is not a command name followed by end-of-input or whitespace, so
    // the line stays the model's task rather than failing as an unknown command.
    await expect(bridge.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/tmp/report is stale' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    expect(bridge.updates.some(update => update.sessionUpdate === 'agent_message_chunk'
      && update.content.type === 'text' && update.content.text === 'answered')).toBe(true)
  })

  it('cancels a dispatched command with session/cancel', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answered')] })
    const bridge = harness
    await bridge.ctx.plugin(CommandRuntime)
    let started = false
    let aborted = false
    bridge.ctx.commands.register({
      name: 'slow',
      description: 'Wait for cancellation',
      handler: (invocation) => {
        started = true
        const { promise, resolve } = Promise.withResolvers<CommandResult>()
        invocation.signal.addEventListener('abort', () => {
          aborted = true
          resolve({ kind: 'success' })
        }, { once: true })
        return promise
      },
    })
    const sessionId = await openSession(bridge)

    const pending = bridge.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/slow' }] })
    await vi.waitFor(() => { expect(started).toBe(true) })
    await bridge.client.cancel({ sessionId })

    await expect(pending).resolves.toEqual({ stopReason: 'cancelled' })
    expect(aborted).toBe(true)
  })
})
