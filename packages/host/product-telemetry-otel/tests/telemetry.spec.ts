import { createServer, type IncomingHttpHeaders } from 'node:http'
import { once } from 'node:events'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { LlmModelCost, TokenUsage } from '@deepseek-ai/dsh-llm'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import { LoggerProvider } from '@opentelemetry/sdk-logs'
import { SeverityNumber } from '@opentelemetry/api-logs'
import ProductTelemetry, { Config } from '../src/index.ts'

/** One decoded metric data point: its attributes plus its sum value or histogram counters. */
interface MetricPoint {
  attributes: { key: string; value: { stringValue?: string } }[]
  asInt?: number
  asDouble?: number
  count?: number
}

/** One decoded metric with its sum or histogram data points. */
interface MetricRecord {
  name: string
  sum?: { dataPoints: MetricPoint[] }
  histogram?: { dataPoints: MetricPoint[] }
}

interface Capture {
  path: string
  headers: IncomingHttpHeaders
  body: {
    resourceLogs?: { resource: unknown; scopeLogs: { logRecords: Record<string, unknown>[] }[] }[]
    resourceMetrics?: { scopeMetrics: { metrics: MetricRecord[] }[] }[]
  }
}
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  } finally {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

beforeEach(() => {
  vi.stubEnv('OTEL_EXPORTER_OTLP_COMPRESSION', undefined)
  vi.stubEnv('OTEL_EXPORTER_OTLP_LOGS_COMPRESSION', undefined)
  vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_COMPRESSION', undefined)
})

async function collector(statuses = [200]) {
  const captures: Capture[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const bytes = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
      captures.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(bytes.toString()) as Capture['body'] })
      res.writeHead(statuses.shift() ?? 200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  cleanup.push(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('collector has no port')
  return {
    captures,
    endpoint: `http://127.0.0.1:${address.port}/v1/logs`,
    metricsEndpoint: `http://127.0.0.1:${address.port}/v1/metrics`,
  }
}

function config(endpoint: string, overrides: Partial<Config> = {}): Config {
  return Config({ endpoint, serviceName: 'synthetic-test', serviceVersion: '1', scheduledDelayMillis: 60_000, ...overrides })
}

function context() {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  return ctx
}

/** Every metric every capture carried, in export order. */
function metricsOf(captures: readonly Capture[]): MetricRecord[] {
  return captures.flatMap(capture =>
    capture.body.resourceMetrics?.flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics)) ?? [])
}

/** The data points of one exported metric, failing rather than passing on its absence. */
function pointsOf(metrics: readonly MetricRecord[], name: string): MetricPoint[] {
  const metric = metrics.find(candidate => candidate.name === name)
  if (metric === undefined) throw new Error(`metric ${name} was not exported`)
  const points = metric.sum?.dataPoints ?? metric.histogram?.dataPoints
  if (points === undefined) throw new Error(`metric ${name} carried no data points`)
  return points
}

/** The numeric value of one sum data point. */
function valueOf(point: MetricPoint): number {
  const value = point.asInt ?? point.asDouble
  if (value === undefined) throw new Error('metric data point carried no numeric value')
  return value
}

/** The value of one string attribute, or undefined when the point omits it. */
function attributeOf(point: MetricPoint, key: string): string | undefined {
  return point.attributes.find(attribute => attribute.key === key)?.value.stringValue
}

const event = { eventName: 'telemetry.synthetic', body: 'Synthetic test', timestamp: 1_800_000_000_000 }

const USAGE: TokenUsage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, totalTokens: 170 }
const RATES: LlmModelCost = { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.5, cacheWritePerMTok: 0.5 }

/** One attempt stream carrying a provider usage sample. */
function usageStream(usage: TokenUsage): SessionEvent<'assistant/attempt'>['data']['stream'] {
  return [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage } }]
}

