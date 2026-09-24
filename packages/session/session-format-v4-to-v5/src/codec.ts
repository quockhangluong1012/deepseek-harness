/** V5 header framing with V4 physical event rows. */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatEvent,
  SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { assertReleasedV5Header } from './validation.ts'

function physicalV5(value: unknown): SessionFormatHeader {
  if (!isSessionFormatJsonObject(value) || value['version'] !== 5) {
    throw new SessionFormatError('expected format v5 physical header')
  }
  return { ...value, version: 4 } as SessionFormatHeader
}

/**
 * V5 keeps V4's physical rows and changes only the canonical header version.
 */
export const releasedV5SessionFormatCodec = Object.freeze({
  version: 5,
  decodeHeader(value) {
    return { ...releasedV4SessionFormatCodec.decodeHeader(physicalV5(value)), version: 5 }
  },
  createDecoder(value, recovery) {
    const decoder = releasedV4SessionFormatCodec.createDecoder(physicalV5(value), recovery)
    return {
      ...decoder,
      header: { ...decoder.header, version: 5 },
      decodeRow(row, context) {
        decoder.decodeRow(row, context)
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV5Header(header)
    return {
      ...releasedV4SessionFormatCodec.encodeHeader({ ...header, version: 4 }, inheritedEventCount),
      version: 5,
    }
  },
  encodeEvent(event: SessionFormatEvent) {
    return releasedV4SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)
