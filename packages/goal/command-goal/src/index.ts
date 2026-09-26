/**
 * Human-facing `/goal` command over the persisted same-session goal domain.
 * @module @deepseek-ai/dsh-command-goal
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { GoalError } from '@deepseek-ai/dsh-goal'
import type { GoalPhase, GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'

export const name = 'command-goal'
export const inject = ['commands', 'goals']

const USAGE = 'Usage: /goal [<objective>|clear|edit [<objective>]|pause|resume] [--rounds <n>] [--tokens <n>]'

/** One trailing budget argument: a cap flag and its unvalidated value token. */
const BUDGET_ARGUMENT = /(?:^|\s)--(rounds|tokens)[ \t]+(\S+)$/u

/** One input with its trailing budget arguments removed, or the offending budget value. */
type StrippedInput =
  | { readonly input: string; readonly maxGoalRounds?: number; readonly maxGoalTokens?: number }
  | { readonly invalidBudget: string }

type GoalCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'create'; readonly objective: string; readonly maxGoalRounds?: number; readonly maxGoalTokens?: number }
  | { readonly kind: 'edit'; readonly objective?: string; readonly maxGoalRounds?: number; readonly maxGoalTokens?: number }
  | { readonly kind: 'invalid-edit' }
  | { readonly kind: 'invalid-budget'; readonly value: string }
  | { readonly kind: 'misplaced-budget' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'clear' }

/**
 * Strip the trailing `--rounds <n>` and `--tokens <n>` arguments. Repeating a
 * flag keeps its last occurrence; a non-integer or non-positive value is
 * reported rather than falling through as objective text.
 */
function stripBudgetArguments(rawInput: string): StrippedInput {
  let input = rawInput.trim()
  let maxGoalRounds: number | undefined
  let maxGoalTokens: number | undefined
  for (;;) {
    const argument = BUDGET_ARGUMENT.exec(input)
    if (argument === null) break
    const value = argument[2] ?? ''
    const count = Number(value)
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(count) || count < 1) return { invalidBudget: value }
    if (argument[1] === 'rounds') maxGoalRounds ??= count
    else maxGoalTokens ??= count
    input = input.slice(0, argument.index).trimEnd()
  }
  return {
    input,
    ...maxGoalRounds === undefined ? {} : { maxGoalRounds },
    ...maxGoalTokens === undefined ? {} : { maxGoalTokens },
  }
}

/** The create/edit request fields one parsed command carries. */
function budgetFields(
  command: { readonly maxGoalRounds?: number; readonly maxGoalTokens?: number },
): { maxGoalRounds?: number; maxGoalTokens?: number } {
  return {
    ...command.maxGoalRounds === undefined ? {} : { maxGoalRounds: command.maxGoalRounds },
    ...command.maxGoalTokens === undefined ? {} : { maxGoalTokens: command.maxGoalTokens },
  }
}

/** Parse only the grammar owned by `/goal`; arbitrary other input is an objective. */
function parseGoalCommand(rawInput: string): GoalCommand {
  const stripped = stripBudgetArguments(rawInput)
  if ('invalidBudget' in stripped) return { kind: 'invalid-budget', value: stripped.invalidBudget }
  const { input } = stripped
  const budgets = budgetFields(stripped)
  const hasBudget = stripped.maxGoalRounds !== undefined || stripped.maxGoalTokens !== undefined
  if (input.length === 0) return hasBudget ? { kind: 'misplaced-budget' } : { kind: 'show' }
  const control = input.toLowerCase()
  if (control === 'clear') return hasBudget ? { kind: 'misplaced-budget' } : { kind: 'clear' }
  if (control === 'pause') return hasBudget ? { kind: 'misplaced-budget' } : { kind: 'pause' }
  if (control === 'resume') return hasBudget ? { kind: 'misplaced-budget' } : { kind: 'resume' }
  if (control === 'edit') return hasBudget ? { kind: 'edit', ...budgets } : { kind: 'invalid-edit' }
  if (/^edit(?=\s)/iu.test(input)) return { kind: 'edit', objective: input.slice(4).trim(), ...budgets }
  return { kind: 'create', objective: input, ...budgets }
}

