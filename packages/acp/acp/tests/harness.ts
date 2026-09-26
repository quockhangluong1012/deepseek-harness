/** In-memory ACP transport fixture over the real agent factory and loop. */

import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  RequestError,
  type Agent as AcpAgent,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SendRequestOptions,
  type SessionNotification,
  type Stream,
  type WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk'
import AttachmentStore, { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { type GenerateOptions, LlmAdapter, ReasoningEffortId, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as AcpPlugin from '../src/index.ts'
import type { AcpConfig } from '../src/index.ts'

/** Scripted adapter for protocol tests. */
class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: (StreamChunk[] | 'hang')[],
    private readonly imageCapable: boolean,
    private readonly provider = 'mock',
  ) {
    super()
  }

  override providerInfo(provider: string) {
    if (provider !== this.provider) throw new Error(`MockAdapter: unknown provider ${provider}`)
    return { id: this.provider, name: this.provider === 'mock' ? 'Mock' : `Mock ${this.provider}` }
  }

  override listModels(provider: string) {
    return Promise.resolve(provider === this.provider ? [
      {
        provider: this.provider,
        id: 'mock',
        name: 'Mock Reasoner',
        description: 'Mock model with selectable reasoning.',
        inputModalities: this.imageCapable ? ['text', 'image'] as const : ['text'] as const,
      },
      {
        provider: this.provider,
        id: 'plain',
        name: 'Mock Plain',
        inputModalities: ['text'] as const,
      },
    ] : [])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: this.imageCapable && model === 'mock' ? ['text', 'image'] : ['text'],
      context: { contextWindow: 1_024 },
      ...model === 'mock' ? {
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('low'), name: 'Low' },
            { id: ReasoningEffortId('high'), name: 'High' },
          ],
          defaultEffort: ReasoningEffortId('high'),
        },
      } : {},
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('MockAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 2048,
  maxImagePixels: 1024,
  maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/** In-memory durable store for ACP wire-order and lifecycle tests. */
class MemoryAttachmentStore extends AttachmentStore {
  readonly imageLimits = IMAGE_LIMITS
  readonly saved: SaveImageAttachment[] = []
  readonly objects = new Map<string, StoredImageAttachment>()
  beforeValidate: (() => Promise<void>) | undefined
  beforeRead: (() => Promise<void>) | undefined

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await this.beforeValidate?.()
    if (input.data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  }

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    const digest = createHash('sha256').update(input.data).digest('hex')
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${digest}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
    this.objects.set(ref.attachmentId, { ref, data: Uint8Array.from(input.data) })
    return Promise.resolve(ref)
  }

  async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    await this.beforeRead?.()
    const stored = this.objects.get(ref.attachmentId)
    if (stored === undefined) throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    return { ref: stored.ref, data: Uint8Array.from(stored.data) }
  }
}

/** Scripted text response ending in a clean stop. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scripted response ending at the output-token ceiling. */
export function maxTokensResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/** Scripted response that fails after publishing an uncommitted partial chunk. */
export function errorResponse(message: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PROVIDER_ERROR' } } },
  ]
}

export type CapturedUpdate = SessionNotification['update']

/** One fake client terminal created through `terminal/create`. */
export interface FakeTerminal {
  readonly id: string
  readonly sessionId: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string | null | undefined
  readonly env: readonly { name: string; value: string }[]
  /** Output the client returns from `terminal/output`. */
  output: string
  truncated: boolean
  finished: boolean
  exitCode: number | null
  signal: string | null
  killed: boolean
  released: boolean
}

/** Stable-v1 client methods exercised by the bridge tests. */
interface BridgeClient {
  initialize: NonNullable<AcpAgent['initialize']>
  authenticate: NonNullable<AcpAgent['authenticate']>
  newSession: NonNullable<AcpAgent['newSession']>
  listSessions: NonNullable<AcpAgent['listSessions']>
  forkSession: NonNullable<AcpAgent['unstable_forkSession']>
  resumeSession: NonNullable<AcpAgent['resumeSession']>
  closeSession: NonNullable<AcpAgent['closeSession']>
  setSessionConfigOption: NonNullable<AcpAgent['setSessionConfigOption']>
  prompt: (params: PromptRequest, options?: SendRequestOptions) => Promise<PromptResponse>
  cancel: NonNullable<AcpAgent['cancel']>
}

