/**
 * The facade over the compiler's two source families.
 *
 * `core/system-prompt` remains the owner of every prompt contribution: this
 * module reads the assembly it produced and wraps each non-empty section and
 * runtime context in a source envelope. `dsh-agent-kernel` remains the owner of
 * the durable task contract: this module reads its current view of the session
 * log and projects the task's own authority — objective, acceptance criteria,
 * plan, and unresolved failures — into required envelopes.
 *
 * Neither function reads a log or assembles a prompt of its own.
 *
 * @module @deepseek-ai/dsh-agent-context/sources
 */

import type { ChangeContract, KernelView } from '@deepseek-ai/dsh-agent-kernel'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { classifyContribution, retentionOf } from './classify.ts'
import type { ContextSource } from './types.ts'

/**
 * Wrap the assembled prompt contributions the compiler is a facade over.
 * @param assembly - the assembly `core/system-prompt` produced for this step.
 * @returns one envelope per non-empty contribution, sections before contexts,
 *   each in the order the assembly placed it.
 */
export function sourcesFromAssembly(assembly: PromptAssembly): ContextSource[] {
  const contributions = [...assembly.sections, ...assembly.contexts]
  return contributions
    .filter(contribution => contribution.text.length > 0)
    .map((contribution) => {
      const classified = classifyContribution(contribution.name)
      return {
        id: contribution.name,
        kind: classified.kind,
        content: contribution.text,
        trust: classified.trust,
        sourceRef: { source: classified.source, locator: contribution.name },
        retention: retentionOf(classified.kind),
      }
    })
}

/**
 * Project one kernel view into the task's own required sources.
 * @param view - the kernel's current view of a session's task, or undefined
 *   when no kernel is mounted or the session has no task contract yet.
 * @returns the objective, acceptance criteria, the declared change contract,
 *   constraints, latest plan, and unresolved failures, as required envelopes in
 *   a stable order.
 */
export function sourcesFromView(view: KernelView | undefined): ContextSource[] {
  if (view === undefined) return []
  const { task } = view
  const kernel = (locator: string) => ({ source: 'kernel' as const, locator })
  const sources: ContextSource[] = []
  if (task.objective.length > 0) {
    sources.push({
      id: 'task:objective',
      kind: 'task',
      content: task.objective,
      trust: 'trusted',
      sourceRef: kernel(`task/${task.taskId}`),
      retention: 'required',
      subject: 'objective',
    })
  }
  for (const criterion of task.acceptance) {
    sources.push({
      id: `task:acceptance:${criterion.id}`,
      kind: 'task',
      content: `${criterion.description} (verifier: ${criterion.verifier}${criterion.required ? ', required' : ''})`,
      trust: 'trusted',
      sourceRef: kernel(`task/${task.taskId}/acceptance/${criterion.id}`),
      retention: 'required',
    })
  }
  if (task.changeContract !== undefined) {
    sources.push({
      id: 'task:change-contract',
      kind: 'task',
      content: changeContractText(task.changeContract),
      trust: 'trusted',
      sourceRef: kernel(`task/${task.taskId}/change-contract`),
      retention: 'required',
    })
  }
  task.constraints.forEach((constraint, index) => {
    sources.push({
      id: `task:constraint:${String(index)}`,
      kind: 'task',
      content: `${constraint.kind}: ${constraint.statement}`,
      trust: 'trusted',
      sourceRef: kernel(`task/${task.taskId}/constraint/${String(index)}`),
      retention: 'required',
    })
  })
  if (view.plan !== undefined) {
    sources.push({
      id: `plan:${String(view.plan.revision)}`,
      kind: 'plan',
      content: view.plan.steps.join('\n'),
      trust: 'trusted',
      sourceRef: kernel(`task/${task.taskId}/plan/${String(view.plan.revision)}`),
      retention: 'required',
      subject: 'plan',
    })
  }
  for (const actionId of view.openActionIds) {
    sources.push({
      id: `action:${actionId}`,
      kind: 'tool',
      content: `unsettled action: ${actionId}`,
      trust: 'trusted',
      sourceRef: kernel(`task/${task.taskId}/action/${actionId}`),
      retention: 'required',
    })
  }
  for (const failure of view.unresolvedFailures) {
    sources.push({
      id: `failure:${failure.failureId}`,
      kind: 'task',
      content: `unresolved failure: ${failure.kind}`,
      trust: 'trusted',
      sourceRef: kernel(`task/${task.taskId}/failure/${failure.failureId}`),
      retention: 'required',
    })
  }
  return sources
}

/**
 * Render one declared change contract as the model-visible statement of the
 * boundary its change must stay inside.
 * @param contract - the boundary the task declared before modifying anything.
 * @returns one line naming the goal, then one line per bound the contract declares.
 */
function changeContractText(contract: ChangeContract): string {
  const lines = [`change contract: ${contract.goal}`]
  const bounds: readonly (readonly [string, readonly string[]])[] = [
    ['expected files', contract.expectedFiles],
    ['allowed files', contract.allowedFiles],
    ['must preserve', contract.mustPreserve],
    ['forbidden changes', contract.forbiddenChanges],
    ['expected tests', contract.expectedTests],
  ]
  for (const [label, globs] of bounds) {
    if (globs.length > 0) lines.push(`${label}: ${globs.join(', ')}`)
  }
  return lines.join('\n')
}
