/** Preserve V4 events while advancing the Session header to V5. */

import {
  defineSessionFormatMigration,
  SessionFormatError,
  isSessionFormatJsonObject,
  sessionFormatCount,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatMigration,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { assertReleasedV5Header } from './validation.ts'

/** Header-only V4-to-V5 migration; the body stage preserves events and cuts. */
export const sessionFormatV4ToV5: SessionFormatMigration = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v4-to-v5',
  fromVersion: 4,
  toVersion: 5,
  migrateHeader(header) {
    assertReleasedV4Header(header)
    return { ...header, version: 5 }
  },
  createStage(input) {
    return new V4ToV5Stage(input)
  },
  validateTargetHeader: assertReleasedV5Header,
})

class V4ToV5Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private inheritedMarkerCut: number | undefined

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    if (!input.sourceHeader.isSeeded) this.headerInheritedEventCount = 0
    else if (input.sourceInheritedEventCount !== undefined) {
      this.headerInheritedEventCount = sessionFormatCount(input.sourceInheritedEventCount, 'format v4 inherited event count')
    }
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data) && event.data['inherited'] === true) {
      if (!this.input.sourceHeader.isSeeded) {
        throw new SessionFormatError('unseeded format v4 Session contains an inherited end-seed marker')
      }
      this.inheritedMarkerCut = sessionFormatCount(event.seq, 'format v4 inherited event count')
    }
    context.emitEvent(event)
  }

  transformRun(run: Parameters<SessionFormatMigrationStage['transformRun']>[0], context: SessionFormatMigrationContext): void {
    context.emitRun(run)
  }

  finish(): number {
    const sourceCount = this.input.sourceInheritedEventCount
    if (!this.input.sourceHeader.isSeeded) {
      if (this.inheritedMarkerCut !== undefined || sourceCount !== undefined && sessionFormatCount(sourceCount, 'format v4 inherited event count') !== 0) {
        throw new SessionFormatError('unseeded format v4 Session has an inherited event cut')
      }
      return 0
    }

    const cut = sourceCount === undefined
      ? this.inheritedMarkerCut
      : sessionFormatCount(sourceCount, 'format v4 inherited event count')
    if (cut === undefined || this.inheritedMarkerCut !== cut) {
      throw new SessionFormatError('format v4 seeded Session header disagrees with its inherited end-seed marker')
    }
    return cut
  }
}
