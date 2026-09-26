/** Explicit product usage events over OTLP/HTTP; no automatic collection or Session access. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SeverityNumber, type Logger } from '@opentelemetry/api-logs'
import { validateHeaderValue } from 'node:http'
import { JsonLogsSerializer, JsonMetricsSerializer } from '@opentelemetry/otlp-transformer'
import { createOtlpHttpExportDelegate, getSharedConfigurationFromEnvironment, httpAgentFactoryFromOptions } from '@opentelemetry/otlp-exporter-base/node-http'
import { CompressionAlgorithm, getSharedConfigurationDefaults, mergeOtlpSharedConfigurationWithDefaults, OTLPExporterBase } from '@opentelemetry/otlp-exporter-base'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import { AggregationTemporality, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
// Type-only: the session events and approval vocabulary the metric intake folds.
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval/types'
// The scrubber is a leaf module with no service dependencies; the subpath import
// keeps the session-telemetry service out of this plugin's runtime graph.
import { scrubSensitiveValue } from '@deepseek-ai/dsh-session-telemetry/src/sensitive.ts'
import { SessionMetrics } from './metrics.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    productTelemetry: ProductTelemetry
  }
}

/** Scalar values accepted by the collector's Arrow attributes map. */
export type ProductTelemetryScalar = string | number | boolean

/** Explicitly selected analytics fields; object values may contain scalars only. */
export interface ProductTelemetryRecord {
  /** Product/DA-owned event name. */
  eventName: string
  /** Human-readable summary; never a prompt, response, credential, or file contents. */
  body: string
  /** Event occurrence time in Unix milliseconds. Observation time is assigned on enqueue. */
  timestamp: number
  /** OTel severity; omitted values use INFO. */
  severityNumber?: SeverityNumber
  /** Business fields selected by the caller; no automatic device or account identity. */
  attributes?: Record<string, ProductTelemetryScalar | Record<string, ProductTelemetryScalar>>
}

/** Collector routing, application identity, and bounded in-memory batch settings. */
export interface Config {
  /** Full HTTP(S) logs URL. */
  endpoint: string
  /** Full HTTP(S) metrics URL; omission disables metric collection and export entirely. */
  metricsEndpoint?: string
  /** Collector routing header. */
  channel: string
  /** Resource service.name supplied by the application composition. */
  serviceName: string
  /** Resource service.version supplied by the application composition. */
  serviceVersion: string
  /** Omit to honor OTEL_EXPORTER_OTLP_LOGS_COMPRESSION / OTEL_EXPORTER_OTLP_COMPRESSION. */
  compression?: 'none' | 'gzip'
  /** Maximum records per export; must not exceed maxQueueSize. */
  maxExportBatchSize: number
  /** Maximum queued records; the SDK drops new records when full. */
  maxQueueSize: number
  /** Log partial-batch delay, and the metric export interval; with metrics enabled the SDK rejects a value below exportTimeoutMillis. */
  scheduledDelayMillis: number
  /** Exporter HTTP deadline, including SDK transient-error retries. */
  timeoutMillis: number
  /** Log processor or metric reader deadline for one batch export. */
  exportTimeoutMillis: number
  /** Outer shutdown wait per provider; pending telemetry may be lost after this deadline. */
  shutdownTimeoutMillis: number
}

const positiveInteger = () => z.number().step(1).min(1).max(2_147_483_647)

/** Loader validation and defaults for application compositions. */
export const Config: z<Partial<Config>, Config> = z.object({
  endpoint: z.string().default('https://dsh-otel-collector.deepseeksvc.com/v1/logs'),
  metricsEndpoint: z.string(),
  channel: z.string().min(1).default('dsh_otel_report'),
  serviceName: z.string().required(),
  serviceVersion: z.string().required(),
  compression: z.union(['none', 'gzip']),
  maxExportBatchSize: positiveInteger().default(512),
  maxQueueSize: positiveInteger().default(2048),
  scheduledDelayMillis: positiveInteger().default(30000),
  timeoutMillis: positiveInteger().default(15000),
  exportTimeoutMillis: positiveInteger().default(20000),
  shutdownTimeoutMillis: positiveInteger().default(21000),
})

