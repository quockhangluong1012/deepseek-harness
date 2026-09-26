/**
 * The kernel command line: read-only commands over the kernel events a stored
 * session already carries. `dsh task show`, `dsh task verify`, `dsh task
 * checkpoint`, and `dsh policy explain` fold one session log through
 * {@link readKernelRecord} and print the record; nothing here starts an agent,
 * calls a model, or appends to a log.
 *
 * Commands read through the owning seams — `ctx.sessionQuery` for the log —
 * rather than opening storage themselves, so a deployment's session backend
 * choice (JSONL files, a durable corpus) stays its own.
 * @module @deepseek-ai/dsh-kernel-ops
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { readKernelMetrics, readKernelRecord, type KernelRecord, type VerificationResult } from '@deepseek-ai/dsh-agent-kernel'
import { parseCmdline, type AppExit } from '@deepseek-ai/dsh-cmdline'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { internals } from './internals.ts'
import type {} from '@deepseek-ai/dsh-evolution-lineage'
import { metricsJson, metricsLines, lineageJson, lineageLines, policyJson, policyLines, taskJson, taskLines, verificationLines } from './report.ts'

/** Stable Cordis plugin name. */
export const name = 'kernel-ops'

/** The command line reads stored sessions through the persistence seam. */
export const inject = ['sessionPersistence', 'agentKernel']

/** Options every informational command accepts. */
interface PrintOptions {
  /** Print JSON instead of text. */
  json?: boolean
}

/**
 * One session's folded kernel record.
 *
 * The read handle holds no write ownership, so a command over a session a
 * running app is still appending to observes the durable prefix.
 * @param ctx - the mounted context.
 * @param rawSessionId - the session id the caller named.
 * @returns the folded record and the events it was folded from.
 * @throws When the session does not exist or holds no `task/created` event.
 */
async function readRecord(ctx: Context, rawSessionId: string): Promise<{ record: KernelRecord; events: SessionEvent[] }> {
  const handle = await ctx.sessionPersistence.open(SessionId(rawSessionId), 'read')
  try {
    const { events } = await handle.read()
    const record = readKernelRecord(events)
    if (record === undefined) {
      throw new Error(`session ${JSON.stringify(rawSessionId)} holds no task record`)
    }
    return { record, events: [...events] }
  } finally {
    await handle.close()
  }
}

/**
 * Wait for the optional lineage store to finish mounting, polling instead of
 * a hard `inject`: task/policy commands must keep working in a deployment
 * that never mounts it, so the plugin cannot block its own startup on it.
 * A store genuinely absent from the tree reports so after `timeoutMs`.
 * @param ctx - the mounted context.
 * @param timeoutMs - how long to poll before giving up.
 * @returns the mounted store, or undefined once the deadline passes.
 */
