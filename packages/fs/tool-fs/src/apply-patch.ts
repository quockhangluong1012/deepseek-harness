/**
 * Model-facing V4A patch application.
 *
 * The grammar is the three-section V4A form: a `*** Begin Patch` opening, one
 * or more `*** Add File:`, `*** Update File:`, or `*** Delete File:` sections,
 * and a `*** End Patch` closing. Add File content lines start with `+`; Update
 * File hunks start with `@@`, carry an optional locator after it, and hold
 * ` ` context, `-` removed, and `+` added lines. Directive lines are trimmed,
 * content lines are matched from column 0, and blank lines separate everywhere.
 * The parser rejects anything else with the offending line, so a malformed
 * patch changes nothing.
 *
 * @module @deepseek-ai/dsh-tool-fs/src/apply-patch
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffResultView, FileDiff, ToolCallView, ToolResult } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import { computeHunkDiffs, diffsFromMeta } from './diff.ts'
import { remediateFsError } from './error.ts'
import { detectLineEndings, matchLiteralEdit, normalizeLineEndings, restoreLineEndings } from './literal-edit.ts'
import type { LiteralEditMatch } from './literal-edit.ts'
import { fileScopeKey } from './scope-key.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { FsSandboxController } from './sandbox.ts'

const BEGIN_PATCH = '*** Begin Patch'
const END_PATCH = '*** End Patch'
const ADD_PREFIX = '*** Add File:'
const UPDATE_PREFIX = '*** Update File:'
const DELETE_PREFIX = '*** Delete File:'

/** A V4A section kind. */
type PatchSectionKind = 'add' | 'update' | 'delete'

/** Default largest patch argument accepted, in UTF-8 bytes (the `applyPatchMaxBytes` config). */
export const APPLY_PATCH_MAX_BYTES = 1_048_576

/**
 * One context-anchored replacement inside an Update File section. `oldText` and
 * `newText` are the section's context and removed/added lines without their
 * leading marker, joined by LF: the block `oldText` resolves against the file.
 */
export interface PatchHunk {
  /** 1-based patch line the hunk starts on, for diagnostics. */
  readonly line: number
  /** The `@@` locator text, when the hunk carries one after its `@@`. */
  readonly anchor?: string
  /** Context and removed lines, marker stripped. */
  readonly oldText: string
  /** Context and added lines, marker stripped. */
  readonly newText: string
}

/** One parsed V4A section. */
export type PatchSection =
  | { readonly kind: 'add'; readonly line: number; readonly path: string; readonly content: string }
  | { readonly kind: 'update'; readonly line: number; readonly path: string; readonly hunks: readonly PatchHunk[] }
  | { readonly kind: 'delete'; readonly line: number; readonly path: string }

/** The `apply_patch` tool's validated arguments. */
interface ApplyPatchToolArgs {
  patch: string
  sandbox_permissions?: string
  justification?: string
}

/** Caps the tool needs, resolved from plugin config. */
export interface ApplyPatchCaps {
  /** Largest accepted patch argument, in UTF-8 bytes. */
  readonly maxBytes: number
}

/** One file's applied change, as the tool's canonical value carries it. */
interface PatchFileOutcome {
  path: string
  operation: 'create' | 'update'
  /** Content before the write, or `null` for a file this patch created. */
  before: string | null
  /** LF-normalized content after the write. */
  after: string
}

/** One validated section, ready to write. */
interface StagedWrite {
  readonly target: FsTarget
  readonly before: string | null
  readonly content: string
  readonly intent: FsWriteIntent | undefined
  /** LF-normalized content the write publishes (the diff basis). */
  readonly after: string
}

/** A hunk under construction: its source line and its marker-stripped lines. */
interface HunkDraft {
  line: number
  anchor?: string
  old: string[]
  new: string[]
}

/** A section under construction. */
interface OpenSection {
  kind: PatchSectionKind
  line: number
  path: string
  content: string[]
  hunks: PatchHunk[]
}