/**
 * Validate one collector URL field before the service is registered.
 * @param field - configuration field naming the rejected value.
 * @param value - the configured URL.
 */
function assertCollectorUrl(field: 'endpoint' | 'metricsEndpoint', value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new Error(`product-telemetry-otel: ${field} must be a valid HTTP(S) URL`, { cause })
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`product-telemetry-otel: ${field} must use HTTP or HTTPS`)
  }
}

/**
 * Explicit OTLP transport for one signal: this deployment's URL, routing header,
 * and agent. Only the shared timeout and compression use SDK environment
 * resolution, so this collector never inherits another endpoint's headers or
 * TLS client identity.
 * @param config - validated plugin configuration.
 * @param signal - the signal whose environment variables supply shared defaults.
 * @param url - the signal's validated collector URL.
 * @returns the transport for {@link createOtlpHttpExportDelegate}.
 */
function collectorTransport(config: Config, signal: 'LOGS' | 'METRICS', url: string) {
  const shared = mergeOtlpSharedConfigurationWithDefaults({
    timeoutMillis: config.timeoutMillis,
    ...(config.compression === undefined ? {} : {
      compression: config.compression === 'gzip' ? CompressionAlgorithm.GZIP : CompressionAlgorithm.NONE,
    }),
  }, getSharedConfigurationFromEnvironment(signal), getSharedConfigurationDefaults())
  return {
    ...shared,
    url,
    headers: () => Promise.resolve({ 'Content-Type': 'application/json', 'x-channel': config.channel }),
    agentFactory: httpAgentFactoryFromOptions({ keepAlive: true }),
  }
}

/**
 * Observe export completions through one local warning: the SDK can resolve a
 * flush or shutdown after a rejected export, so the delegate's own result is
 * the only delivery signal.
 * @param exporter - the signal's OTLP exporter.
 * @param ctx - host context for the local warning.
 * @param failure - warning text for a permanent export failure.
 * @returns the exporter half the SDK processor or metric reader calls.
 */
function observingExporter<T>(exporter: OTLPExporterBase<T>, ctx: Context, failure: string) {
  return {
    export: (items: T, callback: (result: ExportResult) => void) => {
      exporter.export(items, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) ctx.logger.warn(failure, result.error)
        callback(result)
      })
    },
    forceFlush: () => exporter.forceFlush(),
    shutdown: () => exporter.shutdown(),
  }
}

/**
 * Bound one provider's SDK shutdown so disposal never outlives the configured
 * deadline; expiry reports possible loss instead of hanging the fiber.
 * @param ctx - host context for the local warning.
 * @param config - validated shutdown budget.
 * @param signal - the telemetry kind named in an expiry warning.
 * @param shutdown - the provider's shutdown sequence.
 * @returns the disposer to register as an effect.
 */
function boundedDrain(
  ctx: Context,
  config: Config,
  signal: 'events' | 'metrics',
  shutdown: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    const deadline = Promise.withResolvers<void>()
    const timer = setTimeout(() => {
      ctx.logger.warn(`Product telemetry shutdown deadline exceeded; pending ${signal} may be lost`)
      deadline.resolve()
    }, config.shutdownTimeoutMillis)
    try {
      await Promise.race([shutdown(), deadline.promise])
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Scrub one caller-supplied string with the repository's shared sensitive-value
 * patterns.
 * @param text - caller-supplied text.
 * @returns the text with each sensitive shape replaced.
 */
function scrubText(text: string): string {
  const scrubbed = scrubSensitiveValue(text)
  /* v8 ignore next -- scrubSensitiveValue returns a string for a string input. */
  return typeof scrubbed === 'string' ? scrubbed : text
}

/**
 * Scrub every string a caller selected for export, keeping the record's
 * declared envelope and scalar shape.
 * @param record - caller-owned record.
 * @returns the record with sensitive text replaced by the shared placeholder.
 */
function scrubRecord(record: ProductTelemetryRecord): ProductTelemetryRecord {
  const body = scrubText(record.body)
  if (record.attributes === undefined) return { ...record, body }
  const attributes: Record<string, ProductTelemetryScalar | Record<string, ProductTelemetryScalar>> = {}
  for (const [key, value] of Object.entries(record.attributes)) {
    attributes[key] = typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([name, scalar]) => [name, typeof scalar === 'string' ? scrubText(scalar) : scalar]))
      : typeof value === 'string' ? scrubText(value) : value
  }
  return { ...record, body, attributes }
}