export interface BridgeHarness {
  ctx: Context
  client: BridgeClient
  adapter: MockAdapter
  attachments: MemoryAttachmentStore | undefined
  updates: CapturedUpdate[]
  sessionUpdates: { sessionId: string; update: CapturedUpdate }[]
  permissionRequests: RequestPermissionRequest[]
  /** Files the fake client can serve through `fs/read_text_file`. */
  clientFiles: Map<string, string>
  /** Terminals the fake client created, in creation order. */
  terminals: FakeTerminal[]
  /** Complete one fake terminal with its exit facts and release its waiters. */
  finishTerminal: (terminal: FakeTerminal, outcome?: { exitCode?: number | null; signal?: string | null }) => void
  persistenceRoot: string
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse
  onSessionUpdateError: (() => void) | undefined
  registerCatalogProvider: (provider: string) => () => void
  replacePrimaryProviders: (providers: string[]) => void
  closeClientTransport: () => Promise<void>
  abortClientTransport: () => Promise<void>
  acpFiber: Awaited<ReturnType<Context['plugin']>>
  /** The AgentLoop fiber, so a test can reload the loop out from under the bridge. */
  loopFiber: Awaited<ReturnType<Context['plugin']>>
  dispose: () => Promise<void>
}

type AcpConfigOverrides = { [K in keyof AcpConfig]?: AcpConfig[K] | undefined }