/** Read one section header, or undefined for any other line. */
function headerOf(line: string): { kind: PatchSectionKind; path: string } | undefined {
  if (line.startsWith(ADD_PREFIX)) return { kind: 'add', path: line.slice(ADD_PREFIX.length).trim() }
  if (line.startsWith(UPDATE_PREFIX)) return { kind: 'update', path: line.slice(UPDATE_PREFIX.length).trim() }
  if (line.startsWith(DELETE_PREFIX)) return { kind: 'delete', path: line.slice(DELETE_PREFIX.length).trim() }
  return undefined
}

/** Read one hunk marker's locator text, or undefined for a bare `@@`. */
function anchorOf(marker: string): string | undefined {
  const text = marker.slice(2).trim()
  return text.length === 0 ? undefined : text
}

/**
 * Parse a V4A patch. The whole patch is checked before a caller resolves any
 * path, so a malformed patch never reaches the filesystem.
 * @param patch - the raw patch text, in either line-ending style.
 * @returns every section in patch order, with a repeated path rejected.
 * @throws Error naming the 1-based patch line of the first malformed line.
 */
export function parseApplyPatch(patch: string): PatchSection[] {
  const sections: PatchSection[] = []
  const paths = new Set<string>()
  let open: OpenSection | undefined
  let draft: HunkDraft | undefined
  let begun = false
  let ended = false

  const takeHunk = (sectionPath: string): PatchHunk | undefined => {
    if (draft === undefined) return undefined
    if (draft.old.length === 0) {
      throw new Error(`line ${draft.line}: the hunk in "${sectionPath}" has no context or removed line to locate it`)
    }
    const complete: PatchHunk = {
      line: draft.line,
      ...(draft.anchor === undefined ? {} : { anchor: draft.anchor }),
      oldText: draft.old.join('\n'),
      newText: draft.new.join('\n'),
    }
    draft = undefined
    return complete
  }

  const closeSection = (): void => {
    if (open === undefined) return
    const hunk = takeHunk(open.path)
    if (hunk !== undefined) open.hunks.push(hunk)
    if (open.kind === 'add' && open.content.length === 0) {
      throw new Error(`line ${open.line}: "${ADD_PREFIX} ${open.path}" has no "+" content lines`)
    }
    if (open.kind === 'update' && open.hunks.length === 0) {
      throw new Error(`line ${open.line}: "${UPDATE_PREFIX} ${open.path}" has no hunks`)
    }
    sections.push(open.kind === 'add'
      ? { kind: 'add', line: open.line, path: open.path, content: `${open.content.join('\n')}\n` }
      : open.kind === 'update'
        ? { kind: 'update', line: open.line, path: open.path, hunks: open.hunks }
        : { kind: 'delete', line: open.line, path: open.path })
    open = undefined
  }

  for (const [index, line] of normalizeLineEndings(patch).split('\n').entries()) {
    const lineNumber = index + 1
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (ended) throw new Error(`line ${lineNumber}: content after "${END_PATCH}"`)
    if (!begun) {
      if (trimmed !== BEGIN_PATCH) throw new Error(`line ${lineNumber}: a patch must start with "${BEGIN_PATCH}"`)
      begun = true
      continue
    }
    if (trimmed === END_PATCH) {
      closeSection()
      ended = true
      continue
    }
    const header = headerOf(trimmed)
    if (header !== undefined) {
      closeSection()
      if (header.path.length === 0) throw new Error(`line ${lineNumber}: "${trimmed}" needs a path`)
      if (paths.has(header.path)) throw new Error(`line ${lineNumber}: "${header.path}" appears in more than one section`)
      paths.add(header.path)
      open = { kind: header.kind, line: lineNumber, path: header.path, content: [], hunks: [] }
      continue
    }
    if (trimmed.startsWith('***')) throw new Error(`line ${lineNumber}: unknown patch directive "${trimmed}"`)
    if (open === undefined) throw new Error(`line ${lineNumber}: "${trimmed}" appears outside a file section`)
    switch (open.kind) {
      case 'add': {
        if (!line.startsWith('+')) throw new Error(`line ${lineNumber}: an Add File content line must start with "+"`)
        open.content.push(line.slice(1))
        break
      }
      case 'update': {
        if (line.startsWith('@@')) {
          const previous = takeHunk(open.path)
          if (previous !== undefined) open.hunks.push(previous)
          const anchor = anchorOf(line)
          draft = { line: lineNumber, ...(anchor === undefined ? {} : { anchor }), old: [], new: [] }
          break
        }
        if (!line.startsWith(' ') && !line.startsWith('-') && !line.startsWith('+')) {
          throw new Error(`line ${lineNumber}: an Update File line must start with " ", "+", "-", or "@@"`)
        }
        draft ??= { line: lineNumber, old: [], new: [] }
        if (line.startsWith('+')) {
          draft.new.push(line.slice(1))
        } else if (line.startsWith('-')) {
          draft.old.push(line.slice(1))
        } else {
          const context = line.slice(1)
          draft.old.push(context)
          draft.new.push(context)
        }
        break
      }
      case 'delete':
        throw new Error(`line ${lineNumber}: "${DELETE_PREFIX} ${open.path}" takes no content lines`)
    }
  }
  if (!begun) throw new Error('the patch is empty')
  if (!ended) throw new Error(`a patch must end with "${END_PATCH}"`)
  return sections
}

