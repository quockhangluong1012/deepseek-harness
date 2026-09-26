/**
 * Model-facing `job_output`, `job_monitor`, `job_list`, and `job_kill` tools
 * over `ctx.jobs`. Loading the plugin attaches the controller required by
 * producers. It also delivers completions the model has not already
 * collected to the owning agent: injected into a busy owner's next step, or
 * opening a turn on an idle one under the default `wakeup` delivery, unbounded
 * unless `maxConsecutiveWakes` caps it per owner.
 * @module @deepseek-ai/dsh-tool-jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobView, JobRead } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import { publicJob, renderModelDelta, statusLine } from './render.ts'
import type { PublicJobSnapshot } from './render.ts'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tool-jobs': { kind: 'tool-jobs' } & ContextFormed
  }
}

export const name = 'tool-jobs'
export const inject = ['tools', 'jobs', 'systemPrompt']

/**
 * How an uncollected completion reaches an owner that is already idle: `wakeup`
 * opens a turn for it, `quiet` leaves it pending until something else wakes the
 * owner. A busy owner is injected either way.
 */
export type CompletionDelivery = 'quiet' | 'wakeup'

/** Configures bounded job waits (`job_output` with `wait`, `job_monitor`) and completion-notice delivery. */
export interface Config {
  /** Wait duration applied when a wait omits `timeout_ms` (default 30s). */
  waitTimeoutMs?: number
  /** Hard cap on any single wait; a larger model-supplied `timeout_ms` is clamped down to it (default 10min). */
  maxWaitTimeoutMs?: number
  /** Whether a completion opens a turn on an idle owner (default `wakeup`). */
  completionDelivery?: CompletionDelivery
  /**
   * Turns one owner may have opened by completion wakes before the next
   * notice degrades to injection, reset by any user-authored input. Absent by
   * default: every idle completion wakes its owner. Set it to bound the
   * self-exciting chain where a woken turn starts the job whose completion
   * wakes it again, at the cost of notices past the cap waiting silently for
   * the next user input.
   */
  maxConsecutiveWakes?: number
}

export const Config: z<Config> = z.object({
  waitTimeoutMs: z.number().min(1).default(30_000),
  maxWaitTimeoutMs: z.number().min(1).default(600_000),
  completionDelivery: z.union(['quiet', 'wakeup'] as const).default('wakeup'),
  maxConsecutiveWakes: z.number().min(1),
})

/** Shared schema for job-control outputs. */
const PUBLIC_JOB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    label: { type: 'string', required: true },
    status: {
      type: 'string',
      required: true,
      enum: ['running', 'stopping', 'completed', 'killed', 'failed'],
    },
    detail: { type: 'string' },
    startedAt: { type: 'integer', required: true },
    finishedAt: { type: 'integer' },
  },
} as const

const encoder = new TextEncoder()

