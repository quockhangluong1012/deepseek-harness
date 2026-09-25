/**
 * Human-facing `/rewind` command: restores the working directory's code to its content at the
 * start of a given turn, spanning every turn between it and now (§31.1 D3, code-only rewind).
 * Conversation-only rewind is the existing Session "Branch" action; this command adds the
 * previously-absent code half. Combining both in one action remains Client UI work.
 * @module @deepseek-ai/dsh-command-rewind
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-workspace-changes'

export const name = 'command-rewind'
export const inject = ['commands', 'workspaceChanges']

const USAGE = 'Usage: /rewind <turn> — restores working-directory files to their content at the start of <turn>'

/** The lowest-seq `workspace/changes` event announcing the given turn, or undefined. */
function turnAnnouncementSeq(invocation: CommandInvocation, turn: number): number | undefined {
  for (const event of invocation.agent.session.snapshotEvents()) {
    if (event.type === 'workspace/changes' && event.data.turn === turn) return event.seq
  }
  return undefined
}

/** Execute one `/rewind` invocation: locate the turn's snapshot, restore, render the outcome. */
async function executeRewind(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const raw = invocation.rawInput.trim()
  const turn = Number(raw)
  if (raw.length === 0 || !Number.isInteger(turn) || turn < 1) {
    return { kind: 'error', text: `/rewind: expected a positive turn number. ${USAGE}` }
  }
  const seq = turnAnnouncementSeq(invocation, turn)
  if (seq === undefined) {
    return { kind: 'error', text: `/rewind: no recorded file changes for turn ${turn} — it may not exist, or made no file changes` }
  }
  const result = await ctx.workspaceChanges.restore(invocation.agent.session.id, seq, invocation.signal)
  if (result === undefined) {
    return { kind: 'error', text: `/rewind: turn ${turn} was not recorded with a git snapshot, so its code cannot be rewound` }
  }
  const lines = [`Rewound to the start of turn ${turn}.`]
  if (result.restored.length > 0) lines.push('', 'Restored:', ...result.restored.map(path => `  ${path}`))
  if (result.skipped.length > 0) {
    lines.push('', 'Left untouched (could not restore):', ...result.skipped.map(skip => `  ${skip.display} (${skip.reason})`))
  }
  if (result.restored.length === 0 && result.skipped.length === 0) lines.push('Nothing changed since that turn.')
  return { kind: 'success', text: lines.join('\n') }
}

/** Register `/rewind` for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'rewind',
    description: 'Restore working-directory files to their content at the start of a turn',
    input: { hint: '<turn>' },
    recordInput: false,
    handler: invocation => invocation.rawInput.trim() === '--help'
      ? { kind: 'success', text: USAGE }
      : executeRewind(ctx, invocation),
  })
}
