/**
 * Pure UI presentations for the git tools: the pending terminal card (the
 * command line about to run) and the completed card (output plus exit-status
 * pill). Both run on live streaming and on session-log replay, so they read
 * only the call arguments and the settled result — never the filesystem, the
 * session, or the clock.
 *
 * @module @deepseek-ai/dsh-tool-git/presentation
 */

import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import type { TerminalCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'

/**
 * The pending card for one git or gh command.
 * @param title - the command line, as {@link commandLineOf} renders it.
 * @param repo - the repository directory the command runs in, when the call named one.
 * @returns a terminal call view headed by the command.
 */
export function presentCommandCall(title: string, repo: string | undefined): TerminalCallView {
  return { card: 'terminal', title, ...repo === undefined ? {} : { cwd: repo } }
}

/**
 * The completed card for one git or gh command. The exit marker becomes the
 * card's exit-status pill and leaves the output body, matching the shell tools;
 * an errored call falls back to a fenced console block because it has no exit
 * status.
 * @param result - the normalized tool result before post-execute policy.
 * @returns the completed view, or undefined when the result carries no single text block.
 */
export function presentCommandResult(result: ToolResult): ToolResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  if (result.isError) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${block.text.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
  const { body, ...exit } = parseExitStatus(block.text)
  return { card: 'terminal', output: body, ...exit }
}