/** Host analytics sender. Mounting alone sends nothing; the owning fiber drains it on unload. */
export default class ProductTelemetry extends Service {
  static Config = Config
  private readonly logger: Logger

  constructor(ctx: Context, config: Config) {
    assertCollectorUrl('endpoint', config.endpoint)
    if (config.metricsEndpoint !== undefined) assertCollectorUrl('metricsEndpoint', config.metricsEndpoint)
    try {
      validateHeaderValue('x-channel', config.channel)
    } catch (cause) {
      throw new Error('product-telemetry-otel: channel must be a valid HTTP header value', { cause })
    }
    if (config.maxExportBatchSize > config.maxQueueSize) {
      throw new Error('product-telemetry-otel: maxExportBatchSize must not exceed maxQueueSize')
    }
    super(ctx, 'productTelemetry')
    const resource = resourceFromAttributes({
      'service.name': config.serviceName,
      'service.version': config.serviceVersion,
    })
    const exporter = new OTLPExporterBase(createOtlpHttpExportDelegate(collectorTransport(config, 'LOGS', config.endpoint), JsonLogsSerializer))
    const provider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor({
        maxExportBatchSize: config.maxExportBatchSize,
        maxQueueSize: config.maxQueueSize,
        scheduledDelayMillis: config.scheduledDelayMillis,
        exportTimeoutMillis: config.exportTimeoutMillis,
        exporter: observingExporter(exporter, ctx, 'Product telemetry export failed'),
      })],
    })
    this.logger = provider.getLogger('@deepseek-ai/dsh-host-product-telemetry-otel')
    ctx.effect(() => boundedDrain(ctx, config, 'events', () => provider.shutdown()))
    if (config.metricsEndpoint !== undefined) {
      const metricExporter = new OTLPExporterBase(createOtlpHttpExportDelegate(collectorTransport(config, 'METRICS', config.metricsEndpoint), JsonMetricsSerializer))
      const meterProvider = new MeterProvider({
        resource,
        readers: [new PeriodicExportingMetricReader({
          exportIntervalMillis: config.scheduledDelayMillis,
          exportTimeoutMillis: config.exportTimeoutMillis,
          exporter: {
            ...observingExporter(metricExporter, ctx, 'Product telemetry metric export failed'),
            // The collector receives cumulative sums and histograms.
            selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
          },
        })],
      })
      const metrics = new SessionMetrics(ctx, meterProvider.getMeter('@deepseek-ai/dsh-host-product-telemetry-otel'))
      ctx.on('session/event', (session, event) => { metrics.observe(session, event) })
      ctx.effect(() => boundedDrain(ctx, config, 'metrics', () => meterProvider.shutdown()))
    }
  }

  /**
   * Enqueue one selected product event without waiting for network delivery.
   * Queue admission and shutdown completion are not collector or warehouse acknowledgements.
   * @param record - caller-owned event containing only approved analytics fields.
   */
  emit(record: ProductTelemetryRecord): void {
    const scrubbed = scrubRecord(record)
    const severityNumber = scrubbed.severityNumber ?? SeverityNumber.INFO
    this.logger.emit({
      ...scrubbed,
      observedTimestamp: Date.now(),
      severityNumber,
      severityText: SeverityNumber[severityNumber],
    })
  }
}
