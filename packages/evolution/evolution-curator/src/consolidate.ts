/**
 * Opt-in LLM consolidation for the evolution curator. The curator surveys the
 * agent-created skills it tracks, frames that survey as one request, and runs a
 * bounded in-package tool loop: the fork may inspect one skill package and
 * apply a verdict per skill, and nothing else. The curator performs every
 * write itself, so the full-package rule holds regardless of what the model
 * asks for — a skill shipping `references/`, `templates/`, `scripts/`, or
 * `assets/` is kept standalone, re-homed whole with its
 * `${DSH_SKILL_DIR}` references rewritten, or archived whole; its `SKILL.md`
 * is never flattened on its own.
 *
 * A host plugin cannot fork the subagent seam headlessly (in-process
 * providers inherit their route from a live parent session, which a curator
 * has none of), so the loop runs in-process over `ctx.llm`.
 *
 * @module @deepseek-ai/dsh-evolution-curator/src/consolidate
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BlockAssembler, createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { EvolutionSkillTelemetry } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import { appendLedger, moveTree, pathExists } from './safety.ts'
import type { ConsolidationVerdict, SurveyCandidate } from './types.ts'

/** File extensions whose `${DSH_SKILL_DIR}` references are rewritten on re-home. */
const TEXT_FILE = /\.(?:md|markdown|txt|ya?ml|json|sh|ps1|ts|js|mjs|cjs|py)$/i

/** Template variable naming a skill's own directory. */
const SKILL_DIR_VAR = '${DSH_SKILL_DIR}'

/** Directory name archived packages move into, beside the skill's own parent. */
export const ARCHIVE_DIR = '.archive'

/** Cap on one `skill_view` result, so one package cannot flood the loop. */
const VIEW_BYTES = 8192

/**
 * The survey framing: what the fork may decide, and the machine-readable
 * candidate list it decides over.
 * @returns the fixed instruction text.
 */
export function consolidationInstructions(): string {
  return [
    'You consolidate agent-created skills in one maintenance pass.',
    'For each candidate, call skill_view to inspect its package, then call skill_apply exactly once with one of:',
    '- keep: leave it alone.',
    '- patch: rewrite its SKILL.md body (send the complete replacement body).',
    '- consolidate: merge it into an umbrella skill named by `into`; its whole package is re-homed under the umbrella.',
    '- archive: retire it; its whole package moves to .archive/.',
    'Apply consolidate only when the umbrella already exists and clearly owns the topic.',
    'Never rewrite a package that ships references/, templates/, scripts/, or assets/ down to SKILL.md alone.',
  ].join('\n')
}

/**
 * Frame the candidate survey for one request, dropping candidates from the
 * end until the frame fits the byte budget.
 * @param candidates - surveyed skills, name-sorted.
 * @param maxBytes - byte budget for the framed text.
 * @returns the framed text, its byte size, and whether candidates were dropped.
 */
export function frameConsolidationInput(
  candidates: readonly SurveyCandidate[],
  maxBytes: number,
): { text: string; inputBytes: number; truncated: boolean } {
  const header = consolidationInstructions()
  let kept = candidates.length
  let text = ''
  for (;;) {
    text = `${header}\n\nCandidates:\n${JSON.stringify(candidates.slice(0, kept))}`
    if (Buffer.byteLength(text) <= maxBytes || kept === 0) break
    kept -= 1
  }
  return { text, inputBytes: Buffer.byteLength(text), truncated: kept < candidates.length }
}

/** The two tools the fork may call. Everything else it asks for is refused. */
export function consolidationTools(): ToolSchema[] {
  return [
    {
      name: 'skill_view',
      description: 'Read one candidate skill package: its file list and SKILL.md body.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name from the candidate list.' },
          file: { type: 'string', description: 'Optional package-relative file to read.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'skill_apply',
      description: 'Apply one verdict for a candidate skill.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name from the candidate list.' },
          action: { type: 'string', enum: ['keep', 'patch', 'consolidate', 'archive'] },
          into: { type: 'string', description: 'Umbrella skill for a consolidate verdict.' },
          body: { type: 'string', description: 'Complete replacement SKILL.md body for a patch verdict.' },
        },
        required: ['name', 'action'],
      },
    },
  ]
}

/** Stream plus tool execution the curator supplies to the fork loop. */
export interface ConsolidationFork {
  /**
   * Stream one model request.
   * @param options - the fully assembled request.
   * @returns the chunk stream.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  /**
   * Execute one whitelisted tool call.
   * @param name - tool name the model asked for.
   * @param args - decoded arguments.
   * @returns the tool result text the model reads.
   */
  execute(name: string, args: Record<string, unknown>): Promise<string>
}

