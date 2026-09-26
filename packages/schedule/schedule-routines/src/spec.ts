/**
 * The `workspace_routines` domain declaration: one `state` document holding the
 * whole routine list. Routines are deployment-level definitions — they outlive
 * any Session — so they are one atomic document rather than session events.
 *
 * The document is authoritative: a routine that exists is a routine the user
 * asked for, so a schema failure backs the document aside and starts empty
 * rather than failing the boot, exactly as the usage ledger does.
 * @module @deepseek-ai/dsh-schedule-routines/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** One durable routine record as stored at the boundary. */
export const routineRecord = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  workspacePath: z.string().min(1),
  prompt: z.string().min(1),
  agentPreset: z.string().min(1),
  permissionPreset: z.string().min(1),
  everyMinutes: z.number().int().positive(),
  enabled: z.boolean(),
  createdAt: z.string().min(1),
  lastFiredAt: z.string().min(1).nullable(),
  nextDueAt: z.string().min(1),
})

/** The complete routine state document. */
export const routinesState = z.object({ routines: z.array(routineRecord) })

/** The routine state, inferred from {@link routinesState}. */
export type RoutinesState = z.infer<typeof routinesState>

/** The single routine-table key holding the whole state document. */
export const ROUTINES_KEY = 'state'

/** Empty routine state. */
export const EMPTY_ROUTINES: RoutinesState = { routines: [] }

/** The routine domain spec: one atomic document, corruption skips rather than fails. */
export const workspaceRoutinesDomainSpec = defineDomain({
  name: 'workspace_routines',
  version: 1,
  invalidRecords: 'backup-and-skip',
  layout: 'single',
  tables: { routines: domainTable<string, RoutinesState>(routinesState) },
})
