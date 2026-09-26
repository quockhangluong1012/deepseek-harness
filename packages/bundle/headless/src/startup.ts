/**
 * The one-shot app's command-line provider: it parses the task positional, the
 * run flags (`--session-id`, `--resume`, `--continue`, `--json`, `--model`,
 * `--permission-mode`, `--max-turns`, `--system-prompt`, `--allowed-tools`,
 * `--output-schema`), and `--help`, then publishes
 * {@link HEADLESS_STARTUP_SERVICE}. The runner is an ordinary consumer whose
 * lazy config waits for that service. Every flag is validated here — shape,
 * syntax, and self-contained schema content — while values whose validity
 * depends on the mounted tree (a model id, a permission preset, a tool name)
 * are checked by the runner at the earliest point the tree can answer them.
 * @module @deepseek-ai/dsh-headless/startup
 */

import { readFileSync } from 'node:fs'
import { Command, CommanderError } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { boundJsonLine } from './json-stream.ts'
import { internals } from './startup-internals.ts'

/** Stable Cordis plugin name. */
export const name = 'headless-startup'

/** Services required before the task can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the one-shot runner. */
export const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/** What the runner row reads from {@link HEADLESS_STARTUP_SERVICE}. */
export interface HeadlessStartupValues {
  /** The task text this invocation asked for; absent when the runner reads stdin. */
  task: string | undefined
  /** Exact Session identity to adopt; absent for a fresh random identity. */
  sessionId: string | undefined
  /** Whether stdout carries the machine-readable event stream instead of final text. */
  json: boolean
  /** Model id overriding the deployment default selection; absent keeps the composed selection. */
  model?: string
  /** Permission preset pinning this run's Session; absent keeps the composed default. */
  permissionMode?: string
  /** Ceiling on assistant steps this run's turn may enter; absent keeps the composed loop ceiling. */
  maxTurns?: number
  /** Text replacing this run's system prompt; absent keeps the composed prompt. */
  systemPrompt?: string
  /** Global tool names this run keeps visible; absent admits every composed tool. */
  allowedTools?: readonly string[]
  /** Object-rooted JSON Schema the run's final answer must satisfy; absent reports the final text. */
  outputSchema?: ObjectJsonSchema
  /** Whether to adopt the newest Session recorded in this working directory. */
  continueLatest?: boolean
}

/**
 * Options whose following token is their value. The `--json` scan skips those
 * values, so a literal `--json` given as one never installs the JSON error
 * override.
 */
const VALUE_OPTIONS: Readonly<Record<string, true>> = {
  '--session-id': true,
  '--resume': true,
  '--model': true,
  '--permission-mode': true,
  '--max-turns': true,
  '--system-prompt': true,
  '--allowed-tools': true,
  '--output-schema': true,
}

/**
 * This app's command: the task positional, its options, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function headlessCommand(): Command {
  return new Command()
    .name('dsh --profile headless')
    .description('Answer one task and exit; the answer goes to stdout and diagnostics to stderr.')
    .helpOption('-h, --help', 'show this help')
    .option('--json', 'write newline-delimited run events to stdout instead of the final message')
    .option('--session-id <id>', 'adopt the persisted Session with this id; an unknown id is an error')
    .option('--resume <id>', 'same adoption as --session-id, spelled for resuming a recorded run')
    .option('--continue', 'adopt the newest Session recorded in this working directory')
    .option('--model <model>', 'model id for this run, overriding the deployment default selection')
    .option('--permission-mode <mode>', 'permission preset pinning this run (a preset of the composed permission table)')
    .option('--max-turns <n>', 'refuse the (n+1)th assistant step of this run, ending its turn')
    .option('--system-prompt <text>', 'replace this run\'s system prompt with exactly this text')
    .option('--allowed-tools <names>', 'comma-separated global tool names to keep; other tools become invisible')
    .option('--output-schema <path>', 'JSON Schema file (object-rooted) the run\'s final answer must satisfy')
    .argument('[task...]', 'the task text; multiple words are joined by spaces, and `-` reads stdin')
    .addHelpText('after', `
Examples:
  dsh --profile headless "run the tests"          answer one task and exit
  echo "run the tests" | dsh --profile headless   read the task from stdin
  dsh --profile headless --json "run the tests"   emit machine-readable run events
  dsh --profile headless --session-id session-… "continue"   resume an existing Session
  dsh --profile headless --continue "carry on"    resume the newest Session in this directory
  dsh --profile headless --output-schema out.json "summarize the diff"   require a structured answer
`)
}

/**
 * Whether the raw invocation asks for the machine-readable stream. The scan
 * stops at `--` and skips the value of every option that takes one, so a
 * literal `--json` used as an option value or a positional never installs the
 * JSON error override.
 * @param argv - the invocation's raw arguments.
 * @returns whether `--json` is a real flag of this invocation.
 */
function jsonRequested(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) break
    if (argument === '--') return false
    if (argument === '--json') return true
    if (VALUE_OPTIONS[argument] === true) index += 1
  }
  return false
}

/** Reject a blank option value before it can pass as an identity or a prompt. */
function requireNonBlank(program: Command, flag: string, value: string): string {
  if (value.trim() === '') program.error(`error: ${flag} requires a non-empty value`)
  return value
}

/**
 * Read and validate the object-rooted JSON Schema one run must satisfy. The
 * schema is self-contained, so a bad path, malformed JSON, or an unsupported
 * schema node fails here, before the runner mounts.
 * @param program - the command whose error path reports the failure.
 * @param path - the schema file path, resolved against the process directory.
 * @returns the validated schema.
 */
