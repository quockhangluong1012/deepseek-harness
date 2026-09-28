/** V6 header framing with V5 physical event rows. */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatEvent,
  SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import { releasedV5SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v4-to-v5'
import { assertReleasedV6Header } from './validation.ts'

function physicalV6(value: unknown): SessionFormatHeader {
  if (!isSessionFormatJsonObject(value) || value['version'] !== 6) {
    throw new SessionFormatError('expected format v6 physical header')
  }
  return { ...value, version: 5 } as SessionFormatHeader
}

/**
 * V6 keeps V5's physical rows and changes only the canonical header version.
 */
export const releasedV6SessionFormatCodec = Object.freeze({
  version: 6,
  decodeHeader(value) {
    return { ...releasedV5SessionFormatCodec.decodeHeader(physicalV6(value)), version: 6 }
  },
  createDecoder(value, recovery) {
    const decoder = releasedV5SessionFormatCodec.createDecoder(physicalV6(value), recovery)
    return {
      ...decoder,
      header: { ...decoder.header, version: 6 },
      decodeRow(row, context) {
        decoder.decodeRow(row, context)
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV6Header(header)
    return {
      ...releasedV5SessionFormatCodec.encodeHeader({ ...header, version: 5 }, inheritedEventCount),
      version: 6,
    }
  },
  encodeEvent(event: SessionFormatEvent) {
    return releasedV5SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)