async function awaitLineage(ctx: Context, timeoutMs = 300): Promise<Context['evolutionLineage'] | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lineage = ctx.get('evolutionLineage')
    if (lineage !== undefined) return lineage
    if (Date.now() >= deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/**
 * Every recorded verification result, in log order.
 * @param events - the session's events.
 * @returns the results.
 */
function verificationResults(events: readonly SessionEvent[]): VerificationResult[] {
  return events
    .filter(event => event.type === 'verification/result')
    .map(event => (event).data)
}

/**
 * Print lines as text, or one JSON value when `--json` was passed.
 * @param options - the command's print options.
 * @param lines - the text form.
 * @param json - the JSON form.
 */
function print(options: PrintOptions, lines: readonly string[], json: () => unknown): void {
  if (options.json === true) {
    internals.write(`${JSON.stringify(json(), null, 2)}\n`)
    return
  }
  internals.write(`${lines.join('\n')}\n`)
}

/**
 * Whether a task record may be reported complete: its newest verification
 * passed and no failure is unresolved.
 * @param record - the folded kernel record.
 * @param results - the recorded verification results.
 * @returns the completion gate's verdict for the stored record.
 */
function gateAllows(record: KernelRecord, results: readonly VerificationResult[]): boolean {
  return results.at(-1)?.status === 'pass' && record.unresolvedFailures.length === 0
}

/**
 * Build the ops command line. Exported so a test (or an embedding host) can
 * parse it without a launcher.
 * @param ctx - the mounted context.
 * @param exit - the launcher's bounded exit request.
 * @returns the program whose actions run the commands.
 */
export function kernelOpsCommand(ctx: Context, exit: AppExit): Command {
  /** Run one command body, reporting a failure through the launcher's exit path. */
  const run = (body: () => Promise<number>): void => {
    void body().then(
      (code) => { exit(code) },
      (error: unknown) => {
        internals.writeError(`${error instanceof Error ? error.message : String(error)}\n`)
        exit(1)
      },
    )
  }

  const program = new Command('dsh')
  program
    .exitOverride()
    .description('inspect the agent kernel record of a stored session')

  const task = program.command('task').description('inspect one stored session\'s task record')

  task.command('show <session-id>')
    .description('print the task contract, its plan, and the record\'s counts')
    .option('--json', 'print the record as JSON')
    .action((sessionId: string, options: PrintOptions) => {
      run(async () => {
        const { record } = await readRecord(ctx, sessionId)
        print(options, taskLines(record), () => taskJson(record))
        return 0
      })
    })

  task.command('verify <session-id>')
    .description('report the session\'s recorded verification outcome and completion gate')
    .option('--json', 'print the outcome as JSON')
    .action((sessionId: string, options: PrintOptions) => {
      run(async () => {
        const { record, events } = await readRecord(ctx, sessionId)
        const results = verificationResults(events)
        print(options, verificationLines(record, results), () => ({ results, gate: gateAllows(record, results) ? 'pass' : 'blocked' }))
        // A blocked gate is a finding, not a command failure: the exit code
        // exists so a script can branch on it.
        return gateAllows(record, results) ? 0 : 1
      })
    })

  task.command('checkpoint <session-id>')
    .description('print the newest checkpoint the session recorded')
    .option('--json', 'print the checkpoint as JSON')
    .action((sessionId: string, options: PrintOptions) => {
      run(async () => {
        const { record } = await readRecord(ctx, sessionId)
        const checkpoint = record.checkpoint
        if (checkpoint === undefined) {
          internals.write(`session ${JSON.stringify(sessionId)} recorded no checkpoint\n`)
          return 1
        }
        print(options, [
          `checkpoint: ${checkpoint.checkpointId}`,
          `task: ${checkpoint.taskId}`,
          `run: ${checkpoint.runId}`,
          `session: ${checkpoint.agentSessionId}`,
          `reason: ${checkpoint.reason}`,
          `status: ${checkpoint.status}`,
          `revision: ${String(checkpoint.revision)}`,
          `sessionSeq: ${String(checkpoint.sessionSeq)}`,
          `openActions: ${checkpoint.openActionIds.join(', ') || 'none'}`,
          `unresolvedFailures: ${checkpoint.unresolvedFailures.map(failure => failure.kind).join(', ') || 'none'}`,
          `createdAt: ${new Date(checkpoint.createdAt).toISOString()}`,
        ], () => checkpoint)
        return 0
      })
    })

  task.command('metrics <session-id>')
    .description('print the counters this session\'s kernel events imply')
    .option('--json', 'print the metrics as JSON')
    .action((sessionId: string, options: PrintOptions) => {
      run(async () => {
        const handle = await ctx.sessionPersistence.open(SessionId(sessionId), 'read')
        try {
          const { events } = await handle.read()
          const metrics = readKernelMetrics(events)
          print(options, metricsLines(metrics), () => metricsJson(metrics))
        } finally {
          await handle.close()
        }
        return 0
      })
    })

  task.command('recover-scan')
    .description('classify every stored session\'s non-terminal task: resumable, repairable, or blocked')
    .option('--json', 'print the classifications as JSON')
    .action((options: PrintOptions) => {
      run(async () => {
        const entries = await ctx.agentKernel.startupRecovery
        if (options.json === true) {
          internals.write(`${JSON.stringify(entries, null, 2)}\n`)
        } else if (entries.length === 0) {
          internals.write('nothing to recover: every stored session is either terminal or holds no task\n')
        } else {
          internals.write(`${entries.map(entry => `${entry.sessionId}: ${entry.classification} — ${entry.reason}`).join('\n')}\n`)
        }
        return entries.some(entry => entry.classification !== 'resumable') ? 1 : 0
      })
    })

  const policy = program.command('policy').description('explain one recorded policy decision')

  policy.command('explain <session-id> <action-id>')
    .description('print the proposal, its composed decision, and the approval outcome')
    .option('--json', 'print the decision as JSON')
    .action((sessionId: string, actionId: string, options: PrintOptions) => {
      run(async () => {
        const { record } = await readRecord(ctx, sessionId)
        print(options, policyLines(record, actionId), () => policyJson(record, actionId))
        return 0
      })
    })

  const evolution = program.command('evolution').description('inspect one recorded evolution experiment')

  evolution.command('replay <run-id>')
    .description('print the recorded experiment envelope: dependencies, metrics, and the seeds it ran')
    .option('--json', 'print the envelope as JSON')
    .action((runId: string, options: PrintOptions) => {
      run(async () => {
        const lineage = await awaitLineage(ctx)
        if (lineage === undefined) {
          internals.writeError('the evolution lineage store is not mounted\n')
          return 1
        }
        const envelope = lineage.replay(runId)
        if (envelope === undefined) {
          internals.writeError(`unknown experiment ${JSON.stringify(runId)}\n`)
          return 1
        }
        print(options, lineageLines(envelope), () => lineageJson(envelope))
        return 0
      })
    })

  return program
}

/**
 * Parse this app's command line as an ordinary Cordis plugin. The launcher
 * provides the inner arguments and the exit request before the tree mounts;
 * each command action prints its result and then requests exit.
 * @param ctx - the mounted context.
 */
export function apply(ctx: Context): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('kernel-ops: the launcher must provide ctx.appExit before the tree mounts')
  }
  parseCmdline(ctx, kernelOpsCommand(ctx, exit))
}
