/** Native V6 header validation and the V6 event admission delta. */

import { SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV5Header, restoreReleasedV5Artifact } from '@deepseek-ai/dsh-session-format-v4-to-v5'

/**
 * Validate a V6 header with the unchanged V5 fields and the V6 version discriminator.
 * @param header - decoded or untrusted V6 Session header candidate.
 * @throws When the header does not satisfy the V6 format.
 */
export function assertReleasedV6Header(header: unknown): void {
  if (!isSessionFormatJsonObject(header) || header['version'] !== 6) {
    throw new SessionFormatError('expected format v6 header')
  }
  assertReleasedV5Header({ ...header, version: 5 })
}

/** V6 source attributions that no longer exist in the V6 Message source union. */
const REMOVED_SOURCE_KIND = 'workspace-memory-llm'

/** Members V6 requires on a payload, per event type. */
const REQUIRED_DATA_MEMBERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'budget/exceeded': ['ceilings', 'scope'],
  'task/created': ['dependencies', 'evidence'],
  'task/transitioned': ['evidence'],
  'verification/requested': ['repositoryDigest'],
})

/** Subject naming one source event and its sequence. */
function subject(event: SessionFormatEvent): string {
  return `format v5 ${event.type} at seq ${String(event.seq)}`
}

/**
 * Read every durable Message slot the shared source attribution can occupy.
 * @param event - source or target logical event.
 * @returns the slot objects, empty for events without message payloads.
 */
function messageSlots(event: SessionFormatEvent): readonly SessionFormatJsonObject[] {
  const data = event.data
  if (!isSessionFormatJsonObject(data)) return []
  if (event.type === 'user/message') return [data]
  if (event.type === 'developer/message') {
    return isSessionFormatJsonObject(data['message']) ? [data['message']] : []
  }
  if (event.type === 'session/title-llm-request') {
    return Array.isArray(data['messages']) ? data['messages'] as SessionFormatJsonObject[] : []
  }
  if (event.type === 'agent/inbox/spliced') {
    return Array.isArray(data['inserted']) ? data['inserted'] as SessionFormatJsonObject[] : []
  }
  return []
}
/**
 * Report the first source attribution that V6 removed from the Message source union.
 * @param event - source or target logical event.
 * @returns the offending event type, or undefined when every attribution survives.
 */
export function removedV6SourceKind(event: SessionFormatEvent): string | undefined {
  for (const slot of messageSlots(event)) {
    const source = slot['source']
    if (isSessionFormatJsonObject(source) && source['kind'] === REMOVED_SOURCE_KIND) return event.type
  }
  return undefined
}

/** Members this edge cannot synthesize from a V5 record. */
function missingRequiredMember(event: SessionFormatEvent, data: SessionFormatJsonObject): string | undefined {
  for (const member of REQUIRED_DATA_MEMBERS[event.type] ?? []) {
    if (!Object.hasOwn(data, member)) return `data.${member}`
  }
  if (event.type === 'hypothesis/updated' && Array.isArray(data['tests'])) {
    const tests = data['tests'] as readonly unknown[]
    for (const [index, test] of tests.entries()) {
      if (isSessionFormatJsonObject(test) && !Object.hasOwn(test, 'repositoryDigest')) {
        return `data.tests[${index}].repositoryDigest`
      }
    }
  }
  return undefined
}

/**
 * Refuse a V5 event that has no implemented, evidenced V6 mapping.
 *
 * Every refusal names its event type and the absent or removed member; none of
 * them synthesize a repository digest, an evidence list, or a replacement
 * attribution for a source kind V6 no longer admits.
 * @param event - converted V5 event about to become a V6 event.
 * @throws When a member V6 requires cannot come from the V5 record.
 */
export function assertV6ConvertibleEvent(event: SessionFormatEvent): void {
  const removed = removedV6SourceKind(event)
  if (removed !== undefined) {
    throw new SessionFormatUnsupportedMigrationError(
      `${subject(event)} carries the source kind "${REMOVED_SOURCE_KIND}" that format v6 no longer admits`,
    )
  }
  const data = event.data
  if (!isSessionFormatJsonObject(data)) return
  const missing = missingRequiredMember(event, data)
  if (missing !== undefined) {
    throw new SessionFormatUnsupportedMigrationError(
      `${subject(event)} lacks ${missing}, which format v6 requires and this edge cannot synthesize`,
    )
  }
}

/**
 * Admit one native V6 event: the renamed attribution is present and no
 * unreachable V5 member survived.
 * @param event - complete native V6 event.
 * @throws When the event still carries a V5-only member or omits a V6 requirement.
 */
export function assertReleasedV6Event(event: SessionFormatEvent): void {
  const data = event.data
  if (isSessionFormatJsonObject(data)) {
    const metadata = data['metadata']
    if (isSessionFormatJsonObject(metadata) && Object.hasOwn(metadata, 'provenance')) {
      throw new SessionFormatError(`${subject(event)} still carries data.metadata.provenance`)
    }
    if (event.type === 'evidence/recorded' && Object.hasOwn(data, 'provenance')) {
      throw new SessionFormatError(`${subject(event)} still carries data.provenance`)
    }
    const missing = missingRequiredMember(event, data)
    if (missing !== undefined) {
      throw new SessionFormatError(`${subject(event)} lacks ${missing}`)
    }
  }
  const removed = removedV6SourceKind(event)
  if (removed !== undefined) {
    throw new SessionFormatError(`${subject(event)} carries the removed source kind "${REMOVED_SOURCE_KIND}"`)
  }
}

/**
 * Validate V6 event admission, then reuse V5's unchanged vocabulary and relationship rules.
 * @param artifact - complete detached V6 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same artifact after validation.
 */
export function restoreReleasedV6Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV6Header(artifact.header)
  for (const event of artifact.events) assertReleasedV6Event(event)
  restoreReleasedV5Artifact({
    ...artifact,
    header: { ...artifact.header, version: 5 },
  }, knownEventTypes)
  return artifact
}
