/** Convert released V5 events into the V6 writer shape without inventing evidence. */

import {
  defineSessionFormatMigration,
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
  isSessionFormatJsonObject,
  sessionFormatCount,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
  SessionFormatMigration,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@deepseek-ai/dsh-session-format'
import { assertReleasedV5Header } from '@deepseek-ai/dsh-session-format-v4-to-v5'
import { assertReleasedV6Header, assertV6ConvertibleEvent } from './validation.ts'

/** Header-only V5-to-V6 migration; the body stage renames attribution and refuses unmapped events. */
export const sessionFormatV5ToV6: SessionFormatMigration = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v5-to-v6',
  fromVersion: 5,
  toVersion: 6,
  migrateHeader(header) {
    assertReleasedV5Header(header)
    return { ...header, version: 6 }
  },
  createStage(input) {
    return new V5ToV6Stage(input)
  },
  validateTargetHeader: assertReleasedV6Header,
})

/**
 * Move one `{ source, locator?, digest? }` attribution to its V6 member name.
 * @param owner - source object carrying the legacy `provenance` member.
 * @param path - dotted payload path of that object, named by the collision diagnostic.
 * @param event - source event, named by the collision diagnostic.
 * @returns an object with the same members except the renamed attribution.
 * @throws When both the legacy and the V6 member are present.
 */
function renameProvenance(
  owner: SessionFormatJsonObject,
  path: string,
  event: SessionFormatEvent,
): SessionFormatJsonObject {
  if (Object.hasOwn(owner, 'sourceRef')) {
    throw new SessionFormatUnsupportedMigrationError(
      `format v5 ${event.type} at seq ${String(event.seq)} carries both ${path}.provenance and ${path}.sourceRef`,
    )
  }
  const { provenance, ...rest } = owner
  return { ...rest, sourceRef: provenance as SessionFormatJsonValue }
}

class V5ToV6Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private inheritedMarkerCut: number | undefined

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    if (!input.sourceHeader.isSeeded) this.headerInheritedEventCount = 0
    else if (input.sourceInheritedEventCount !== undefined) {
      this.headerInheritedEventCount = sessionFormatCount(input.sourceInheritedEventCount, 'format v5 inherited event count')
    }
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    const target = convertV5Event(event)
    if (target.type === 'session/end-seed' && isSessionFormatJsonObject(target.data) && target.data['inherited'] === true) {
      if (!this.input.sourceHeader.isSeeded) {
        throw new SessionFormatError('unseeded format v5 Session contains an inherited end-seed marker')
      }
      this.inheritedMarkerCut = sessionFormatCount(target.seq, 'format v5 inherited event count')
    }
    context.emitEvent(target)
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    for (const event of run.expand()) this.transformEvent(event, context)
  }

  finish(): number {
    const sourceCount = this.input.sourceInheritedEventCount
    if (!this.input.sourceHeader.isSeeded) {
      if (this.inheritedMarkerCut !== undefined || sourceCount !== undefined && sessionFormatCount(sourceCount, 'format v5 inherited event count') !== 0) {
        throw new SessionFormatError('unseeded format v5 Session has an inherited event cut')
      }
      return 0
    }

    const cut = sourceCount === undefined
      ? this.inheritedMarkerCut
      : sessionFormatCount(sourceCount, 'format v5 inherited event count')
    if (cut === undefined || this.inheritedMarkerCut !== cut) {
      throw new SessionFormatError('format v5 seeded Session header disagrees with its inherited end-seed marker')
    }
    return cut
  }
}

/**
 * Convert one V5 event, preserving its identity, coordinates, and opaque nested data.
 * @param event - one decoded or upstream-migrated V5 event.
 * @returns the V6 event, or the same object when no member changes.
 * @throws When the record has no implemented, evidenced V6 mapping.
 */
function convertV5Event(event: SessionFormatEvent): SessionFormatEvent {
  const data = event.data
  if (!isSessionFormatJsonObject(data)) {
    assertV6ConvertibleEvent(event)
    return event
  }
  let converted = data
  const metadata = converted['metadata']
  if (isSessionFormatJsonObject(metadata) && Object.hasOwn(metadata, 'provenance')) {
    converted = { ...converted, metadata: renameProvenance(metadata, 'data.metadata', event) }
  }
  if (event.type === 'evidence/recorded' && Object.hasOwn(converted, 'provenance')) {
    converted = renameProvenance(converted, 'data', event)
  }
  const target = converted === data ? event : { ...event, data: converted }
  assertV6ConvertibleEvent(target)
  return target
}