/** Build the bridge and a connected SDK client over cross-wired byte streams. */
export async function makeBridgeHarness(options: {
  script?: (StreamChunk[] | 'hang')[]
  config?: AcpConfigOverrides
  persona?: string
  imageCapable?: boolean
  attachments?: boolean
  persistenceRoot?: string
} = {}): Promise<BridgeHarness> {
  const adapter = new MockAdapter(options.script ?? [], options.imageCapable === true)
  const ctx = new Context()
  const ownsPersistenceRoot = options.persistenceRoot === undefined
  const persistenceRoot = options.persistenceRoot ?? await mkdtemp(join(tmpdir(), 'dsh-acp-test-'))
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: options.persona ?? '' } })
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  await ctx.plugin(TokenMeter)
  if (options.attachments !== false) await ctx.plugin(MemoryAttachmentStore)
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  const primaryAdapter = ctx.llm.registerAdapter(['mock'], adapter)

  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgentWriter = clientToAgent.writable.getWriter()
  const clientOutput = new WritableStream<Uint8Array>({
    write: chunk => clientToAgentWriter.write(chunk),
  })
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientOutput, agentToClient.readable)

  const updates: CapturedUpdate[] = []
  const sessionUpdates: { sessionId: string; update: CapturedUpdate }[] = []
  const permissionRequests: RequestPermissionRequest[] = []
  const clientFiles = new Map<string, string>()
  const terminals: FakeTerminal[] = []
  const terminalExitWaiters = new Map<string, () => void>()
  const harness: BridgeHarness = {
    ctx,
    adapter,
    attachments: ctx.get('attachments') as MemoryAttachmentStore | undefined,
    updates,
    sessionUpdates,
    permissionRequests,
    clientFiles,
    terminals,
    finishTerminal: (terminal, outcome) => {
      terminal.finished = true
      // Omitted facts default to a clean exit; an explicit null reports no
      // code, which is how the client answers for a killed command.
      terminal.exitCode = outcome === undefined ? 0 : outcome.exitCode ?? null
      terminal.signal = outcome === undefined ? null : outcome.signal ?? null
      terminalExitWaiters.get(terminal.id)?.()
      terminalExitWaiters.delete(terminal.id)
    },
    persistenceRoot,
    onPermission: () => ({ outcome: { outcome: 'cancelled' } }),
    onSessionUpdateError: undefined,
    registerCatalogProvider: provider => ctx.llm.registerAdapter([provider], new MockAdapter([], false, provider)),
    replacePrimaryProviders: (providers) => { primaryAdapter.replace(providers) },
    client: undefined as unknown as BridgeClient,
    acpFiber: undefined as unknown as BridgeHarness['acpFiber'],
    loopFiber,
    closeClientTransport: async () => { await clientToAgentWriter.close() },
    abortClientTransport: async () => { await clientToAgentWriter.abort(new Error('client transport failed')) },
    dispose: async () => {
      await ctx.fiber.dispose()
      if (ownsPersistenceRoot) await rm(persistenceRoot, { recursive: true, force: true })
    },
  }

  const clientApp = createAcpClientApp({ name: 'dsh-acp-test-client' })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update)
      sessionUpdates.push({ sessionId: params.sessionId, update: params.update })
      if (harness.onSessionUpdateError !== undefined) return Promise.reject(new Error('client update rejected'))
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissionRequests.push(params)
      return Promise.resolve(harness.onPermission(params))
    })
    .onRequest(methods.client.fs.readTextFile, ({ params }) => {
      const content = harness.clientFiles.get(params.path)
      if (content === undefined) {
        return Promise.reject(RequestError.internalError(undefined, `no such file: ${params.path}`))
      }
      return Promise.resolve({ content })
    })
    .onRequest(methods.client.fs.writeTextFile, ({ params }) => {
      harness.clientFiles.set(params.path, params.content)
      return Promise.resolve({})
    })
    .onRequest(methods.client.terminal.create, ({ params }) => {
      const terminal: FakeTerminal = {
        id: `terminal-${harness.terminals.length + 1}`,
        sessionId: params.sessionId,
        command: params.command,
        args: params.args ?? [],
        cwd: params.cwd,
        env: params.env ?? [],
        output: '',
        truncated: false,
        finished: false,
        exitCode: null,
        signal: null,
        killed: false,
        released: false,
      }
      harness.terminals.push(terminal)
      return Promise.resolve({ terminalId: terminal.id })
    })
    .onRequest(methods.client.terminal.output, ({ params }) => {
      const terminal = harness.terminals.find(candidate => candidate.id === params.terminalId)
      if (terminal === undefined) {
        return Promise.reject(RequestError.internalError(undefined, `no such terminal: ${params.terminalId}`))
      }
      return Promise.resolve({ output: terminal.output, truncated: terminal.truncated })
    })
    .onRequest(methods.client.terminal.waitForExit, ({ params }) => {
      const terminal = harness.terminals.find(candidate => candidate.id === params.terminalId)
      if (terminal === undefined) {
        return Promise.reject(RequestError.internalError(undefined, `no such terminal: ${params.terminalId}`))
      }
      if (terminal.finished) return Promise.resolve({ exitCode: terminal.exitCode, signal: terminal.signal })
      const { promise, resolve } = Promise.withResolvers<WaitForTerminalExitResponse>()
      terminalExitWaiters.set(terminal.id, () => {
        resolve({ exitCode: terminal.exitCode, signal: terminal.signal })
      })
      return promise
    })
    .onRequest(methods.client.terminal.kill, ({ params }) => {
      const terminal = harness.terminals.find(candidate => candidate.id === params.terminalId)
      if (terminal === undefined) {
        return Promise.reject(RequestError.internalError(undefined, `no such terminal: ${params.terminalId}`))
      }
      terminal.killed = true
      harness.finishTerminal(terminal, { exitCode: null, signal: 'SIGKILL' })
      return Promise.resolve({})
    })
    .onRequest(methods.client.terminal.release, ({ params }) => {
      const terminal = harness.terminals.find(candidate => candidate.id === params.terminalId)
      if (terminal === undefined) {
        return Promise.reject(RequestError.internalError(undefined, `no such terminal: ${params.terminalId}`))
      }
      terminal.released = true
      return Promise.resolve({})
    })

  const config = { stream: agentStream, ...options.config } as AcpConfig
  if (!(options.config && 'provider' in options.config)) config.provider = 'mock'
  if (!(options.config && 'model' in options.config)) config.model = 'mock'
  harness.acpFiber = await ctx.plugin({
    name: 'acp-test',
    inject: [...AcpPlugin.inject],
    apply: (inner: Context) => { AcpPlugin.apply(inner, config) },
  })
  const clientConnection = clientApp.connect(clientStream)
  const client = clientConnection.agent
  harness.client = {
    initialize: params => client.request(methods.agent.initialize, params),
    authenticate: params => client.request(methods.agent.authenticate, params),
    newSession: params => client.request(methods.agent.session.new, params),
    listSessions: params => client.request(methods.agent.session.list, params),
    forkSession: params => client.request(methods.agent.session.fork, params),
    resumeSession: params => client.request(methods.agent.session.resume, params),
    closeSession: params => client.request(methods.agent.session.close, params),
    setSessionConfigOption: params => client.request(methods.agent.session.setConfigOption, params),
    prompt: (params, options) => client.request(methods.agent.session.prompt, params, options),
    cancel: params => client.notify(methods.agent.session.cancel, params),
  }
  return harness
}
