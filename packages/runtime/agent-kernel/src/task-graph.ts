/**
 * The task graph: the tasks one session's log holds, the parent/child edges
 * between them, the dependencies each contract declares, and the goal each task
 * was created under.
 *
 * The graph is folded on demand from the same events the ledger reads, so no
 * graph state outlives the log that produced it. A task delegated to a child
 * agent is a node of the CHILD's graph and is reached through the child's own
 * `parentTaskId`, because its contract is written into the child's log.
 *
 * @module @deepseek-ai/dsh-agent-kernel/task-graph
 */

import type { GoalRef } from '@deepseek-ai/dsh-goal'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { applyTransition, SPEC_STATE_BY_STATUS } from './state-machine.ts'
import type { RecordedTaskContract, TaskContract, TaskGraph, TaskGraphReader, TaskId, TaskNode } from './types.ts'

/** One task during the fold: its contract, the goal it was created under, and its children. */
interface FoldedTask {
  contract: TaskContract
  goal: GoalRef | undefined
  readonly children: TaskId[]
}

/** Every descendant of one task, breadth-first, read from the built index. */
function descendantsOf(byId: ReadonlyMap<TaskId, TaskNode>, root: TaskId): TaskId[] {
  const walked: TaskId[] = []
  const pending: TaskId[] = [...(byId.get(root)?.children ?? [])]
  for (let index = 0; index < pending.length; index += 1) {
    const next = pending[index]
    /* v8 ignore next -- the walk only reads positions it has already pushed */
    if (next === undefined) continue
    walked.push(next)
    pending.push(...(byId.get(next)?.children ?? []))
  }
  return walked
}

/**
 * Fold a session event sequence into the task graph it records.
 * @param events - the session's events, in log order.
 * @returns the graph; it holds no node when the log records no `task/created`.
 */
export function readTaskGraph(events: Iterable<SessionEvent>): TaskGraph {
  const tasks = new Map<TaskId, FoldedTask>()
  let goal: GoalRef | undefined
  for (const event of events) {
    switch (event.type) {
      case 'goal/change':
        goal = event.data.operation === 'clear'
          ? undefined
          : { id: event.data.goal.id, revision: event.data.goal.revision }
        break
      case 'task/created': {
        const { metadata: _metadata, ...recorded } = event.data
        void _metadata
        const contract: RecordedTaskContract = recorded
        const folded: FoldedTask = {
          contract: {
            ...contract,
            dependencies: contract.dependencies ?? [],
            evidence: contract.evidence ?? [],
          },
          goal,
          children: [],
        }
        tasks.set(folded.contract.taskId, folded)
        const parentTaskId = folded.contract.parentTaskId
        if (parentTaskId !== undefined) tasks.get(parentTaskId)?.children.push(folded.contract.taskId)
        break
      }
      case 'task/transitioned': {
        const folded = tasks.get(event.data.taskId)
        if (folded !== undefined) folded.contract = applyTransition(folded.contract, event.data)
        break
      }
      default:
        break
    }
  }
  const nodes: TaskNode[] = []
  // `tasks` preserves insertion order, so the nodes follow creation order.
  for (const folded of tasks.values()) {
    const { contract } = folded
    nodes.push({
      taskId: contract.taskId,
      runId: contract.runId,
      objective: contract.objective,
      ...contract.parentTaskId === undefined ? {} : { parentTaskId: contract.parentTaskId },
      dependencies: [...contract.dependencies],
      children: [...folded.children],
      status: contract.status,
      state: SPEC_STATE_BY_STATUS[contract.status],
      revision: contract.revision,
      ...folded.goal === undefined ? {} : { goal: folded.goal },
    })
  }
  const byId = new Map(nodes.map(node => [node.taskId, node]))
  return {
    nodes,
    nodeOf: taskId => byId.get(taskId),
    childrenOf: taskId => byId.get(taskId)?.children ?? [],
    dependenciesOf: taskId => byId.get(taskId)?.dependencies ?? [],
    descendantsOf: taskId => descendantsOf(byId, taskId),
  }
}

/**
 * The task-graph read model over session logs. It holds no cursor and no
 * derived state: every read folds the log it is given.
 */
export class KernelTaskGraph implements TaskGraphReader {
  /**
   * Fold one session's log into its task graph.
   * @param session - the session whose task and goal events are folded.
   * @returns the graph the log records.
   */
  graphOf(session: Session): TaskGraph {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    return readTaskGraph(session.snapshotEvents())
  }
}