/** Turn one literal-match verdict into the applied text or a line-numbered failure. */
function applyHunkMatch(match: LiteralEditMatch, hunk: PatchHunk, displayPath: string): string {
  switch (match.kind) {
    case 'applied':
      return match.content
    case 'missing':
      throw new FsError(`line ${hunk.line}: the hunk's context and removed lines were not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
    case 'ambiguous':
      throw new FsError(`line ${hunk.line}: the hunk's context and removed lines match ${match.replacements} places in "${displayPath}"; add surrounding context lines`, 'FS_AMBIGUOUS_EDIT')
  }
}

/**
 * Apply one Update File section's hunks, in order, to LF-normalized content.
 * Without a locator a hunk's block must match exactly once in the whole text;
 * with one it must match exactly once at or after the single line containing the
 * locator, so a `@@` that cannot position the change fails instead of editing
 * another match.
 * @param text - the file's current content, LF-normalized.
 * @param hunks - the section's hunks, in patch order.
 * @param displayPath - the model-facing path named in a failure message.
 * @returns the fully updated content.
 */
export function applyPatchHunks(text: string, hunks: readonly PatchHunk[], displayPath: string): string {
  let current = text
  for (const hunk of hunks) {
    if (hunk.anchor === undefined) {
      current = applyHunkMatch(matchLiteralEdit(current, hunk.oldText, hunk.newText, false), hunk, displayPath)
      continue
    }
    const anchor = hunk.anchor
    const lines = current.split('\n')
    let anchorIndex = -1
    let anchorCount = 0
    lines.forEach((line, index) => {
      if (!line.includes(anchor)) return
      if (anchorCount === 0) anchorIndex = index
      anchorCount += 1
    })
    if (anchorCount === 0) throw new FsError(`line ${hunk.line}: "@@ ${anchor}" was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
    if (anchorCount > 1) throw new FsError(`line ${hunk.line}: "@@ ${anchor}" matches ${anchorCount} lines in "${displayPath}"; use a longer locator`, 'FS_AMBIGUOUS_EDIT')
    const region = lines.slice(anchorIndex).join('\n')
    const replaced = applyHunkMatch(matchLiteralEdit(region, hunk.oldText, hunk.newText, false), hunk, displayPath)
    current = [...lines.slice(0, anchorIndex), ...replaced.split('\n')].join('\n')
  }
  return current
}

/**
 * Format an applied patch as the model-facing message.
 * @param files - the applied files, in patch order.
 * @returns one line per file naming whether it was created or updated.
 */
export function formatApplyPatchOutput(files: readonly PatchFileOutcome[]): string {
  const header = `Applied ${files.length} file change${files.length === 1 ? '' : 's'}.`
  return [header, ...files.map(file => `${file.operation === 'create' ? 'Created' : 'Updated'} ${file.path}`)].join('\n')
}

/**
 * Derive display diffs from the patch arguments: a call-time presenter has no
 * prior content, so an update shows the hunk's own removed/added lines and a
 * create shows its whole content. A `Delete File` section contributes nothing —
 * the executor refuses it — and a malformed patch yields `undefined`.
 * @param patch - the raw patch argument.
 * @returns the call's file diffs, or `undefined` when nothing is renderable.
 */
export function patchCallDiffs(patch: string): FileDiff[] | undefined {
  let sections: PatchSection[]
  try {
    sections = parseApplyPatch(patch)
  } catch {
    // Display must never fail a replay: a malformed patch falls back to a generic card.
    return undefined
  }
  const diffs = sections.flatMap((section): FileDiff[] => {
    switch (section.kind) {
      case 'add': return [{ path: section.path, oldText: null, newText: section.content }]
      case 'update': return section.hunks.map(hunk => ({ path: section.path, oldText: hunk.oldText === '' ? null : hunk.oldText, newText: hunk.newText }))
      case 'delete': return []
    }
  })
  return diffs.length === 0 ? undefined : diffs
}

/**
 * The single file a patch changes, or `undefined` when it is malformed or
 * multi-file. A multi-file patch declares no scope, which schedules it
 * exclusively: one overlap key cannot describe several files.
 * @param patch - the raw patch argument.
 * @returns the only section's path, or `undefined`.
 */
export function patchSinglePath(patch: string): string | undefined {
  const [only, ...rest] = parseApplyPatch(patch)
  return only !== undefined && rest.length === 0 ? only.path : undefined
}

/** Whether the patch parses and touches exactly one file. */
function isSingleTarget(patch: string): boolean {
  try {
    return patchSinglePath(patch) !== undefined
  } catch {
    // A malformed patch is never concurrency-safe; execute reports the parse error.
    return false
  }
}

/**
 * Register the `apply_patch` tool and its scope-aware system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param caps - the resolved patch size cap.
 * @param sandbox - the shared sandbox-escalation API (advertisement, mode stamping, denial mapping).
 */
export function applyApplyPatchTool(ctx: Context, caps: ApplyPatchCaps, sandbox: FsSandboxController): void {
  ctx.systemPrompt.section({
    name: 'tool:apply_patch',
    order: ctx.systemPrompt.getSectionOrder('TOOL_APPLY_PATCH'),
    text: ({ scope }) => ctx.tools.get('apply_patch', scope) === undefined
      ? ''
      : 'Use the apply_patch tool to change several files with one V4A patch: "*** Begin Patch", "*** Add File:", "*** Update File:", and "*** End Patch" sections. It validates every section before writing any of them. Prefer write or edit for a single file.',
  })

  ctx.tools.register(defineTool({
    name: 'apply_patch',
    description: 'Apply a V4A patch that creates or updates several UTF-8 text files.',
    parameters: {
      patch: {
        type: 'string',
        required: true,
        description: 'The complete patch, from "*** Begin Patch" through "*** End Patch". Update hunks carry " " context, "-" removed, and "+" added lines.',
      },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                operation: { type: 'string', required: true, enum: ['create', 'update'] },
                before: {
                  required: true,
                  oneOf: [
                    { type: 'string' },
                    { type: 'null' },
                  ],
                },
                after: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatApplyPatchOutput(value.files) }],
      presentationMeta: (_args, value) => ({
        diffs: value.files.flatMap(file => file.before === null
          ? []
          : computeHunkDiffs(file.path, file.before, file.after)
            .map(({ path, oldText, newText }) => ({ path, oldText, newText }))),
      }),
    },
    // A one-file patch shares the per-file key with `write`/`edit`; a multi-file
    // patch declares no scope, and the registry schedules an unscoped call
    // exclusively. A malformed patch is exclusive through the same path.
    isConcurrencySafe: args => isSingleTarget(args.patch),
    parallelScopeKey: (args) => {
      const path = patchSinglePath(args.patch)
      return path === undefined ? '' : fileScopeKey(path)
    },
    async execute(args: ApplyPatchToolArgs, exec) {
      const bytes = Buffer.byteLength(args.patch, 'utf8')
      if (bytes > caps.maxBytes) {
        throw new Error(`the patch is ${bytes} bytes, above the configured cap of ${caps.maxBytes} bytes; split it into smaller patches`)
      }
      const sections = parseApplyPatch(args.patch)
      const sandboxPolicy = await sandbox.resolvePolicy('apply_patch', args, exec)
      // Validation pass: resolve every target and compute every outcome before
      // the first write. A bad hunk or a target that already exists therefore
      // changes nothing; the writes themselves are one atomic publication per
      // file, and a later file's failure leaves earlier files applied.
      const staged: StagedWrite[] = []
      for (const section of sections) {
        if (section.kind === 'delete') {
          throw new Error(`line ${section.line}: "${DELETE_PREFIX} ${section.path}" is not supported: the mounted filesystem has no delete operation`)
        }
        const target = await ctx.fs.resolve(section.path, sessionResolveOptions(exec, sandboxPolicy?.workspaceRoot))
        if (section.kind === 'add') {
          if (await ctx.fs.stat(target, exec.signal) !== undefined) {
            throw new Error(`line ${section.line}: "${target.displayPath}" already exists; use "*** Update File:" or delete it first`)
          }
          staged.push({
            target,
            before: null,
            content: section.content,
            // A create never overwrites: the intent is imposed rather than
            // taken from the slot, closing the race after the check above.
            intent: { kind: 'createIfAbsent' },
            after: section.content,
          })
          continue
        }
        const original = await ctx.fs.readText(target, exec.signal)
        const before = normalizeLineEndings(original)
        const after = applyPatchHunks(before, section.hunks, target.displayPath)
        staged.push({
          target,
          before,
          content: restoreLineEndings(after, detectLineEndings(original)),
          intent: await ctx.waterfall('fs/write-intent', target, exec, () => undefined),
          after,
        })
      }
      const files: PatchFileOutcome[] = []
      for (const step of staged) {
        let outcome: FsWriteOutcome
        try {
          outcome = await ctx.fs.writeText(step.target, step.content, step.intent, exec.signal, sandboxPolicy)
        } catch (error: unknown) {
          throw remediateFsError(sandbox.mapError(error, sandboxPolicy), step.target.displayPath)
        }
        ctx.emit('fs/observed', step.target, { kind: 'present', version: outcome.version }, exec)
        files.push({ path: step.target.displayPath, operation: step.before === null ? 'create' : 'update', before: step.before, after: step.after })
      }
      return { files }
    },
    // Pure display: the requested diffs straight from the patch arguments.
    presentCall(args): ToolCallView {
      const diffs = patchCallDiffs(args.patch)
      if (diffs === undefined) return { card: 'generic', title: 'Apply patch', rawInput: { patch: args.patch } }
      return {
        card: 'diff',
        title: 'Apply patch',
        diffs,
        locations: [...new Set(diffs.map(diff => diff.path))].map(path => ({ path })),
      }
    },
    // Applied hunks replace the call-time snippet; a create contributes no
    // applied hunk, so its argument-derived diff stands, as `write` does.
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta) ?? patchCallDiffs(args.patch)
      return diffs === undefined ? undefined : { card: 'diff', title: 'Apply patch', diffs }
    },
  }))
}
