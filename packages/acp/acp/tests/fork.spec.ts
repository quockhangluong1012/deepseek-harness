import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

describe('ACP session fork', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    const bridge = harness
    harness = undefined
    await bridge?.dispose()
  })

  it('advertises the unstable session/fork capability', async () => {
    harness = await makeBridgeHarness()
    const initialized = await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })

    expect(initialized.agentCapabilities?.sessionCapabilities?.fork).toEqual({})
  })

  it('forks an active session into an independent seeded session that keeps working', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('first'), textResponse('second')] })
    const bridge = harness
    await bridge.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const parent = bridge.ctx.agents.get(SessionId(sessionId))!
    await bridge.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] })
    const parentEvents = parent.session.snapshotEvents()

    const forked = await bridge.client.forkSession({
      sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })

    expect(forked.sessionId).not.toBe(sessionId)
    const child = bridge.ctx.agents.get(SessionId(forked.sessionId))!
    expect(child.session.header).toMatchObject({ isSeeded: true, parentSession: sessionId })
    expect(child.session.inheritedEventCount).toBe(parentEvents.length)
    expect(child.session.snapshotEvents().slice(0, parentEvents.length)).toEqual(parentEvents)
    // The parent stays fully usable alongside its child.
    expect(parent.status).toBe('idle')

    const reply = await bridge.client.prompt({
      sessionId: forked.sessionId,
      prompt: [{ type: 'text', text: 'continue' }],
    })

    expect(reply.stopReason).toBe('end_turn')
    expect(child.session.header.isSeeded).toBe(true)
  })

  it('forks a stored session that is no longer active', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('first')] })
    const bridge = harness
    await bridge.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const parent = bridge.ctx.agents.get(SessionId(sessionId))!
    await bridge.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] })
    const parentEvents = parent.session.snapshotEvents()
    await bridge.client.closeSession({ sessionId })
    expect(bridge.ctx.agents.get(SessionId(sessionId))).toBeUndefined()

    const forked = await bridge.client.forkSession({ sessionId, cwd: process.cwd(), mcpServers: [] })

    const child = bridge.ctx.agents.get(SessionId(forked.sessionId))!
    expect(child.session.inheritedEventCount).toBe(parentEvents.length)
  })

  it('rejects an unknown, subagent-origin, or additional-directory fork source', async () => {
    harness = await makeBridgeHarness()
    const bridge = harness
    await bridge.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const subagentSessionId = SessionId('acp-fork-subagent-source')
    const handle = await bridge.ctx.agents.create({
      sessionId: subagentSessionId,
      meta: { cwd: process.cwd(), origin: 'subagent' },
    })

    await expect(bridge.client.forkSession({
      sessionId: 'missing-session',
      cwd: process.cwd(),
      mcpServers: [],
    })).rejects.toThrow(/not forkable/)
    await expect(bridge.client.forkSession({
      sessionId: subagentSessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })).rejects.toThrow(/not forkable/)
    await expect(bridge.client.forkSession({
      sessionId: subagentSessionId,
      cwd: process.cwd(),
      mcpServers: [],
      additionalDirectories: [process.cwd()],
    })).rejects.toThrow(/additionalDirectories/)

    await handle.dispose()
  })

  it('rejects a relative cwd before reading any source', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    await expect(harness.client.forkSession({
      sessionId: 'anything',
      cwd: 'relative/dir',
      mcpServers: [],
    })).rejects.toThrow(/cwd must be an absolute path/)
  })
})
