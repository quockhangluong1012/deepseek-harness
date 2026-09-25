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
import type { ContentBlock, ContextFormed, GenerateOptions, Message, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { EvolutionSkillTelemetry } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import { SKILL_FILE } from '@deepseek-ai/dsh-evolution-skill-manage'
import { runVerifierLadder } from '@deepseek-ai/dsh-evolution-verifiers'
import type { VerifierSeam } from '@deepseek-ai/dsh-evolution-verifiers'
import { appendLedger, moveTree, pathExists, textSha, writeTextBlob } from './safety.ts'
import type { ConsolidationRefusal, ConsolidationVerdict, SurveyCandidate } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** @persistenceAttribution */
    'evolution-curator': { kind: 'evolution-curator' } & ContextFormed
  }
}

/**
 * Count the lines one patch would add and remove: both bodies minus their
 * longest common subsequence, so unchanged lines in place cost nothing and
 * every other line counts once on its own side. Order-sensitive, matching
 * `@deepseek-ai/dsh-evolution-optimizer`'s `diffLineCounts` — duplicated here
 * rather than imported so this package does not depend on the optimizer for
 * one pure line-diff function.
 * @param before - the body on disk.
 * @param after - the candidate patch body.
 * @returns added and removed line counts.
 */
function diffLineCounts(before: string, after: string): { addedLines: number; removedLines: number } {
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  const memo = new Map<string, number>()
  const shared = (i: number, j: number): number => {
    if (i >= oldLines.length || j >= newLines.length) return 0
    const key = `${i},${j}`
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    const value = oldLines[i] === newLines[j]
      ? shared(i + 1, j + 1) + 1
      : Math.max(shared(i + 1, j), shared(i, j + 1))
    memo.set(key, value)
    return value
  }
  const common = shared(0, 0)
  return { addedLines: newLines.length - common, removedLines: oldLines.length - common }
}

/** Sentinel opening a protected span; content between it and {@link PROTECTED_TEXT_CLOSE} must survive every patch verbatim. */
export const PROTECTED_TEXT_OPEN = '<!-- dsh:protected -->'

/** Sentinel closing a protected span opened by {@link PROTECTED_TEXT_OPEN}. */
export const PROTECTED_TEXT_CLOSE = '<!-- /dsh:protected -->'

/**
 * Find every protected span in a SKILL.md body: paired, non-nesting runs of
 * {@link PROTECTED_TEXT_OPEN} through {@link PROTECTED_TEXT_CLOSE}, sentinels
 * included. An unpaired open past the last close is ignored — the body that
 * wrote it is already malformed, and this package refuses only a patch that
 * drops or alters a span the previous body actually closed.
 * @param body - the SKILL.md text to scan.
 * @returns each protected span's exact text, in document order.
 */
function protectedSpans(body: string): string[] {
  const spans: string[] = []
  let from = 0
  for (;;) {
    const open = body.indexOf(PROTECTED_TEXT_OPEN, from)
    if (open === -1) return spans
    const close = body.indexOf(PROTECTED_TEXT_CLOSE, open + PROTECTED_TEXT_OPEN.length)
    if (close === -1) return spans
    spans.push(body.slice(open, close + PROTECTED_TEXT_CLOSE.length))
    from = close + PROTECTED_TEXT_CLOSE.length
  }
}

/**
 * Refuse a patch that drops or alters a protected span: every
 * `<!-- dsh:protected -->` block the previous body closed must appear
 * byte-identical somewhere in the candidate body. A previous body with no
 * protected span never refuses on this rung.
 * @param before - the body on disk.
 * @param after - the candidate patch body.
 * @returns the reason naming the first missing span, or null when every span survives.
 */
export function protectedTextViolation(before: string, after: string): string | null {
  for (const span of protectedSpans(before)) {
    if (!after.includes(span)) {
      return 'the patch drops or alters a protected span the previous body carried'
    }
  }
  return null
}

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
    '- patch: rewrite SKILL.md (send the complete file, frontmatter included); a body that would break the frontmatter is refused.',
    '- consolidate: merge it into an umbrella skill named by `into`; its whole package is re-homed under the umbrella.',
    '- archive: retire it; its whole package moves to .archive/.',
    'Apply consolidate only when the umbrella already exists and clearly owns the topic.',
    'Never rewrite a package that ships references/, templates/, scripts/, or assets/ down to SKILL.md alone.',
    'Only patch or archive a skill that is provisional or carries a trigger_review signal; a trusted skill with no such signal is keep.',
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

/**
 * The two tools the fork may call. Everything else it asks for is refused.
 * @returns the tool schemas offered to the consolidation fork, in prompt order.
 */
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
          body: { type: 'string', description: 'Complete replacement SKILL.md file for a patch verdict, frontmatter included.' },
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
    source: { kind: 'evolution-curator' },
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
  /** Total changed-line ceiling (added plus removed) a `patch` body may not exceed; `0` leaves it unbounded. */
  maxDiffLines: number
  /** Level 2: a host-mounted domain simulator, absent unless the host mounts one. */
  simulation?: VerifierSeam
  /** Level 3: a host-mounted evaluator model, absent unless the host mounts one. */
  evaluator?: VerifierSeam
  /** Level 4: a host-mounted human-review seam, absent unless the host mounts one. */
  review?: VerifierSeam
  /**
   * Refuse a patch the ladder did not fully pass — an abstention as well as a
   * failure — instead of committing on deterministic evidence alone. Default
   * `false` keeps today's behavior: a body that passes levels 0 and 1 commits
   * even when the higher rungs abstain for want of a mounted seam.
   */
  requireVerifierPass: boolean
}