/** The spent budget axes of one goal, with each axis's spend. */
function budgetExhaustion(goal: GoalView): string | undefined {
  const spent: string[] = []
  if (goal.roundsStarted >= goal.maxGoalRounds) {
    spent.push(`round budget spent (${goal.roundsStarted}/${goal.maxGoalRounds} rounds)`)
  }
  if (goal.maxGoalTokens !== undefined && goal.tokensUsed >= goal.maxGoalTokens) {
    spent.push(`token budget spent (${goal.tokensUsed}/${goal.maxGoalTokens} tokens)`)
  }
  return spent.length === 0 ? undefined : spent.join('; ')
}

/**
 * The explicit status one goal reports: `achieved`, `blocked`, or
 * `budget-exhausted` once it stopped, otherwise the live durable phase.
 */
function goalStatus(goal: GoalView): { readonly label: string; readonly reason?: string } {
  if (goal.phase === 'complete') return { label: 'achieved' }
  const exhaustion = budgetExhaustion(goal)
  if (exhaustion !== undefined) return { label: 'budget-exhausted', reason: exhaustion }
  return { label: phaseLabel(goal.phase) }
}

/** Human label for one live durable goal phase; a completed goal reports a terminal status instead. */
function phaseLabel(phase: Exclude<GoalPhase, 'complete'>): string {
  switch (phase) {
    case 'active': return 'active'
    case 'paused': return 'paused'
    case 'blocked': return 'blocked'
    /* v8 ignore next 2 -- every non-complete phase is handled above */
    default: return assertNever(phase, 'goal phase')
  }
}

/** Commands that are meaningful from one exact live state. */
function commandHint(goal: GoalView): string {
  if (goal.phase !== 'complete' && budgetExhaustion(goal) !== undefined) {
    return '/goal edit --rounds <n> or --tokens <n>, /goal clear'
  }
  if (goal.phase === 'active') {
    return goal.activation === 'armed'
      ? '/goal edit <objective>, /goal pause, /goal clear'
      : '/goal edit <objective>, /goal resume, /goal clear'
  }
  switch (goal.phase) {
    case 'paused':
    case 'blocked':
      return '/goal edit <objective>, /goal resume, /goal clear'
    case 'complete':
      return '/goal <objective>, /goal clear'
    /* v8 ignore next 2 -- the active branch and every non-active phase are handled above */
    default: return assertNever(goal.phase, 'goal phase')
  }
}

/** Render direct UI output without exposing compare-and-set internals. */
function renderGoal(title: string, goal: GoalView): CommandResult {
  const reason = goal.phase === 'blocked' ? goal.blockedReason : undefined
  /* v8 ignore next -- durable replay guarantees every blocked goal carries its validated reason */
  if (goal.phase === 'blocked' && reason === undefined) throw new TypeError('blocked goal is missing its reason')
  const status = goalStatus(goal)
  const blocker = reason === undefined ? [] : [`Blocker: ${reason.code}: ${reason.message}`]
  return {
    kind: 'success',
    text: [
      title,
      `Status: ${status.label}`,
      ...status.reason === undefined ? [] : [`Reason: ${status.reason}`],
      ...blocker,
      `Objective: ${goal.objective}`,
      `Rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}`,
      ...goal.maxGoalTokens === undefined ? [] : [`Tokens: ${goal.tokensUsed}/${goal.maxGoalTokens}`],
      `Activation: ${goal.activation}`,
      '',
      `Commands: ${commandHint(goal)}`,
    ].join('\n'),
  }
}

/** Exact current compare-and-set ref. */
function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

/** Direct error for an operation that requires a current goal. */
function missingGoal(action: string): CommandResult {
  return {
    kind: 'error',
    text: `No goal is currently set; /goal ${action} requires one. ${USAGE}`,
  }
}

