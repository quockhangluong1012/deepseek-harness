/**
 * Model-facing batch edit: several literal replacements in one file, applied
 * together or not at all. Every edit resolves against the file's current text
 * before the single write that publishes them, so a failing edit leaves the file
 * byte-identical; the `fs/write-intent` slot supplies the same
 * read-before-mutation and stale-version guard `write` and `edit` use.
 * @module @deepseek-ai/dsh-tool-fs/src/multi-edit
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffCallView, DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import { computeHunkDiffs, diffsFromMeta } from './diff.ts'
import type { EditInput } from './edit.ts'
import { parseEditArgs } from './edit.ts'
import { remediateFsError } from './error.ts'
import { detectLineEndings, matchLiteralEdit, normalizeLineEndings, restoreLineEndings } from './literal-edit.ts'
import { fileScopeKey } from './scope-key.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { FsSandboxController } from './sandbox.ts'

/** The `multi_edit` tool's validated arguments. */
interface MultiEditToolArgs {
  file_path: string
  edits: { old_string: string; new_string: string; replace_all?: boolean }[]
  sandbox_permissions?: string
  justification?: string
}

/**
 * Validate the whole batch: a non-blank `file_path`, at least one edit, and each
 * edit through {@link parseEditArgs} with its index in any failure message, so
 * one bad entry names itself instead of failing the call anonymously.
 * @param args - the schema-validated raw tool arguments.
 * @returns the camelCased file path plus every edit, in the order given.
 */
export function parseMultiEditArgs(args: MultiEditToolArgs): { filePath: string; edits: EditInput[] } {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  if (args.edits.length === 0) throw new Error('edits must contain at least one edit')
  return {
    filePath: args.file_path,
    edits: args.edits.map((edit, index) => parseEditArgs({ ...edit, file_path: args.file_path }, `edits[${index}]`)),
  }
}

/**
 * Resolve every edit against LF-normalized content in the order given. Nothing
 * here touches the filesystem: the caller publishes the returned text once, so a
 * later edit's missing or ambiguous match cannot leave an earlier one applied.
 * @param content - the file's current content, LF-normalized.
 * @param edits - validated edits, in the caller's order.
 * @param displayPath - the model-facing path named in a failure message.
 * @returns the fully edited content.
 */
export function applyEdits(content: string, edits: readonly EditInput[], displayPath: string): string {
  let edited = content
  for (const [index, edit] of edits.entries()) {
    const match = matchLiteralEdit(edited, edit.oldString, edit.newString, edit.replaceAll)
    switch (match.kind) {
      case 'applied':
        edited = match.content
        break
      case 'missing':
        throw new FsError(`edits[${index}]: old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
      case 'ambiguous':
        throw new FsError(`edits[${index}]: old_string matched ${match.replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
    }
  }
  return edited
}

/**
 * Format a batch success as the model-facing message.
 * @param displayPath - the backend-resolved path shown to the model.
 * @param count - how many edits the call applied.
 * @returns the confirmation sentence naming the applied edit count.
 */
export function formatMultiEditOutput(displayPath: string, count: number): string {
  return `The file ${displayPath} has been updated successfully with ${count} edit${count === 1 ? '' : 's'}.`
}

/**
 * Register the `multi_edit` tool and its scope-aware system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param sandbox - the shared sandbox-escalation API (advertisement, mode stamping, denial mapping).
 */
export function applyMultiEditTool(ctx: Context, sandbox: FsSandboxController): void {
  ctx.systemPrompt.section({
    name: 'tool:multi_edit',
    order: ctx.systemPrompt.getSectionOrder('TOOL_MULTI_EDIT'),
    text: ({ scope }) => ctx.tools.get('multi_edit', scope) === undefined
      ? ''
      : 'Use the multi_edit tool when one file needs several replacements in a single call. It validates every edit against the file before applying any, so a failure leaves the file unchanged; read the file first (the default fs-observation-policy requires it). Use edit for a single replacement.',
  })

  ctx.tools.register(defineTool({
    name: 'multi_edit',
    description: 'Apply several literal edits to one UTF-8 text file, all or none.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend.' },
      edits: {
        type: 'array',
        required: true,
        description: 'Literal replacements applied in order to the same file. Every edit must resolve before any is written.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            old_string: { type: 'string', required: true, description: 'Literal text to replace. Must match exactly.' },
            new_string: { type: 'string', required: true, description: 'Literal replacement text. Use an empty string to delete the match.' },
            replace_all: { type: 'boolean', description: 'Replace all matches of this entry. Defaults to false; when false, old_string must appear exactly once.' },
          },
        },
      },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: formatMultiEditOutput(value.path, args.edits.length),
      }],
      presentationMeta: (args, value) => ({
        diffs: computeHunkDiffs(args.file_path, value.before, value.after)
          .map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    // Same-file calls never overlap on the resolved, case-folded path key —
    // shared with `write` and `edit`, so a batch never races a single edit on
    // its own target; distinct paths still pack.
    isConcurrencySafe: () => true,
    parallelScopeKey: args => fileScopeKey(args.file_path),
    async execute(args: MultiEditToolArgs, exec) {
      const input = parseMultiEditArgs(args)
      // Resolve the per-call sandbox policy BEFORE anything executes, as the
      // sibling mutators do.
      const sandboxPolicy = await sandbox.resolvePolicy('multi_edit', args, exec)
      const target = await ctx.fs.resolve(input.filePath, sessionResolveOptions(exec, sandboxPolicy?.workspaceRoot))
      // Single-slot decision: the mounted observation policy supplies the
      // observed version, and an unread existing target fails closed on the
      // provider's createIfAbsent check. The bare default is unconditional.
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      let before: string
      let after: string
      let outcome: FsWriteOutcome
      try {
        const original = await ctx.fs.readText(target, exec.signal)
        // LF-normalized for matching and for the diff basis; the file's own
        // line-ending style is restored on the single write below.
        before = normalizeLineEndings(original)
        after = applyEdits(before, input.edits, target.displayPath)
        outcome = await ctx.fs.writeText(
          target,
          restoreLineEndings(after, detectLineEndings(original)),
          intent,
          exec.signal,
          sandboxPolicy,
        )
      } catch (error: unknown) {
        throw remediateFsError(sandbox.mapError(error, sandboxPolicy), target.displayPath)
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return {
        path: target.displayPath,
        before,
        after,
      }
    },
    // Pure display: one diff entry per requested edit. An empty old_string maps
    // to oldText null, as `edit` does.
    presentCall(args): DiffCallView {
      return {
        card: 'diff',
        title: `Edit ${args.file_path}`,
        diffs: args.edits.map(edit => ({ path: args.file_path, oldText: edit.old_string || null, newText: edit.new_string })),
        locations: [{ path: args.file_path }],
      }
    },
    // Result-time metadata carries the applied hunks; an error or malformed
    // replay metadata falls back to the generic result card.
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: `Edit ${args.file_path}`, diffs }
    },
  }))
}
