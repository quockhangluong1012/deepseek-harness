/**
 * Human-facing `/rewind` command: returns to a turn with an explicit mode — restore
 * working-directory code, branch the conversation, or both — and optionally replaces the
 * message that opened the turn before the branch is taken (§31.1 D3).
 *
 * The code half restores through `dsh-workspace-changes`' `restore()`. The conversation half
 * reuses the Session branch mechanism (`sessionController.fork`), never a second log editor:
 * the source conversation is left untouched and the branch is a new Session. A replacement
 * message is admitted through the ordinary prompt path, so the model-visible text is logged.
 * @module @deepseek-ai/dsh-command-rewind
 */

import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import type {} from '@deepseek-ai/dsh-api-session-controller'

export const name = 'command-rewind'
export const inject = ['commands', 'workspaceChanges', 'sessionController']

const MODES = ['code', 'conversation', 'both'] as const

/** Which half of a rewind one invocation asks for. */
type RewindMode = typeof MODES[number]

const USAGE = [
  'Usage: /rewind <mode> <turn> [--edit <text>]',
  '',
  'Modes:',
  '  code          Restore working-directory files to their content at the start of <turn>.',
  '  conversation  Branch the conversation from just before <turn>: the message that opened it',
  '                and every later turn are dropped from the branch.',
  '  both          Branch the conversation, then restore the files.',
  '',
  '  --edit <text> Replaces the message that opened <turn> in the branch; the replacement is sent',
  '                as the branch\'s first message. The original stays in this conversation.',
  '                Accepted only with conversation or both.',
  '',
  'Consequences:',
  '  Restoring files overwrites the working tree and is not itself reversible — content that was',
  '  never committed to git is gone. Conversation rewind never changes this conversation: it',
  '  leaves a new Session to open from the sidebar.',
].join('\n')

/** One parsed invocation. */
interface RewindRequest {
  readonly mode: RewindMode
  readonly turn: number
  readonly edit: string | undefined
}

/** Parse outcome: a request, a usage error, or the help request. */
type ParsedInput =
  | { readonly kind: 'request'; readonly request: RewindRequest }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly text: string }

/** The `--edit` flag, at a token boundary so message text may contain the literal word. */
const EDIT_FLAG = /(?:^|\s)--edit(?=\s|$)/u

function isMode(value: string): value is RewindMode {
  return (MODES as readonly string[]).includes(value)
}

/** Parse the command line strictly: the mode is required and never inferred. */
function parseInput(rawInput: string): ParsedInput {
  const trimmed = rawInput.trim()
  if (trimmed === '--help') return { kind: 'help' }
  const flag = EDIT_FLAG.exec(trimmed)
  const head = flag === null ? trimmed : trimmed.slice(0, flag.index)
  const edit = flag === null ? undefined : trimmed.slice(flag.index + flag[0].length).trim()
  const tokens = head.split(/\s+/u).filter(token => token.length > 0)
  const [modeToken, turnToken, ...rest] = tokens
  if (modeToken === undefined) {
    return { kind: 'error', text: `/rewind: expected a mode. ${USAGE}` }
  }
  if (!isMode(modeToken)) {
    return { kind: 'error', text: `/rewind: unknown mode "${modeToken}"; expected one of ${MODES.join(', ')}. ${USAGE}` }
  }
  if (turnToken === undefined) {
    return { kind: 'error', text: `/rewind ${modeToken}: expected a positive turn number. ${USAGE}` }
  }
  const turn = Number(turnToken)
  if (!Number.isInteger(turn) || turn < 1) {
    return { kind: 'error', text: `/rewind ${modeToken}: turn must be a positive integer, got "${turnToken}". ${USAGE}` }
  }
  if (rest.length > 0) {
    return { kind: 'error', text: `/rewind: unexpected argument${rest.length > 1 ? 's' : ''} ${rest.join(' ')}. ${USAGE}` }
  }
  if (edit !== undefined && edit.length === 0) {
    return { kind: 'error', text: `/rewind: --edit needs the replacement text. ${USAGE}` }
  }
  if (edit !== undefined && modeToken === 'code') {
    return { kind: 'error', text: `/rewind: --edit replaces the message that opened the turn, so it needs a conversation rewind. ${USAGE}` }
  }
  return { kind: 'request', request: { mode: modeToken, turn, edit } }
}

/** The lowest-seq `workspace/changes` event announcing the given turn, or undefined. */
function turnAnnouncementSeq(invocation: CommandInvocation, turn: number): number | undefined {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  for (const event of invocation.agent.session.snapshotEvents()) {
    if (event.type === 'workspace/changes' && event.data.turn === turn) return event.seq
  }
  return undefined
}

/**
 * The seq of the named turn's `turn/start`, or undefined when the turn never started.
 */