/**
 * Submit the invocation's admitted composer attachments as one model-visible user
 * message ahead of the goal's next round. The attachments precede a fixed text
 * block naming their role, so a later goal round reads them from ordinary
 * session history without the goal domain storing attachment state.
 */
function submitObjectiveAttachments(invocation: CommandInvocation): void {
  if (invocation.attachments.length === 0) return
  invocation.agent.followup(createUserMessage({
    content: [...invocation.attachments, { type: 'text', text: 'Reference attachments for the goal objective.' }],
    source: { kind: 'user' },
  }))
}

/** Execute one parsed human command through the domain that owns persistence. */
function executeGoalCommand(ctx: Context, invocation: CommandInvocation): CommandResult {
  const command = parseGoalCommand(invocation.rawInput)
  const carriesObjective = command.kind === 'create'
    || (command.kind === 'edit' && command.objective !== undefined)
  if (invocation.attachments.length > 0 && !carriesObjective) {
    return {
      kind: 'error',
      text: 'Attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.',
    }
  }
  try {
    const current = ctx.goals.get(invocation.agent)
    switch (command.kind) {
      case 'show':
        return current === undefined
          ? { kind: 'success', text: `No goal is currently set.\n${USAGE}` }
          : renderGoal('Goal', current)
      case 'invalid-edit':
        return { kind: 'error', text: `Goal editing requires a replacement objective or a budget argument.\n${USAGE}` }
      case 'invalid-budget':
        return {
          kind: 'error',
          text: `Budget values are positive whole numbers; got ${JSON.stringify(command.value)}.\n${USAGE}`,
        }
      case 'misplaced-budget':
        return {
          kind: 'error',
          text: `--rounds and --tokens accompany a goal objective or /goal edit.\n${USAGE}`,
        }
      case 'create': {
        if (current !== undefined && current.phase !== 'complete') {
          return {
            kind: 'error',
            text: `A goal is already ${phaseLabel(current.phase)}. Use /goal edit <objective> to change it or /goal clear before replacing it.`,
          }
        }
        const created = ctx.goals.create(invocation.agent, { objective: command.objective, ...budgetFields(command) })
        submitObjectiveAttachments(invocation)
        return renderGoal('Goal created', created)
      }
      case 'edit': {
        if (current === undefined) return missingGoal('edit')
        if (current.phase === 'complete' && command.objective !== undefined) {
          const replaced = ctx.goals.create(invocation.agent, { objective: command.objective, ...budgetFields(command) })
          submitObjectiveAttachments(invocation)
          return renderGoal('Goal created', replaced)
        }
        const edited = ctx.goals.edit(invocation.agent, goalRef(current), {
          ...command.objective === undefined ? {} : { objective: command.objective },
          ...budgetFields(command),
        })
        submitObjectiveAttachments(invocation)
        return renderGoal('Goal updated', edited)
      }
      case 'pause':
        if (current === undefined) return missingGoal('pause')
        return renderGoal('Goal paused', ctx.goals.pause(invocation.agent, goalRef(current)))
      case 'resume':
        if (current === undefined) return missingGoal('resume')
        return renderGoal('Goal resumed', ctx.goals.resume(invocation.agent, goalRef(current)))
      case 'clear':
        if (current === undefined) return { kind: 'success', text: 'No goal to clear.' }
        ctx.goals.clear(invocation.agent, goalRef(current))
        return { kind: 'success', text: 'Goal cleared.' }
      /* v8 ignore next 2 -- GoalCommand is closed and every member is handled above */
      default: return assertNever(command, 'goal command')
    }
  } catch (error: unknown) {
    if (error instanceof GoalError) {
      return {
        kind: 'error',
        text: 'The goal command is not valid for the current state. Run /goal to view available commands.',
      }
    }
    throw error
  }
}

/** Register the Codex-shaped `/goal` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-goal'),
    name: 'goal',
    description: 'Set or view the goal for a long-running task',
    input: { hint: '[<objective>|clear|edit [<objective>]|pause|resume] [--rounds <n>] [--tokens <n>]', attachments: true },
    handler: invocation => executeGoalCommand(ctx, invocation),
  })
}