/** One applied consolidation movement. */
export interface ConsolidationApplied {
  /** Lifecycle movements with the package's directory after the run. */
  transitions: { name: string; before: SkillUsageRecord; after: SkillUsageRecord; dir: string }[]
  /** Verdicts skipped as ineligible or unsafe. */
  skipped: number
  /** Bodies the verifier ladder refused, each naming the level that decided. */
  refusals: ConsolidationRefusal[]
  /** Bodies committed in place, each with a stored preimage. */
  patched: number
}

/**
 * Apply the fork's verdicts under the full-package rule. A package is moved
 * whole or not at all: merges re-home the entire directory and rewrite its
 * `${DSH_SKILL_DIR}` references for the new relative root, archives move the
 * entire directory into `.archive/`, and a merge whose umbrella is missing or
 * unwritable leaves the package exactly where it is.
 *
 * A `patch` body is admitted through the verifier ladder first: the schema and
 * invariant rungs decide it deterministically, a failing rung refuses the body
 * with the level that decided, and the higher rungs run behind whatever
 * `simulation`/`evaluator`/`review` seams the deps carry — an unset seam
 * abstains. By default an abstained-but-not-failed ladder still commits on
 * the deterministic evidence alone, the same as an unmounted ladder;
 * `requireVerifierPass` refuses instead, with `level: 'ladder-incomplete'`,
 * so a host that mounted higher rungs can demand every one of them actually
 * decide before a write lands. A ladder pass then meets the protected-text
 * check: a patch that drops or alters a `<!-- dsh:protected -->` span the
 * previous body carried is refused with `level: 'protected-text'` regardless
 * of what the ladder decided. A body that keeps every protected span then
 * meets `maxDiffLines`: a patch that changes more lines than the configured
 * ceiling is refused with `level: 'diff-cap'` before anything is written,
 * bounding how much of a skill one automatic pass may rewrite.
 * @param deps - host seams, the surveyed candidate set, the diff-size ceiling, and the optional ladder seams and pass requirement.
 * @param verdicts - the fork's verdicts, in tool-call order.
 * @returns the lifecycle movements, the skipped-verdict count, and the refused bodies.
 */
export async function applyConsolidation(
  deps: ConsolidationApplyDeps,
  verdicts: readonly ConsolidationVerdict[],
): Promise<ConsolidationApplied> {
  const applied: ConsolidationApplied = { transitions: [], skipped: 0, refusals: [], patched: 0 }
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
      const admission = await runVerifierLadder({
        name: verdict.name,
        body: verdict.body,
        ...deps.simulation === undefined ? {} : { simulation: deps.simulation },
        ...deps.evaluator === undefined ? {} : { evaluator: deps.evaluator },
        ...deps.review === undefined ? {} : { review: deps.review },
      })
      if (admission.status === 'failed') {
        applied.skipped += 1
        applied.refusals.push({ name: verdict.name, level: admission.decidedBy, reason: admission.reason })
        continue
      }
      if (deps.requireVerifierPass && admission.status !== 'passed') {
        applied.skipped += 1
        applied.refusals.push({ name: verdict.name, level: 'ladder-incomplete', reason: admission.reason })
        continue
      }
      const file = join(dir, SKILL_FILE)
      const previous = await readFile(file, 'utf8')
      const protectedViolation = protectedTextViolation(previous, verdict.body)
      if (protectedViolation !== null) {
        applied.skipped += 1
        applied.refusals.push({ name: verdict.name, level: 'protected-text', reason: protectedViolation })
        continue
      }
      if (deps.maxDiffLines > 0) {
        const { addedLines, removedLines } = diffLineCounts(previous, verdict.body)
        const changed = addedLines + removedLines
        if (changed > deps.maxDiffLines) {
          applied.skipped += 1
          applied.refusals.push({
            name: verdict.name,
            level: 'diff-cap',
            reason: `the patch changes ${changed} line(s) (+${addedLines}/-${removedLines}), over the ${deps.maxDiffLines}-line cap`,
          })
          continue
        }
      }
      const beforeSha = textSha(previous)
      await writeTextBlob(deps.home, beforeSha, previous)
      await writeFile(file, verdict.body)
      await deps.telemetry.markRevised(verdict.name, verdict.body)
      applied.patched += 1
      await appendLedger(deps.home, {
        id: randomUUID(),
        at: deps.at,
        actor: 'curator',
        action: 'patch',
        evidence: { passId: deps.passId, name: verdict.name, dir, file },
        before: beforeSha,
        after: textSha(verdict.body),
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
