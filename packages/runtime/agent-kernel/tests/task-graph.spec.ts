/**
 * Task-graph specs (§7.2): the tree one session log folds into — the tasks in
 * creation order, their `parentTaskId` edges, the goal each was created under,
 * and the readers' answers for a task the log does not hold.
 *
 * @module @deepseek-ai/dsh-agent-kernel/tests/task-graph.spec
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { GoalId, type GoalChangeMeta } from '@deepseek-ai/dsh-goal'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/index.ts'
import type { TaskId } from '../src/types.ts'
import type { Rig } from './rig.ts'
import { eventsOf, humanMessage, makeAgent, preStep, rig, stopTurn } from './rig.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount a rig and remember it for teardown. */
async function mounted(config: Config = {}): Promise<Rig> {
  const result = await rig(config)
  contexts.push(result.ctx)
  return result
}

/** The goal every task before a clear was created under. */
const GOAL = { id: GoalId('goal-1'), revision: 1 }

/** Record one goal snapshot, as the goal plugin's own commit does. */
function createGoal(agent: Agent): void {
  const change: GoalChangeMeta = {
    kind: 'goal/change',
    version: 1,
    operation: 'create',
    goal: { ...GOAL, objective: 'ship the task graph', phase: 'active', maxGoalRounds: 4 },
    roundsStarted: 0,
    createdAt: 1,
    updatedAt: 2,
  }
  agent.session.append('goal/change', change)
}

/** Record the tombstone that clears the current goal. */
function clearGoal(agent: Agent): void {
  const change: GoalChangeMeta = {
    kind: 'goal/change',
    version: 1,
    operation: 'clear',
    cleared: GOAL,
    clearedAt: 3,
  }
  agent.session.append('goal/change', change)
}

/** Open one task and run it to completion through the kernel's own intake and completion gate. */
async function runTask(ctx: Context, agent: Agent, text: string, turn: number): Promise<void> {
  await preStep(ctx, agent, [humanMessage(text)], turn, 1)
  await stopTurn(ctx, agent, turn)
}

/** The two contracts one log recorded. */
function twoTasks(agent: Agent): readonly [TaskId, TaskId] {
  const created = eventsOf(agent, 'task/created')
  const first = created[0]
  const second = created[1]
  if (first === undefined || second === undefined) {
    throw new Error(`expected two task contracts, recorded ${String(created.length)}`)
  }
  return [first.taskId, second.taskId]
}

describe('task graph', () => {
  it('folds a goal and the tasks created under it into the tree their parent links describe', async () => {
    const { ctx, kernel } = await mounted()
    const agent = await makeAgent(ctx)
    createGoal(agent)
    await runTask(ctx, agent, 'first request', 1)
    await runTask(ctx, agent, 'second request', 2)

    const created = eventsOf(agent, 'task/created')
    const [parent, child] = twoTasks(agent)
    // The conversation's second request opens its own contract naming the one
    // it follows, which is the edge the graph folds.
    expect(created[1]?.parentTaskId).toBe(parent)
    expect(created[1]?.runId).not.toBe(created[0]?.runId)

    const graph = kernel.taskGraph.graphOf(agent.session)
    expect(graph.nodes.map(node => node.taskId)).toEqual([parent, child])
    expect(graph.nodeOf(parent)).toMatchObject({
      runId: created[0]?.runId,
      objective: 'first request',
      status: 'completed',
      children: [child],
      goal: GOAL,
    })
    expect(graph.nodeOf(child)?.parentTaskId).toBe(parent)
    expect(graph.childrenOf(parent)).toEqual([child])
    expect(graph.descendantsOf(parent)).toEqual([child])
    expect(graph.dependenciesOf(child)).toEqual([])
  })

  it('reads a childless task and an unknown task id from the same graph', async () => {
    const { ctx, kernel } = await mounted()
    const agent = await makeAgent(ctx)
    await runTask(ctx, agent, 'only request', 1)

    const task = eventsOf(agent, 'task/created')[0]?.taskId
    if (task === undefined) throw new Error('expected one task contract')
    const graph = kernel.taskGraph.graphOf(agent.session)
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodeOf(task)).toMatchObject({ children: [] })
    expect(graph.nodeOf(task)?.parentTaskId).toBeUndefined()
    expect(graph.childrenOf(task)).toEqual([])
    expect(graph.dependenciesOf(task)).toEqual([])
    expect(graph.descendantsOf(task)).toEqual([])

    const absent = brandString<TaskId>('no-such-task')
    expect(graph.nodeOf(absent)).toBeUndefined()
    expect(graph.childrenOf(absent)).toEqual([])
    expect(graph.dependenciesOf(absent)).toEqual([])
    expect(graph.descendantsOf(absent)).toEqual([])
  })

  it('leaves a task created after a goal clear without a goal, while the earlier task keeps its own', async () => {
    const { ctx, kernel } = await mounted()
    const agent = await makeAgent(ctx)
    createGoal(agent)
    await runTask(ctx, agent, 'under the goal', 1)
    clearGoal(agent)
    await runTask(ctx, agent, 'after the clear', 2)

    const [before, after] = twoTasks(agent)
    const graph = kernel.taskGraph.graphOf(agent.session)
    expect(graph.nodeOf(before)?.goal).toEqual(GOAL)
    expect(graph.nodeOf(after)?.goal).toBeUndefined()
    // The clear tombstone is not a contract: it only stops the goal from
    // applying to later tasks.
    expect(graph.nodes).toHaveLength(2)
  })
})
