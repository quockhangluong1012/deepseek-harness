/**
 * Human `/init` command that asks the invoking Agent to write the repository's
 * `AGENTS.md` guidance.
 *
 * @module @deepseek-ai/dsh-command-init
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const USAGE = 'Usage: /init'

/** Services required by the `/init` command. */
export const inject = ['commands']

/** Model-visible instruction submitted as one ordinary user message. */
const INIT_PROMPT = [
  'Inspect this repository and create or update the root `AGENTS.md` so an agent can work here without extra explanation.',
  'Cover what the project is, the commands that build, test, lint, and run it, the layout of the important directories, and the conventions that are easy to get wrong.',
  'Read the manifests, CI configuration, and existing documentation instead of guessing; when the repository documents its own standard for these files, follow it.',
  'Keep the result concise and specific, and report what you changed.',
].join(' ')

/**
 * Submit the workspace-instruction prompt as one user message.
 * @param invocation - the human invocation owning the target Agent.
 * @returns the command result shown to the requester.
 */
function executeInit(invocation: CommandInvocation): CommandResult {
  if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE }
  invocation.agent.followup(createUserMessage({
    content: [{ type: 'text', text: INIT_PROMPT }],
    source: { kind: 'user' },
  }))
  return { kind: 'success', text: 'Asked the agent to write AGENTS.md for this workspace.' }
}

/**
 * Register `/init` for interactive command adapters.
 * @param ctx - plugin context; registrations dispose with it.
 * @returns nothing; the Cordis fiber owns the registration.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-init'),
    name: 'init',
    description: 'Ask the agent to create or update AGENTS.md for this workspace',
    handler: (invocation: CommandInvocation) => executeInit(invocation),
  })
}
