/**
 * Model-facing read-only tools over the per-turn workspace changes recorded for the calling
 * Session. The recorder in `@deepseek-ai/dsh-workspace-changes` owns snapshots, captures, and the
 * summaries they produce; this package only resolves a recorded turn by reference and renders it.
 * @module @deepseek-ai/dsh-tool-changes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes'
import { renderDiff, renderSummary } from './render.ts'

export type { TurnChangesFile, TurnChangesValue, TurnDiffHunk, TurnDiffValue } from './types.ts'

/** Stable Loader identity. */
export const name = 'tool-changes'

/** Services the tools read: the registry and the recorded-change service, which owns every bound. */
export const inject = ['tools', 'workspaceChanges']

/** Canonical `turn_changes` value: one recorded turn's changed files. */
const TURN_CHANGES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    turn: { type: 'integer', required: true },
    cwd: { type: 'string', required: true },
    files: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          display: { type: 'string', required: true },
          added: { type: 'integer', required: true },
          deleted: { type: 'integer', required: true },
          binary: { type: 'boolean' },
          oversized: { type: 'boolean' },
        },
      },
    },
    total: { type: 'integer', required: true },
    added: { type: 'integer', required: true },
    deleted: { type: 'integer', required: true },
  },
} as const

/** Canonical `turn_diff` value: one listed file's recorded comparison, plus what it could read. */
const TURN_DIFF_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'text' },
        turn: { type: 'integer', required: true },
        path: { type: 'string', required: true },
        display: { type: 'string', required: true },
        before: { type: 'boolean', required: true },
        after: { type: 'boolean', required: true },
        hunks: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              oldStart: { type: 'integer', required: true },
              oldLines: { type: 'integer', required: true },
              newStart: { type: 'integer', required: true },
              newLines: { type: 'integer', required: true },
              lines: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
        },
        coarse: { type: 'boolean', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'binary' },
        turn: { type: 'integer', required: true },
        path: { type: 'string', required: true },
        display: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'oversized' },
        turn: { type: 'integer', required: true },
        path: { type: 'string', required: true },
        display: { type: 'string', required: true },
      },
    },
  ],
} as const

/** Sequence of the last `workspace/changes` event announcing one turn, or undefined when it has none. */
function announcementSeq(events: readonly SessionEvent[], turn: number): number | undefined {
  let seq: number | undefined
  for (const event of events) {
    if (event.type === 'workspace/changes' && event.data.turn === turn) seq = event.seq
  }
  return seq
}

/** Turn of the last `workspace/changes` event, or undefined when the Session recorded none. */
function latestTurn(events: readonly SessionEvent[]): number | undefined {
  let turn: number | undefined
  for (const event of events) {
    if (event.type === 'workspace/changes') turn = event.data.turn
  }
  return turn
}

/** The calling Session; both tools are meaningless without one. */
function callingSession(exec: ToolRunContext): Session {
  const session = exec.agent?.session
  if (session === undefined) throw new Error('recorded turn changes require a calling agent Session')
  return session
}

/**
 * Resolve one turn's recorded summary for the calling Session.
 * @param ctx - composition providing `workspaceChanges`.
 * @param session - the calling agent's Session.
 * @param requested - the turn the model named, or undefined for the most recently recorded one.
 * @returns the announcing sequence and the summary the Host still serves for it.
 * @throws when the Session recorded no turn changes, the named turn recorded none, or this Host
 *   process no longer serves that record (a resumed Session, or a Session disposed since).
 */
function resolveSummary(
  ctx: Context,
  session: Session,
  requested: number | undefined,
): { seq: number; summary: WorkspaceChangesSummary } {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const events = session.snapshotEvents()
  const turn = requested ?? latestTurn(events)
  if (turn === undefined) throw new Error('this Session has recorded no turn changes yet')
  const seq = announcementSeq(events, turn)
  if (seq === undefined) throw new Error(`turn ${turn} recorded no workspace changes in this Session`)
  const summary = ctx.workspaceChanges.summary(session.id, seq)
  if (summary === undefined) {
    throw new Error(`the recorded changes of turn ${turn} are not available in this Host process`)
  }
  return { seq, summary }
}

/**
 * Register both read-only tools.
 * @param ctx - the plugin context: `tools` for registration, `workspaceChanges` for the records.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'turn_changes',
    description: 'List the files one turn changed in this workspace, with added and deleted line counts. '
      + 'Use it to review what earlier work changed before reading, editing, or reporting on those files; '
      + 'an oversized or binary file is listed with a marker instead of counts. '
      + 'Changes are recorded when a turn stops, so it reports completed turns. '
      + 'Omit turn for the most recently recorded one, then use turn_diff to read one listed file\'s diff.',
    parameters: {
      turn: { type: 'integer', description: 'Turn number to report. Omit for the most recently recorded turn.' },
    },
    output: {
      schema: TURN_CHANGES_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderSummary(value) }],
    },
    isConcurrencySafe: () => true,
    // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics; the recorded summary read is synchronous.
    async execute(args, exec) {
      const { summary } = resolveSummary(ctx, callingSession(exec), args.turn)
      return {
        turn: summary.turn,
        cwd: summary.cwd,
        files: summary.files.map(file => ({
          path: file.path,
          display: file.display,
          added: file.added,
          deleted: file.deleted,
          ...file.binary === true ? { binary: true } : {},
          ...file.oversized === true ? { oversized: true } : {},
        })),
        total: summary.total,
        added: summary.added,
        deleted: summary.deleted,
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'turn_diff',
    description: 'Read one file\'s recorded diff from a turn listed by turn_changes, without re-running whatever changed it. '
      + 'Pass the turn and the file path as turn_changes listed it; hunks carry three context lines and every line keeps its '
      + '+ or - prefix. A binary or oversized file reports that instead of lines.',
    parameters: {
      turn: { type: 'integer', description: 'Turn the file changed in. Omit for the most recently recorded turn.' },
      path: { type: 'string', required: true, description: 'A file path as turn_changes listed it for that turn.' },
    },
    output: {
      schema: TURN_DIFF_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderDiff(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = callingSession(exec)
      const { seq, summary } = resolveSummary(ctx, session, args.turn)
      const index = summary.files.findIndex(file => file.display === args.path || file.path === args.path)
      if (index < 0) throw new Error(`turn ${summary.turn} did not change a file listed as ${args.path}`)
      const diff = await ctx.workspaceChanges.diff(session.id, seq, index, exec.signal)
      if (diff === undefined) {
        throw new Error(`the recorded comparison of ${args.path} in turn ${summary.turn} is not available in this Host process`)
      }
      return diff.kind === 'text'
        ? {
          kind: 'text' as const,
          turn: summary.turn,
          path: diff.path,
          display: diff.display,
          before: diff.before,
          after: diff.after,
          hunks: diff.hunks,
          coarse: diff.coarse,
        }
        : { kind: diff.kind, turn: summary.turn, path: diff.path, display: diff.display }
    },
  }))
}
