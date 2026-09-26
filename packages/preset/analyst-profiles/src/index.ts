/**
 * Named analyst answer contracts. Consumers resolve a profile by id, pass its
 * `outputSchema` to a delegation, and validate the returned artifact with the
 * same id, so the mentor loop's advocate stage and the research loop's
 * contradiction step share one contract instead of a prompt convention.
 * @module @deepseek-ai/dsh-analyst-profiles
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { AnalystProfile, ProfileVerdict } from './types.ts'
import { getProfile, profileOutputSchema, profiles } from './profiles.ts'
import { validateProfileArtifact } from './validate.ts'

export * from './profiles.ts'
export * from './types.ts'
export * from './validate.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    analystProfiles: AnalystProfiles
  }
}

/** Directory of the analyst profiles one deployment can install as presets. */
export class AnalystProfiles extends Service {
  constructor(ctx: Context) {
    super(ctx, 'analystProfiles')
  }

  /** Read every declared profile id.
   * @returns The ids `get`, `outputSchema`, and `validate` accept.
   */
  list(): readonly string[] {
    return profiles.map(profile => profile.id)
  }

  /** Resolve one profile by id.
   * @param id - profile id to resolve.
   * @returns The declared contract.
   * @throws When no profile declares that id, naming the declared ids.
   */
  get(id: string): AnalystProfile {
    return getProfile(id)
  }

  /** Read one profile's structured-output schema, to pass as a delegation's `outputSchema`.
   * @param id - profile id to resolve.
   * @returns An object-rooted schema enumerating the profile id, headings, and claim bases.
   */
  outputSchema(id: string): ObjectJsonSchema {
    return profileOutputSchema(getProfile(id))
  }

  /** Validate one produced artifact against a profile's section contract.
   * @param id - profile id the artifact must name and satisfy.
   * @param artifact - the parsed answer from the run that produced it.
   * @returns `{ ok: true }`, or every contract the artifact broke.
   */
  validate(id: string, artifact: unknown): ProfileVerdict {
    return validateProfileArtifact(getProfile(id), artifact)
  }
}

export default AnalystProfiles