function loadOutputSchema(program: Command, path: string): ObjectJsonSchema {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    program.error(`error: cannot read --output-schema file "${path}": ${detail}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    program.error(`error: --output-schema file "${path}" is not valid JSON: ${detail}`)
  }
  try {
    assertObjectJsonSchema(parsed)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    program.error(`error: --output-schema file "${path}": ${detail}`)
  }
  return parsed
}

/**
 * Parse and provide the one-shot task as an ordinary Cordis service. The
 * command's action publishes the task and run flags; a missing task on an
 * interactive stdin is a usage error, so on rejection (and on `--help`)
 * nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = headlessCommand()
  // The raw snapshot decides the JSON contract: Commander rejects a grammar
  // error (an unknown option, a missing option value) before the action runs,
  // and such a rejection still owes a --json caller the error event.
  if (jsonRequested(ctx.get('cmdlineArgs')?.get() ?? [])) {
    program.error = (message: string, errorOptions?: Parameters<Command['error']>[1]): never => {
      // The event message matches the runner's runtime errors, which carry no
      // commander `error: ` prefix.
      const payload = boundJsonLine({ type: 'error', message: message.replace(/^error: /, '') })
      internals.stdout.write(`${payload}\n`)
      // The JSON contract keeps stderr to `dsh:` diagnostics, so commander's
      // own print of this message must not run; throwing the same control-flow
      // error still leaves through the launcher's exit path.
      throw new CommanderError(1, errorOptions?.code ?? 'commander.error', message)
    }
  }
  program.action(() => {
    if (program.args.length > 1 && program.args.includes('-')) {
      program.error('error: `-` must be the only task argument')
    }
    const joined = program.args.join(' ')
    if (program.args.length > 0 && joined.trim() === '') {
      program.error('error: a task is required, for example: dsh --profile headless "run the tests"')
    }
    const task = program.args.length === 0 ? undefined : joined
    if (task === undefined && internals.stdinIsTty()) {
      program.error('error: a task is required, for example: dsh --profile headless "run the tests"')
    }
    const options = program.opts<{
      json?: boolean
      sessionId?: string
      resume?: string
      continue?: boolean
      model?: string
      permissionMode?: string
      maxTurns?: string
      systemPrompt?: string
      allowedTools?: string
      outputSchema?: string
    }>()
    // A SessionId is opaque, so whitespace is part of the identity: validate
    // emptiness on the trimmed value but hand the runner the exact string.
    const sessionId = options.sessionId
    if (sessionId !== undefined && sessionId.trim() === '') {
      program.error('error: --session-id requires a non-empty session id')
    }
    const resumed = options.resume === undefined ? undefined : requireNonBlank(program, '--resume', options.resume)
    const continueLatest = options.continue === true
    // Three ways to name the Session this run adopts: exactly one may be given,
    // so a supervisor never has to reason about which of two ids won.
    const selectors = [sessionId !== undefined, resumed !== undefined, continueLatest].filter(Boolean).length
    if (selectors > 1) {
      program.error('error: --session-id, --resume, and --continue are mutually exclusive; give one')
    }
    const model = options.model === undefined ? undefined : requireNonBlank(program, '--model', options.model)
    if (model !== undefined && /\s/u.test(model)) {
      // A model id is a protocol identifier; whitespace means a shell quoting
      // mistake that would otherwise reach the provider as an unknown model.
      program.error(`error: --model takes a model id without whitespace, got "${model}"`)
    }
    const permissionMode = options.permissionMode === undefined
      ? undefined
      : requireNonBlank(program, '--permission-mode', options.permissionMode)
    if (permissionMode !== undefined && /[\s,]/u.test(permissionMode)) {
      program.error(`error: --permission-mode takes one preset name, got "${permissionMode}"`)
    }
    let maxTurns: number | undefined
    if (options.maxTurns !== undefined) {
      const raw = requireNonBlank(program, '--max-turns', options.maxTurns)
      if (!/^\d+$/u.test(raw) || Number(raw) < 1) {
        program.error(`error: --max-turns requires a whole number of at least 1, got "${raw}"`)
      }
      maxTurns = Number(raw)
    }
    const systemPrompt = options.systemPrompt === undefined
      ? undefined
      : requireNonBlank(program, '--system-prompt', options.systemPrompt)
    let allowedTools: string[] | undefined
    if (options.allowedTools !== undefined) {
      const names = requireNonBlank(program, '--allowed-tools', options.allowedTools).split(',').map(name => name.trim())
      if (names.some(name => name === '')) {
        program.error(`error: --allowed-tools takes a comma-separated list of tool names, got "${options.allowedTools}"`)
      }
      allowedTools = [...new Set(names)]
    }
    const outputSchema = options.outputSchema === undefined
      ? undefined
      : loadOutputSchema(program, requireNonBlank(program, '--output-schema', options.outputSchema))
    ctx.provide(HEADLESS_STARTUP_SERVICE, {
      task,
      sessionId: sessionId ?? resumed,
      json: options.json === true,
      ...continueLatest ? { continueLatest: true } : {},
      ...model === undefined ? {} : { model },
      ...permissionMode === undefined ? {} : { permissionMode },
      ...maxTurns === undefined ? {} : { maxTurns },
      ...systemPrompt === undefined ? {} : { systemPrompt },
      ...allowedTools === undefined ? {} : { allowedTools },
      ...outputSchema === undefined ? {} : { outputSchema },
    } satisfies HeadlessStartupValues)
  })
  parseCmdline(ctx, program)
}