/** Fixed request fields for the bounded fork loop. */
export interface ConsolidationRunOptions {
  /** Provider route for every request. */
  provider: string
  /** Model id for every request. */
  model: string
  /** Output-token cap for every request. */
  maxOutputTokens: number
  /** Requests the loop may spend. */
  maxSteps: number
  /** Framed survey opening the conversation. */
  input: string
  /** Upstream cancellation forwarded to every request. */
  signal: AbortSignal
}

/**
 * Run the bounded tool loop: ask the fork, execute what it requested, feed the
 * results back, and stop at the first text-only answer or at `maxSteps`.
 * @param fork - model stream plus tool executor.
 * @param options - route, budget, framing, and cancellation.
 * @returns the requests spent.
 */
export async function runConsolidationFork(fork: ConsolidationFork, options: ConsolidationRunOptions): Promise<number> {
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: options.input }],
    source: { kind: 'plugin', plugin: 'dsh-evolution-curator' },
  })]
  for (let step = 1; step <= options.maxSteps; step += 1) {
    const assembler = new BlockAssembler()
    for await (const chunk of fork.stream({
      provider: options.provider,
      model: options.model,
      messages,
      tools: consolidationTools(),
      maxTokens: options.maxOutputTokens,
      temperature: 0,
      purpose: 'evolution-review',
      signal: options.signal,
    })) {
      assembler.push(chunk)
    }
    assertFinish(assembler)
    const blocks = assembler.blocks()
    const calls = blocks.filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
    if (calls.length === 0) return step
    messages.push(createAssistantMessage({
      content: blocks,
      source: { provider: options.provider, model: options.model },
    }))
    for (const call of calls) {
      const result = await fork.execute(call.name, decodeArgs(call.arguments))
      messages.push(createToolResultMessage({
        callId: ToolCallId(call.id),
        content: [{ type: 'text', text: result }],
        isError: result.startsWith('error:'),
      }))
    }
  }
  return options.maxSteps
}

/** Decode one tool call's arguments; malformed JSON becomes an empty request. */
function decodeArgs(argumentsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argumentsJson) as Record<string, unknown>
  } catch {
    // A malformed tool call is the model's error to recover from, not a crash.
    return {}
  }
}

/** Turn a failed or aborted fork request into a thrown error. */
function assertFinish(assembler: BlockAssembler): void {
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const error = new Error(finish.failure.message) as Error & { code?: string }
    error.code = finish.failure.code
    throw error
  }
}

/** Host seams the consolidation applier needs. */
export interface ConsolidationApplyDeps {
  /** ISO-8601 instant the run started. */
  at: string
  /** Pass identity shared by every ledger row of this run. */
  passId: string
  /** Curator home holding the ledger. */
  home: string
  /** Telemetry store receiving lifecycle movements. */
  telemetry: EvolutionSkillTelemetry
  /** Surveyed candidates; the only skills the fork may touch. */
  candidates: ReadonlyMap<string, SurveyCandidate>
  /** Resolvable, writable skill directories by name. */
  dirs: ReadonlyMap<string, string>
}

/** One applied consolidation movement. */
export interface ConsolidationApplied {
  /** Lifecycle movements with the package's directory after the run. */
  transitions: { name: string; before: SkillUsageRecord; after: SkillUsageRecord; dir: string }[]
  /** Verdicts skipped as ineligible or unsafe. */
  skipped: number
}

/**
 * Apply the fork's verdicts under the full-package rule. A package is moved
 * whole or not at all: merges re-home the entire directory and rewrite its
 * `${DSH_SKILL_DIR}` references for the new relative root, archives move the
 * entire directory into `.archive/`, and a merge whose umbrella is missing or
 * unwritable leaves the package exactly where it is.
 * @param deps - host seams and the surveyed candidate set.
 * @param verdicts - the fork's verdicts, in tool-call order.
 * @returns the lifecycle movements and the skipped-verdict count.
 */
export async function applyConsolidation(
  deps: ConsolidationApplyDeps,
  verdicts: readonly ConsolidationVerdict[],
): Promise<ConsolidationApplied> {
  const applied: ConsolidationApplied = { transitions: [], skipped: 0 }
  for (const verdict of verdicts) {
    if (verdict.action === 'keep') continue
    if (!deps.candidates.has(verdict.name)) {
      applied.skipped += 1
      continue
    }
    const before = deps.telemetry.read(verdict.name)
    const dir = deps.dirs.get(verdict.name)
    if (before === undefined || dir === undefined) {
      applied.skipped += 1
      continue
    }
    if (verdict.action === 'patch') {
      if (verdict.body === undefined) {
        applied.skipped += 1
        continue
      }
      await writeFile(join(dir, 'SKILL.md'), verdict.body)
      await appendLedger(deps.home, {
        id: randomUUID(),
        at: deps.at,
        actor: 'curator',
        action: 'patch',
        evidence: { passId: deps.passId, name: verdict.name, dir },
        before: null,
        after: null,
      })
      continue
    }
    if (before.pinned) {
      applied.skipped += 1
      continue
    }
    const destination = verdict.action === 'archive'
      ? join(dirname(dir), ARCHIVE_DIR, verdict.name)
      : await mergeTarget(deps, verdict)
    if (destination === undefined || await pathExists(destination)) {
      applied.skipped += 1
      continue
    }
    await moveTree(dir, destination)
    if (verdict.action === 'consolidate' && verdict.into !== undefined) {
      await rewriteSkillDirRefs(destination, verdict.name)
      await appendUmbrellaReference(join(dirname(destination)), verdict.name)
    }
    const after = await deps.telemetry.setState(verdict.name, 'archived', verdict.into ?? null)
    await appendLedger(deps.home, {
      id: randomUUID(),
      at: deps.at,
      actor: 'curator',
      action: 'move',
      evidence: { passId: deps.passId, name: verdict.name, from: dir, to: destination },
      before: null,
      after: null,
    })
    applied.transitions.push({ name: verdict.name, before, after, dir: destination })
  }
  return applied
}

