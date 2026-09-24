/** Native V5 header and artifact validation. */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'

/**
 * Validate a V5 header with the V4 fields and V5 version discriminator.
 * @param header - decoded or untrusted V5 header candidate.
 * @throws When the header does not satisfy the V5 format.
 */
export function assertReleasedV5Header(header: unknown): void {
  if (!isSessionFormatJsonObject(header) || header['version'] !== 5) {
    throw new SessionFormatError('expected format v5 header')
  }
  assertReleasedV4Header({ ...header, version: 4 })
}

/**
 * Validate V5 metadata and reuse V4's unchanged event and relationship rules.
 * @param artifact - complete detached V5 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same artifact after validation.
 */
export function restoreReleasedV5Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV5Header(artifact.header)
  restoreReleasedV4Artifact({
    ...artifact,
    header: { ...artifact.header, version: 4 },
  }, knownEventTypes)
  return artifact
}