/** Append one turn holding a billed attempt, a tool call, and one approval pair. */
function loggedTurn(session: Session, usage: TokenUsage = USAGE): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/context', { provider: 'synthetic', model: 'synthetic-model' })
  session.append('assistant/attempt', { turn: 1, step: 1, stream: usageStream(usage) })
  session.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'synthetic_tool', arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId('c1'), content: [{ type: 'text', text: 'ok' }], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId('unknown'), content: [{ type: 'text', text: 'repaired' }], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('approval/asked', { id: ApprovalRequestId('a1'), toolName: 'synthetic_tool' })
  session.append('approval/decided', { id: ApprovalRequestId('a1'), outcome: 'allowed-once' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

describe('explicit product telemetry', () => {
  it.each(['gzip', 'none', undefined] as const)('drains typed events with %s compression and removes the service', async (compression) => {
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint, compression === undefined ? {} : { compression }))
    const service = ctx.productTelemetry
    expect(target.captures).toEqual([])
    service.emit({ ...event, attributes: { text: 'test', count: 2, duration: 1.5, synthetic: true, model: { provider: 'test', count: 1, enabled: false } } })
    service.emit({ ...event, severityNumber: SeverityNumber.ERROR })
    await fiber.dispose()
    expect(ctx.get('productTelemetry')).toBeUndefined()
    service.emit(event)
    expect(target.captures).toHaveLength(1)
    const [capture] = target.captures
    expect(capture?.headers['x-channel']).toBe('dsh_otel_report')
    expect(capture?.headers['content-encoding']).toBe(compression === 'gzip' ? 'gzip' : undefined)
    const logs = capture?.body.resourceLogs?.flatMap(r => r.scopeLogs.flatMap(s => s.logRecords))
    expect(logs).toHaveLength(2)
    expect(logs?.[0]).toMatchObject({
      eventName: event.eventName, body: { stringValue: event.body }, severityNumber: 9,
      timeUnixNano: '1800000000000000000',
    })
    expect(logs?.[0]?.['attributes']).toEqual(expect.arrayContaining([
      { key: 'text', value: { stringValue: 'test' } },
      { key: 'count', value: { intValue: 2 } },
      { key: 'duration', value: { doubleValue: 1.5 } },
      { key: 'synthetic', value: { boolValue: true } },
      { key: 'model', value: { kvlistValue: { values: [{ key: 'provider', value: { stringValue: 'test' } }, { key: 'count', value: { intValue: 1 } }, { key: 'enabled', value: { boolValue: false } }] } } },
    ]))
    expect(Number(logs?.[0]?.['observedTimeUnixNano'])).toBeGreaterThan(0)
    expect(logs?.[1]?.['severityNumber']).toBe(17)
    expect(JSON.stringify(capture)).not.toContain('user.id')
  })

  it('isolates collector headers from ambient OpenTelemetry credentials', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=Bearer%20synthetic-secret,x-user-id=synthetic-user')
    vi.stubEnv('OTEL_EXPORTER_OTLP_LOGS_HEADERS', 'x-log-token=synthetic-token,x-channel=other-collector')
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint))
    ctx.productTelemetry.emit(event)
    await fiber.dispose()
    expect(target.captures).toHaveLength(1)
    expect(target.captures[0]?.headers).toMatchObject({ 'x-channel': 'dsh_otel_report' })
    expect(target.captures[0]?.headers).not.toHaveProperty('authorization')
    expect(target.captures[0]?.headers).not.toHaveProperty('x-user-id')
    expect(target.captures[0]?.headers).not.toHaveProperty('x-log-token')
    expect(process.env['OTEL_EXPORTER_OTLP_HEADERS']).toContain('synthetic-secret')
  })

  it('does not export on mount or empty shutdown', async () => {
    const target = await collector()
    const fiber = await context().plugin(ProductTelemetry, config(target.endpoint))
    await fiber.dispose()
    expect(target.captures).toEqual([])
  })

  it('exports at the batch threshold and retries a transient rejection', async () => {
    const target = await collector([503, 200])
    const ctx = context()
    await ctx.plugin(ProductTelemetry, config(target.endpoint, { maxExportBatchSize: 1 }))
    ctx.productTelemetry.emit(event)
    await vi.waitFor(() => { expect(target.captures).toHaveLength(2) }, { timeout: 10_000 })
    expect(target.captures[0]?.body).toEqual(target.captures[1]?.body)
  })

  it('exports a partial batch on its configured interval', async () => {
    const target = await collector()
    const ctx = context()
    await ctx.plugin(ProductTelemetry, config(target.endpoint, { scheduledDelayMillis: 10 }))
    ctx.productTelemetry.emit(event)
    await vi.waitFor(() => { expect(target.captures).toHaveLength(1) })
  })

  it('reports a permanent export rejection without failing the caller', async () => {
    const target = await collector([400])
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint))
    expect(() => { ctx.productTelemetry.emit(event) }).not.toThrow()
    await fiber.dispose()
    expect(target.captures).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith('Product telemetry export failed', expect.any(Error))
  })

  it('scrubs sensitive text from caller records before export', async () => {
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint))
    ctx.productTelemetry.emit({
      ...event,
      body: 'retrying with sk-abcdefghij1234567890',
      attributes: { authorization: 'Bearer 1234567890abcdefghij', retries: 1, nested: { token: 'AKIAIOSFODNN7EXAMPLE' } },
    })
    await fiber.dispose()
    const [capture] = target.captures
    const logs = capture?.body.resourceLogs?.flatMap(r => r.scopeLogs.flatMap(s => s.logRecords))
    expect(logs?.[0]?.['body']).toEqual({ stringValue: 'retrying with [REDACTED]' })
    expect(logs?.[0]?.['attributes']).toEqual(expect.arrayContaining([
      { key: 'authorization', value: { stringValue: '[REDACTED]' } },
      { key: 'retries', value: { intValue: 1 } },
      { key: 'nested', value: { kvlistValue: { values: [{ key: 'token', value: { stringValue: '[REDACTED]' } }] } } },
    ]))
    expect(JSON.stringify(capture)).not.toContain('sk-abcdefghij1234567890')
  })

  it('exports tokens, cost, tool latency, and approvals from the logged session events', async () => {
    const target = await collector()
    const ctx = context()
    await ctx.plugin(SessionStore)
    const resolve = vi.fn(() => Promise.resolve({ provider: 'synthetic', id: 'synthetic-model', name: 'Synthetic', cost: RATES }))
    ctx.provide('llm', { resolveModelInfo: resolve } as never)
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint, { metricsEndpoint: target.metricsEndpoint }))
    const session = ctx.sessions.create(SessionId('billed'))
    loggedTurn(session)
    await fiber.dispose()
    expect(ctx.get('productTelemetry')).toBeUndefined()

    const metrics = metricsOf(target.captures)
    const tokens = pointsOf(metrics, 'dsh.tokens')
    expect(tokens).toHaveLength(3)
    expect(tokens.map(point => [attributeOf(point, 'token.type'), valueOf(point)])).toEqual(expect.arrayContaining([
      ['input', 120], ['output', 50], ['cache_read', 20],
    ]))
    expect(tokens.map(point => [attributeOf(point, 'provider'), attributeOf(point, 'model')]))
      .toEqual([['synthetic', 'synthetic-model'], ['synthetic', 'synthetic-model'], ['synthetic', 'synthetic-model']])

    const cost = pointsOf(metrics, 'dsh.cost_usd')
    expect(cost).toHaveLength(1)
    expect(valueOf(cost[0]!)).toBeCloseTo(0.00021, 12)
    expect([attributeOf(cost[0]!, 'provider'), attributeOf(cost[0]!, 'model')]).toEqual(['synthetic', 'synthetic-model'])
    expect(resolve).toHaveBeenCalledTimes(1)

    const duration = pointsOf(metrics, 'dsh.tool.duration')
    expect(duration).toHaveLength(1)
    expect(duration[0]?.count).toBe(1)
    expect([attributeOf(duration[0]!, 'tool.name'), attributeOf(duration[0]!, 'tool.outcome')]).toEqual(['synthetic_tool', 'ok'])

    expect(pointsOf(metrics, 'dsh.approvals.requested').map(point => attributeOf(point, 'tool.name'))).toEqual(['synthetic_tool'])
    expect(pointsOf(metrics, 'dsh.approvals.decided').map(point => attributeOf(point, 'outcome'))).toEqual(['allowed-once'])
    expect(target.captures.map(capture => capture.path)).toEqual(['/v1/metrics'])
    expect(target.captures[0]?.headers['x-channel']).toBe('dsh_otel_report')
  })

  it('attributes a message sample to its own route and an unroutable sample to unknown', async () => {
    const target = await collector()
    const ctx = context()
    await ctx.plugin(SessionStore)
    ctx.provide('llm', { resolveModelInfo: () => Promise.resolve({ provider: 'synthetic', id: 'm', name: 'M' }) } as never)
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint, { metricsEndpoint: target.metricsEndpoint }))
    const session = ctx.sessions.create(SessionId('routed'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [], usage: USAGE,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'routed' }], source: { provider: 'message-provider', model: 'message-model' } }),
    }, { surfaceOp: 'append' })
    session.append('assistant/attempt', { turn: 1, step: 1, stream: usageStream({ inputTokens: -1, outputTokens: 0 }) })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('assistant/message', {
      turn: 2, step: 1, stream: [], usage: USAGE,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'unrouted' }], source: { provider: '', model: '' } }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await fiber.dispose()

    const tokens = pointsOf(metricsOf(target.captures), 'dsh.tokens')
    expect(tokens.map(point => [attributeOf(point, 'provider'), attributeOf(point, 'model')])).toEqual([
      ['message-provider', 'message-model'], ['message-provider', 'message-model'], ['message-provider', 'message-model'],
      ['unknown', 'unknown'], ['unknown', 'unknown'], ['unknown', 'unknown'],
    ])
  })

  it('exports a recorded tool error with its outcome attribute', async () => {
    const target = await collector()
    const ctx = context()
    await ctx.plugin(SessionStore)
    ctx.provide('llm', { resolveModelInfo: () => Promise.reject(new Error('unregistered route')) } as never)
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint, { metricsEndpoint: target.metricsEndpoint }))
    const session = ctx.sessions.create(SessionId('failing'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/context', { provider: 'synthetic', model: 'synthetic-model' })
    session.append('assistant/attempt', { turn: 1, step: 1, stream: usageStream(USAGE) })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'failing_tool', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('c1'), content: [{ type: 'text', text: 'boom' }], isError: true }),
      error: { name: 'HarnessError', code: 'BOOM' },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await fiber.dispose()

    const captures = target.captures
    const metrics = metricsOf(captures)
    expect(pointsOf(metrics, 'dsh.tokens')).toHaveLength(3)
    expect(metrics.map(metric => metric.name)).not.toContain('dsh.cost_usd')
    const duration = pointsOf(metrics, 'dsh.tool.duration')
    expect([attributeOf(duration[0]!, 'tool.name'), attributeOf(duration[0]!, 'tool.outcome')]).toEqual(['failing_tool', 'error'])
  })

  it('collects no metrics when no metrics endpoint is configured', async () => {
    const target = await collector()
    const ctx = context()
    await ctx.plugin(SessionStore)
    ctx.provide('llm', { resolveModelInfo: () => Promise.resolve({ provider: 'synthetic', id: 'm', name: 'M', cost: RATES }) } as never)
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint))
    const session = ctx.sessions.create(SessionId('unconfigured'))
    loggedTurn(session)
    await fiber.dispose()
    expect(target.captures).toEqual([])
  })

  it('exports nothing after disposal', async () => {
    const target = await collector()
    const ctx = context()
    await ctx.plugin(SessionStore)
    ctx.provide('llm', { resolveModelInfo: () => Promise.resolve({ provider: 'synthetic', id: 'm', name: 'M', cost: RATES }) } as never)
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint, { metricsEndpoint: target.metricsEndpoint }))
    const session = ctx.sessions.create(SessionId('disposed'))
    loggedTurn(session)
    await fiber.dispose()
    const settled = target.captures.length
    expect(settled).toBe(1)
    loggedTurn(ctx.sessions.create(SessionId('after-disposal')))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(target.captures).toHaveLength(settled)
  })

  it.each([
    { endpoint: 'broken' }, { endpoint: 'ftp://collector.test/logs' },
    { metricsEndpoint: 'broken' }, { metricsEndpoint: 'ftp://collector.test/metrics' }, { metricsEndpoint: '' },
    { channel: '' }, { channel: 'bad\nchannel' }, { channel: '中文' }, { timeoutMillis: 0 },
    { maxExportBatchSize: 0 }, { maxExportBatchSize: 2, maxQueueSize: 1 },
    { maxQueueSize: -1 }, { scheduledDelayMillis: 0 }, { exportTimeoutMillis: Infinity },
    { shutdownTimeoutMillis: 2_147_483_648 },
  ])('rejects invalid configuration %j before exposing the service', (invalid) => {
    const ctx = context()
    expect(() => new ProductTelemetry(ctx, config('http://collector.test/v1/logs', invalid))).toThrow()
    expect(ctx.get('productTelemetry')).toBeUndefined()
  })

  it.each([
    [{ endpoint: 'broken' }, 'endpoint must be a valid HTTP(S) URL'],
    [{ endpoint: 'ftp://collector.test/logs' }, 'endpoint must use HTTP or HTTPS'],
    [{ channel: 'bad\nchannel' }, 'channel must be a valid HTTP header value'],
    [{ metricsEndpoint: 'broken' }, 'metricsEndpoint must be a valid HTTP(S) URL'],
    [{ metricsEndpoint: 'ftp://collector.test/metrics' }, 'metricsEndpoint must use HTTP or HTTPS'],
  ] as const)('names invalid transport fields before registering the service', (invalid, message) => {
    const ctx = context()
    expect(() => new ProductTelemetry(ctx, config('http://collector.test/v1/logs', invalid)))
      .toThrow(`product-telemetry-otel: ${message}`)
    expect(ctx.get('productTelemetry')).toBeUndefined()
  })

  it.each([
    ['OTEL_EXPORTER_OTLP_COMPRESSION', 'gzip'],
    ['OTEL_EXPORTER_OTLP_LOGS_COMPRESSION', 'gzip'],
  ])('honors %s when compression is omitted', async (name, value) => {
    vi.stubEnv(name, value)
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint))
    ctx.productTelemetry.emit(event)
    await fiber.dispose()
    expect(target.captures[0]?.headers['content-encoding']).toBe('gzip')
  })

  it('bounds a stalled shutdown and observes its later settlement', async () => {
    const target = await collector()
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint, { shutdownTimeoutMillis: 20 }))
    const pending = Promise.withResolvers<undefined>()
    vi.spyOn(LoggerProvider.prototype, 'shutdown').mockReturnValue(pending.promise)
    vi.useFakeTimers()
    const disposal = fiber.dispose()
    await vi.advanceTimersByTimeAsync(20)
    await disposal
    expect(warn).toHaveBeenCalledWith('Product telemetry shutdown deadline exceeded; pending events may be lost')
    pending.resolve(undefined)
    await pending.promise
    await vi.advanceTimersByTimeAsync(0)
  })
})