/**
 * Resolve the directory one merge re-homes the package into, or undefined when
 * no writable umbrella can receive it — which keeps the package standalone.
 */
async function mergeTarget(deps: ConsolidationApplyDeps, verdict: ConsolidationVerdict): Promise<string | undefined> {
  const umbrella = verdict.into === undefined ? undefined : deps.dirs.get(verdict.into)
  if (umbrella === undefined || !(await pathExists(join(umbrella, 'SKILL.md')))) return undefined
  return join(umbrella, verdict.name)
}

/**
 * Rewrite every `${DSH_SKILL_DIR}` reference inside one re-homed package so it
 * still resolves from the umbrella's directory.
 * @param dir - the re-homed package directory.
 * @param name - package directory name under the umbrella.
 */
async function rewriteSkillDirRefs(dir: string, name: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !TEXT_FILE.test(entry.name)) continue
    const file = join(entry.parentPath, entry.name)
    const text = await readFile(file, 'utf8')
    if (!text.includes(SKILL_DIR_VAR)) continue
    await writeFile(file, text.replaceAll(SKILL_DIR_VAR, `${SKILL_DIR_VAR}/${name}`))
  }
}

/** Append the umbrella's reference to a re-homed package. */
async function appendUmbrellaReference(umbrellaDir: string, name: string): Promise<void> {
  const file = join(umbrellaDir, 'SKILL.md')
  const body = await readFile(file, 'utf8')
  await writeFile(file, `${body.trimEnd()}\n\n## Merged: ${name}\n\nSee [${name}/SKILL.md](${name}/SKILL.md).\n`)
}

/** Host seams the in-package tools read from. */
export interface ConsolidationToolDeps {
  /** Surveyed candidates; the tool whitelist. */
  candidates: ReadonlyMap<string, SurveyCandidate>
  /** Resolvable, writable skill directories by name. */
  dirs: ReadonlyMap<string, string>
  /** Verdicts recorded so far, appended in tool-call order. */
  verdicts: ConsolidationVerdict[]
}

/**
 * Execute one whitelisted fork tool call. Unknown tools and unreadable paths
 * return an error text the model can recover from instead of throwing.
 * @param deps - candidate set, directories, and the verdict sink.
 * @param name - tool name the model asked for.
 * @param args - decoded arguments.
 * @returns the result text.
 */
export async function executeConsolidationTool(
  deps: ConsolidationToolDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const skill = typeof args['name'] === 'string' ? args['name'] : ''
  if (!deps.candidates.has(skill)) return `error: '${skill}' is not a candidate`
  const dir = deps.dirs.get(skill)
  if (dir === undefined) return `error: '${skill}' has no writable directory`
  if (name === 'skill_view') return viewPackage(dir, args)
  if (name !== 'skill_apply') return `error: unknown tool '${name}'`
  const action = args['action']
  if (action !== 'keep' && action !== 'patch' && action !== 'consolidate' && action !== 'archive') {
    return `error: unknown action '${String(action)}'`
  }
  const verdict: ConsolidationVerdict = { name: skill, action }
  if (typeof args['into'] === 'string') verdict.into = args['into']
  if (typeof args['body'] === 'string') verdict.body = args['body']
  deps.verdicts.push(verdict)
  return `ok: recorded ${action} for '${skill}'`
}

/** Read one candidate package's file list and a file body. */
async function viewPackage(dir: string, args: Record<string, unknown>): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  const listing = entries.map(entry => `${entry.isDirectory() ? 'dir ' : 'file'} ${join(entry.parentPath, entry.name).slice(dir.length + 1)}`).sort()
  const requested = typeof args['file'] === 'string' ? args['file'] : 'SKILL.md'
  return `package:\n${listing.join('\n')}\n\n${requested}:\n${await readFile(join(dir, requested), 'utf8').then(text => text.slice(0, VIEW_BYTES), (error: unknown) => `error: ${String(error)}`)}`
}