function turnStartSeq(invocation: CommandInvocation, turn: number): number | undefined {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  for (const event of invocation.agent.session.snapshotEvents()) {
    if (event.type === 'turn/start' && event.data.turn === turn) return event.seq
  }
  return undefined
}

/** Render the code half's outcome lines. */
function codeLines(
  turn: number, result: { restored: readonly string[]; skipped: readonly { display: string; reason: string }[] },
): string[] {
  const lines = [`Restored working-directory files to the start of turn ${turn}.`]
  if (result.restored.length > 0) lines.push('', 'Restored:', ...result.restored.map(path => `  ${path}`))
  if (result.skipped.length > 0) {
    lines.push('', 'Left untouched (could not restore):', ...result.skipped.map(skip => `  ${skip.display} (${skip.reason})`))
  }
  if (result.restored.length === 0 && result.skipped.length === 0) lines.push('Nothing changed since that turn.')
  if (result.restored.length > 0) {
    lines.push('', 'Content this rewind replaced is not recoverable through /rewind; only git history holds it.')
  }
  return lines
}

/** Execute one `/rewind` invocation: validate every half, then branch, then restore. */
async function executeRewind(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const parsed = parseInput(invocation.rawInput)
  if (parsed.kind === 'help') return { kind: 'success', text: USAGE }
  if (parsed.kind === 'error') return { kind: 'error', text: parsed.text }
  const { mode, turn, edit } = parsed.request
  const sessionId = invocation.agent.session.id
  const wantsCode = mode !== 'conversation'
  const wantsConversation = mode !== 'code'

  // Every precondition is resolved before anything acts, so a rejected rewind cannot
  // restore half the files or leave a branch behind.
  let branchAtSeq: number | undefined
  let opensSession = false
  if (wantsConversation) {
    const turnStart = turnStartSeq(invocation, turn)
    if (turnStart === undefined) {
      return { kind: 'error', text: `/rewind: turn ${turn} never started in this session, so it cannot be rewound to` }
    }
    // The branch inherits through the event before the turn opens, so its own history ends
    // where the named turn began and `--edit` replaces that turn's message. A turn that opens
    // the session has no event before it: the branch inherits the opening event itself, and
    // the fork mechanism closes that still-open turn as `forked`.
    opensSession = turnStart === 0
    branchAtSeq = opensSession ? turnStart : turnStart - 1
  }
  const announcementSeq = wantsCode ? turnAnnouncementSeq(invocation, turn) : undefined
  if (mode === 'code' && announcementSeq === undefined) {
    return { kind: 'error', text: `/rewind: no recorded file changes for turn ${turn} — it may not exist, or made no file changes` }
  }

  const lines: string[] = []
  const failures: string[] = []
  let acted = false

  // The branch is the non-destructive half, so it runs first: a failing restore must not be
  // preceded by an irreversible overwrite.
  if (branchAtSeq !== undefined) {
    try {
      const fork = await ctx.sessionController.fork({ sessionId, atSeq: branchAtSeq })
      acted = true
      lines.push(
        opensSession
          ? `Conversation rewound to the start of turn ${turn}: branched to ${fork.sessionId}.`
          : `Conversation rewound to just before turn ${turn}: branched to ${fork.sessionId}.`,
        'This conversation is unchanged; open the branch from the sidebar to continue there.',
      )
      if (edit !== undefined) {
        await ctx.sessionController.prompt({
          requestId: brandString<SessionRequestId>(`rewind-${randomUUID()}`),
          sessionId: fork.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: edit }],
        }, invocation.signal)
        lines.push('', `Replaced the message that opened turn ${turn} in the branch and sent it there.`)
      }
    } catch (error) {
      failures.push(`conversation rewind failed: ${String(error)}`)
    }
  }

  if (wantsCode) {
    if (announcementSeq === undefined) {
      lines.push(`Code: turn ${turn} has no recorded file changes, so nothing was restored.`)
    } else {
      try {
        const result = await ctx.workspaceChanges.restore(sessionId, announcementSeq, invocation.signal)
        if (result === undefined) {
          failures.push(`code rewind failed: turn ${turn} was not recorded with a git snapshot, so its code cannot be rewound`)
        } else {
          acted = true
          if (lines.length > 0) lines.push('')
          lines.push(...codeLines(turn, result))
        }
      } catch (error) {
        failures.push(`code rewind failed: ${String(error)}`)
      }
    }
  }

  if (failures.length > 0) {
    if (!acted) return { kind: 'error', text: `/rewind: ${failures.join('; ')}` }
    lines.push('', ...failures.map(failure => `Incomplete — ${failure}`))
  }
  return { kind: 'success', text: lines.join('\n') }
}

/** Register `/rewind` for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'rewind',
    description: 'Return to a turn: restore code, branch the conversation, or both',
    input: { hint: '<mode> <turn> [--edit <text>]' },
    handler: invocation => executeRewind(ctx, invocation),
  })
}
