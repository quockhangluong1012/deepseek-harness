/**
 * §17.2 crash recovery: a boot-time scanner over every persisted session,
 * classifying each non-terminal task as resumable, repairable, or blocked —
 * never inferring completion from a missing tail. A task already in a
 * terminal status needs no recovery decision and is excluded.
 * @module @deepseek-ai/dsh-agent-kernel/recovery-scan
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { readKernelRecord } from './ledger.ts'
import type { RecoveryScanEntry, TaskStatus } from './types.ts'

/** Statuses a task never leaves; a session recording one needs no recovery decision. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled'])


/** Whether the log tail has an open turn/action or an unsatisfied checkpoint decision. */
function recoveryIssue(events: Iterable<SessionEvent>, openActionCount: number): 'open-turn' | 'open-action' | 'checkpoint-required' | undefined {
  let openTurn = false
  let checkpointRequired = false
  for (const event of events) {
    if (event.type === 'turn/start') openTurn = true
    else if (event.type === 'turn/end') openTurn = false
    else if (event.type === 'recovery/decided' && event.data.checkpointRequired) checkpointRequired = true
    else if (event.type === 'checkpoint/created') checkpointRequired = false
  }
  if (openTurn) return 'open-turn'
  if (openActionCount > 0) return 'open-action'
  if (checkpointRequired) return 'checkpoint-required'
  return undefined
}

/**
 * Scan every session this process's persistence backend can see and
 * classify the non-terminal ones for recovery. A session already in a
 * terminal status, or one with no task at all, is excluded — there is
 * nothing to recover.
 * @param persistence - the mounted session-persistence backend.
 * @returns one entry per non-terminal or unreadable session, in listing order.
 */
export async function scanForRecovery(persistence: SessionPersistence): Promise<readonly RecoveryScanEntry[]> {
  const snapshots = await persistence.list()
  const entries: RecoveryScanEntry[] = []
  for (const snapshot of snapshots) {
    const sessionId = snapshot.header.id
    let handle
    try {
      handle = await persistence.open(sessionId, 'read')
    } catch (error) {
      entries.push({ sessionId, classification: 'blocked', reason: `could not open the session: ${errorMessage(error)}` })
      continue
    }
    try {
      const { events } = await handle.read()
      const record = readKernelRecord(events)
      if (record === undefined) continue
      if (TERMINAL_TASK_STATUSES.has(record.task.status)) continue
      const issue = recoveryIssue(events, record.openActionIds.length)
      if (issue !== undefined) {
        entries.push({
          sessionId,
          classification: 'repairable',
          status: record.task.status,
          reason: issue === 'open-turn'
            ? `status '${record.task.status}' with an unterminated turn`
            : issue === 'open-action'
              ? `status '${record.task.status}' with ${record.openActionIds.length} open action${record.openActionIds.length === 1 ? '' : 's'}`
              : `status '${record.task.status}' with a retry awaiting checkpoint`,
        })
      } else {
        entries.push({
          sessionId,
          classification: 'resumable',
          status: record.task.status,
          reason: `status '${record.task.status}' with no open turn`,
        })
      }
    } catch (error) {
      entries.push({ sessionId, classification: 'blocked', reason: `could not read the session: ${errorMessage(error)}` })
    } finally {
      await handle.close()
    }
  }
  return entries
}

/** Render any thrown value as a message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