function retainTail(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'tail', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function retainHead(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function fitWithSuffix(
  content: string,
  suffix: string,
  maxBytes: number | undefined,
  omitted: string,
): string {
  const complete = `${content}${suffix}`
  if (maxBytes === undefined || encoder.encode(complete).byteLength <= maxBytes) return complete
  const fixed = `${content.endsWith(omitted.trimStart()) ? '' : omitted}${suffix}`
  const fixedBytes = encoder.encode(fixed).byteLength
  if (fixedBytes >= maxBytes) return retainTail(fixed, maxBytes)
  return `${retainTail(content, maxBytes - fixedBytes)}${fixed}`
}

/**
 * One-line account of a settled job for the `notice` form's collapsed row.
 * @param job - the settled job.
 * @returns its kind, label, and status, bounded like every notice summary.
 */
function completionSummary(job: JobView): string {
  return boundContextSummary(`${job.kind} ${job.label} ${statusLine(publicJob(job))}`)
}

function fitCompletionNotice(job: JobView): string {
  const prefix = `background job ${job.id}`
  const detail = ` (${job.kind}: ${job.label}) finished ${statusLine(publicJob(job))}`
  const action = '\nDone; job_output.'
  const complete = `${prefix}${detail}. Read its output with job_output.`
  const maxBytes = job.outputLimitBytes
  if (maxBytes === undefined || encoder.encode(complete).byteLength <= maxBytes) return complete
  const omitted = '\n[notice truncated]'
  const fixed = `${prefix}${omitted}${action}`
  const fixedBytes = encoder.encode(fixed).byteLength
  if (fixedBytes <= maxBytes) {
    return fixedBytes === maxBytes
      ? fixed
      : `${prefix}${retainHead(detail, maxBytes - fixedBytes)}${omitted}${action}`
  }
  const compact = `${prefix}${action}`
  const compactBytes = encoder.encode(compact).byteLength
  if (compactBytes <= maxBytes) return compact
  const actionBytes = encoder.encode(action).byteLength
  if (actionBytes >= maxBytes) return retainTail(action, maxBytes)
  return `${retainHead(prefix, maxBytes - actionBytes)}${action}`
}

function rawSingleText(content: readonly ContentBlock[]): string | undefined {
  if (content.length !== 1) return undefined
  const block = content[0]
  if (block?.type !== 'text') return undefined
  return block.text
}

function boundSingleText(content: readonly ContentBlock[], maxBytes: number): ContentBlock[] | undefined {
  const text = rawSingleText(content)
  if (text === undefined) return undefined
  return [{
    type: 'text',
    text: fitWithSuffix(text, '', maxBytes, '\n[result truncated]'),
  }]
}

/** The producer's cap for the job a `job_output`, `job_monitor`, or `job_kill` call names, when it is visible to the caller. */
function visibleOutputLimit(ctx: Context, exec: ToolExecution): number | undefined {
  if (exec.name !== 'job_output' && exec.name !== 'job_monitor' && exec.name !== 'job_kill') return undefined
  const jobId = (exec.arguments as { job_id?: unknown } | null | undefined)?.job_id
  if (typeof jobId !== 'string' || jobId.length === 0) return undefined
  return ctx.jobs.list(exec.agent?.id).find(job => job.id === jobId)?.outputLimitBytes
}

/** Validate the non-empty constraint that ParameterSchemaSpec cannot express. */
function validateJobId(value: string): JobId {
  if (value.length === 0) {
    throw new Error(`invalid job_id: expected a non-empty string, got ${JSON.stringify(value)}`)
  }
  return JobId(value)
}

/**
 * Compile one monitor pattern into a matcher reporting the text it matched.
 * @param pattern - literal substring, or the regular-expression source when `regex`.
 * @param regex - true to interpret `pattern` as a case-sensitive JavaScript regular expression.
 * @returns a matcher returning the matched text, or `undefined` when the pattern is absent.
 */
function compileMatcher(pattern: string, regex: boolean | undefined): (text: string) => string | undefined {
  if (pattern.length === 0) throw new Error('pattern must be a non-empty string')
  if (regex !== true) return text => text.includes(pattern) ? pattern : undefined
  let compiled: RegExp
  try {
    compiled = new RegExp(pattern)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid regex pattern ${JSON.stringify(pattern)}: ${reason}`)
  }
  return (text) => {
    const matched = compiled.exec(text)
    return matched === null ? undefined : matched[0]
  }
}

/** Pending presentation shared by the generic job controls. */
function presentJobCall(title: string, kind: 'read' | 'execute', rawInput?: string): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput !== undefined ? { rawInput } : {} }
}

/** The consuming read as the model sees it: the delta, then the result once, then the status line. */
function readBody(read: JobRead): { text: string; job: PublicJobSnapshot } {
  const delta = renderModelDelta(read.chunks, read.lossy, read.job.output.spillPaths ?? [])
  const text = read.result === undefined
    ? delta
    : `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${read.result}`
  return { text, job: publicJob(read.job) }
}

export function apply(ctx: Context, config: Config): void {
  const waitDefault = config.waitTimeoutMs ?? 30_000
  const waitCap = config.maxWaitTimeoutMs ?? 600_000
  const delivery = config.completionDelivery ?? 'wakeup'
  const wakeBudget = config.maxConsecutiveWakes

  // Turns this plugin opened on each owner since that owner last consumed
  // human input. Keyed by the exact Agent, so a same-session replacement
  // starts with a full budget.
  const spentWakes = new WeakMap<Agent, number>()
  if (waitDefault > waitCap) {
    throw new Error(`tool-jobs: waitTimeoutMs (${waitDefault}) exceeds maxWaitTimeoutMs (${waitCap})`)
  }
  // A budget is a count of turns: a fraction never names a turn, and
  // `Infinity` would spell an "unbounded" that omitting the field already means.
  if (wakeBudget !== undefined && !Number.isSafeInteger(wakeBudget)) {
    throw new Error(`tool-jobs: maxConsecutiveWakes (${wakeBudget}) must be a whole number of turns`)
  }
  // Nothing spends the budget under quiet delivery or without a cap, so
  // nothing needs to refill it.
  if (delivery === 'wakeup' && wakeBudget !== undefined) {
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      // Claiming is the point the human's input actually enters a step; a notice
      // this plugin itself queued must not refill the budget it just spent.
      if (message.source.kind === 'user') spentWakes.delete(agent)
    })
  }

  const outputLimits = new WeakMap<ToolExecution, number>()
  ctx.on('tools/pre-execute', (exec, next) => {
    const maxBytes = visibleOutputLimit(ctx, exec)
    if (maxBytes !== undefined) outputLimits.set(exec, maxBytes)
    return next()
  }, { prepend: true })
  const finalizeJobContent: NonNullable<ToolDefinition['finalizeContent']> = (exec, result) => {
    const maxBytes = outputLimits.get(exec) ?? visibleOutputLimit(ctx, exec)
    outputLimits.delete(exec)
    if (maxBytes === undefined) return undefined
    if (exec.name === 'job_output' && !result.isError) {
      // This definition owns and schema-validates the canonical value. Preserve
      // its output/status split only while policy left the default rendering intact.
      const value = result.value as unknown as { text: string; job: PublicJobSnapshot }
      const body = value.text.length > 0 ? value.text : '(no new output)'
      const content = body.endsWith('\n') ? body.slice(0, -1) : body
      const suffix = `\n${statusLine(value.job)}`
      if (rawSingleText(result.content) === `${content}${suffix}`) {
        return [{
          type: 'text',
          text: fitWithSuffix(content, suffix, maxBytes, '\n[output truncated]'),
        }]
      }
    }
    return boundSingleText(result.content, maxBytes)
  }

  // Producers may start work only while a controller is attached.
  ctx.jobs.attachController('tool-jobs')

  // Cross-call guidance follows the filesystem sections and precedes product sections.
  ctx.systemPrompt.section({
    name: 'tool:jobs',
    order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS'),
    text: 'Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job\'s work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.',
  })

  // Live jobs whose kill the model itself requested through `job_kill`: that
  // tool result is the model's delivery, so the settlement notice would only
  // repeat it. A wait needs no entry here — the registry reports a settlement
  // that released a live wait as `awaited`, whichever plugin was waiting.
  const killedByModel = new Set<JobId>()

  // A busy owner is injected: the notice waits in its next-step inbox, which
  // the turn cannot close over, so jobs settling together cost one step. An
  // idle owner is woken instead, because an undelivered notice is a completion
  // the model never learns about. Either way, disposal before delivery
  // discards it with the owner, and a teardown settlement has no reader left.
  //
  // The registry routes each settlement to the scope this plugin was mounted
  // under, so a mount under one preset never sees another preset's agents;
  // this listener owns delivery, not the choice of whom to deliver to.
  ctx.jobs.events.subscribe({ owners: 'scope' }, (event) => {
    if (event.type === 'removed') {
      killedByModel.delete(event.job.id)
      return
    }
    if (event.type !== 'settled') return
    const delivered = killedByModel.delete(event.job.id) || event.awaited
    if (delivered || event.cause === 'teardown' || event.job.owner === undefined) return
    // The destination is the agent registered for the owner session now. An
    // owned job needed the agent registry to start, so the registry is only
    // absent here when it left before settlement — and then no inbox is left.
    const owner = ctx.get('agents')?.get(event.job.owner)
    if (owner === undefined) return
    const message = createUserMessage({
      content: [{
        type: 'text',
        text: fitCompletionNotice(event.job),
      }],
      source: {
        kind: 'tool-jobs',
        form: 'notice',
        summary: completionSummary(event.job),
      },
    })
    if (delivery === 'wakeup' && owner.status === 'idle') {
      if (wakeBudget === undefined) {
        owner.followup(message)
        return
      }
      const spent = spentWakes.get(owner) ?? 0
      if (spent < wakeBudget) {
        spentWakes.set(owner, spent + 1)
        owner.followup(message)
        return
      }
    }
    owner.inject(message)
  })

  ctx.tools.register(defineTool({
    name: 'job_output',
    description: 'Read a background job. Stream jobs return only output since the previous read; '
      + 'final-output jobs return their result after settlement. Every response ends with '
      + '`[status: ...]`. Reads are non-blocking unless `wait: true`, which waits up to the configured cap.',
    // A timed-out wait returns job state rather than a TOOL_TIMEOUT error, so
    // this tool owns its deadline instead of using ToolDefinition.timeoutMs.
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by the tool that started the background work.' },
      wait: { type: 'boolean', description: 'Block until the job reaches a terminal status or the timeout expires. A timed-out wait returns [status: running] and leaves the job alive.' },
      timeout_ms: { type: 'integer', description: 'Max wait in milliseconds (only meaningful with wait: true). Must be a positive integer. Defaults to the configured wait timeout; capped by the configured maximum.' },
    },
    finalizeContent: finalizeJobContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          job: { ...PUBLIC_JOB_SCHEMA, required: true },
        },
      },
      render: (_args, value) => {
        const body = value.text.length > 0 ? value.text : '(no new output)'
        const separator = body.endsWith('\n') ? '' : '\n'
        return [{ type: 'text', text: `${body}${separator}${statusLine(value.job)}` }]
      },
    },
    async execute(args, exec) {
      const id = validateJobId(args.job_id)
      const jobs = ctx.jobs
      if (args.wait === true) {
        if (args.timeout_ms !== undefined && (!Number.isSafeInteger(args.timeout_ms) || args.timeout_ms <= 0)) {
          throw new Error(`timeout_ms must be a positive integer of milliseconds, got ${JSON.stringify(args.timeout_ms)}`)
        }
        // A settlement that releases this wait is reported `awaited`, so the
        // notice listener above skips it: this result carries the terminal
        // state. A timed-out or aborted wait has left the registry's waiter
        // set before any later settlement, which then notifies as usual.
        await jobs.wait(id, Math.min(args.timeout_ms ?? waitDefault, waitCap), exec.agent?.id, exec.signal)
      }
      return readBody(jobs.read(id, exec.agent?.id))
    },
    presentCall: args => presentJobCall(`Read output from background job ${args.job_id}`, 'read', args.job_id),
  }))

  ctx.tools.register(defineTool({
    name: 'job_monitor',
    description: 'Wait until a background job\'s output matches a pattern, then return the matched text. '
      + 'The wait is bounded by the configured cap and reads the retained output without consuming it, so a later '
      + 'job_output still returns everything. It ends early when the job settles without matching. The pattern is a '
      + 'case-sensitive literal substring unless `regex: true` makes it a case-sensitive JavaScript regular expression.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by the tool that started the background work.' },
      pattern: { type: 'string', required: true, description: 'Non-empty text to wait for: a literal substring, or a JavaScript regular-expression source when `regex: true`.' },
      regex: { type: 'boolean', description: 'Interpret `pattern` as a case-sensitive JavaScript regular expression instead of a literal substring. Defaults to false.' },
      timeout_ms: { type: 'integer', description: 'Max wait in milliseconds. Must be a positive integer. Defaults to the configured wait timeout; capped by the configured maximum.' },
    },
    finalizeContent: finalizeJobContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matched: { type: 'boolean', required: true },
          excerpt: { type: 'string', required: true },
          lossy: { type: 'boolean', required: true },
          job: { ...PUBLIC_JOB_SCHEMA, required: true },
        },
      },
      render: (args, value) => {
        const cause = value.matched
          ? 'matched'
          : value.job.finishedAt === undefined ? 'has not matched yet' : 'ended without matching'
        const lines = [`job ${value.job.id} ${cause} ${JSON.stringify(args.pattern)}:`]
        if (value.excerpt.length > 0) lines.push(value.excerpt.replace(/\n+$/u, ''))
        if (value.lossy) lines.push('[only retained output was matched; earlier bytes were dropped]')
        lines.push(statusLine(value.job))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const id = validateJobId(args.job_id)
      const match = compileMatcher(args.pattern, args.regex)
      if (args.timeout_ms !== undefined && (!Number.isSafeInteger(args.timeout_ms) || args.timeout_ms <= 0)) {
        throw new Error(`timeout_ms must be a positive integer of milliseconds, got ${JSON.stringify(args.timeout_ms)}`)
      }
      const expiresAt = Date.now() + Math.min(args.timeout_ms ?? waitDefault, waitCap)
      const caller = exec.agent?.id
      // The parked scan's resolver. Everything between two `await`s below is
      // synchronous, so an append that lands while this call scans wakes the
      // next scan instead of being missed.
      let wake: (() => void) | undefined
      const abortScan = (): void => { wake?.() }
      exec.signal.addEventListener('abort', abortScan, { once: true })
      const unsubscribe = ctx.jobs.events.subscribe(
        caller === undefined ? { owners: 'all' } : { owner: caller },
        (event) => {
          const eventId = event.type === 'settled' ? event.job.id : event.type === 'output' ? event.id : undefined
          if (eventId !== id) return
          wake?.()
        },
      )
      try {
        for (;;) {
          // ponytail: rescan the retained window per event; the ring's retention
          // cap bounds it, so an incremental cursor is not worth the carry state.
          const read = ctx.jobs.readAt(id, 0, caller)
          // `log` chunks are producer narration the model cannot read back.
          const text = read.chunks
            .filter(chunk => chunk.channel !== 'log')
            .map(chunk => chunk.text)
            .join('')
          const job = publicJob(ctx.jobs.get(id, caller))
          const matched = match(text)
          if (matched !== undefined) return { matched: true, excerpt: matched, lossy: read.lossy, job }
          if (job.status === 'completed' || job.status === 'killed' || job.status === 'failed'
            || Date.now() >= expiresAt) {
            return { matched: false, excerpt: text, lossy: read.lossy, job }
          }
          if (exec.signal.aborted) throw new Error('job_monitor aborted')
          const next = new Promise<void>((resolve) => { wake = resolve })
          const timer = setTimeout(() => wake?.(), expiresAt - Date.now())
          try {
            await next
          } finally {
            clearTimeout(timer)
          }
        }
      } finally {
        exec.signal.removeEventListener('abort', abortScan)
        unsubscribe()
      }
    },
    presentCall: args => presentJobCall(`Wait for matching output from background job ${args.job_id}`, 'read', args.job_id),
  }))

  ctx.tools.register(defineTool({
    name: 'job_list',
    description: 'List your background jobs (running and finished) with their ids, kinds, and statuses.',
    parameters: {},
    output: {
      schema: { type: 'array', items: PUBLIC_JOB_SCHEMA },
      render: (_args, jobs) => [{
        type: 'text',
        text: jobs.length === 0
          ? '(no background jobs)'
          : jobs.map(t => `${t.id} [${t.kind}] ${t.status} — ${t.label}`).join('\n'),
      }],
    },
    execute(_args, exec) {
      const jobs = ctx.jobs.list(exec.agent?.id)
      return Promise.resolve(jobs.map(publicJob))
    },
    presentCall: () => presentJobCall('List background jobs', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'job_kill',
    description: 'Request cancellation of a running background job by job id. Returns immediately; the job settles as killed once its work actually stops.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by the tool that started the background work.' },
      reason: { type: 'string', description: 'Optional short reason, recorded in the log and forwarded to the job.' },
    },
    finalizeContent: finalizeJobContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: {
            type: 'string',
            required: true,
            enum: ['cancellation-requested', 'already-finished'],
          },
          job: { ...PUBLIC_JOB_SCHEMA, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.outcome === 'already-finished'
          ? `job ${value.job.id} had already finished ${statusLine(value.job)}`
          : `requested cancellation of job ${value.job.id}`,
      }],
    },
    execute(args, exec) {
      const id = validateJobId(args.job_id)
      const jobs = ctx.jobs
      const result = jobs.kill(id, exec.agent?.id, args.reason)
      // The model's own kill is its delivery: the settlement notice would only
      // repeat what this tool result already said.
      if (result === 'requested') killedByModel.add(id)
      // A projection describes current state without consuming pending output.
      const job = publicJob(jobs.get(id, exec.agent?.id))
      return Promise.resolve({
        outcome: result === 'already-finished' ? 'already-finished' as const : 'cancellation-requested' as const,
        job,
      })
    },
    presentCall: args => presentJobCall(`Kill background job ${args.job_id}`, 'execute', args.job_id),
  }))
}
