/**
 * Durable per-scope evolution memory store (`ctx.evolutionMemory`): the
 * user-authored instructions, the model-maintained lesson artifacts and
 * profile document with provenance and per-family stamps, attached text and
 * file context items, the produced-file index, staged writes awaiting
 * approval, and the newest-first log of decided staged entries, over the
 * `evolution_memory` domain.
 *
 * Lesson artifacts are addressed by identity, which is their normalized
 * statement: `addArtifact`, `updateArtifact`, and `removeArtifact` each name
 * the artifact they act on, and an artifact's identity never changes.
 * `replaceArtifacts` is the document-level counterpart, used by the markdown
 * extraction pipeline until that pipeline emits per-candidate ops. Under
 * `overwrite` or `merge`, `addArtifact` folds a candidate into the artifact it
 * most resembles when an embeddings service is mounted; that seam is optional,
 * so without it only an exact identity matches and a paraphrase is stored as
 * an artifact of its own.
 *
 * Reads are synchronous from the domain's validated memory. Every cap is
 * checked before the write chain is entered, and a rejected write never
 * mutates the record. Stored objects never leak by reference.
 * @module @deepseek-ai/dsh-evolution-memory
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { artifactBytesOf, digestOf, usedBytesOf, utf8Bytes } from './digest.ts'
import { artifactKey, lessonArtifactInput } from './lesson-artifact.ts'
import type { LessonArtifact, LessonArtifactInput, LessonArtifactPatch, LessonMergeStrategy } from './lesson-artifact.ts'
import { cosineSimilarity, mergeArtifact, pickMergeTarget } from './merge.ts'
import { evolutionExtraction, evolutionMemoryDomainSpec, stagedWritePayload } from './spec.ts'
import type {
  EvolutionContextItem,
  EvolutionContextItemInput,
  EvolutionExtraction,
  EvolutionMemoryRecord,
  EvolutionMemoryUsage,
  EvolutionOutput,
  EvolutionScopeId as EvolutionScopeIdBrand,
  StagedResolution,
  StagedWrite,
  StagedWriteInput,
} from './types.ts'

export type {
  EvolutionContextItem,
  EvolutionContextItemInput,
  EvolutionExtraction,
  EvolutionMemoryRecord,
  EvolutionMemoryUsage,
  EvolutionOutput,
  MemoryStagedAddArtifactPayload,
  MemoryStagedRemoveArtifactPayload,
  MemoryStagedReplaceArtifactsPayload,
  MemoryStagedTextPayload,
  MemoryStagedUpdateArtifactPayload,
  StagedResolution,
  StagedWrite,
  StagedWriteInput,
} from './types.ts'
export { evolutionMemoryDomainSpec } from './spec.ts'
export { digestOf, usedBytesOf, EMPTY_DIGEST, truncateUtf8, utf8Bytes, artifactBytesOf } from './digest.ts'
export { artifactKey, lessonArtifact, lessonArtifactInput, normalizeStatement, wrapLegacyLessons } from './lesson-artifact.ts'
export { cosineSimilarity, mergeArtifact, pickMergeTarget } from './merge.ts'
export type {
  LessonArtifact,
  LessonArtifactInput,
  LessonArtifactPatch,
  LessonArtifactScope,
  LessonEvidenceKind,
  LessonMergeStrategy,
} from './lesson-artifact.ts'

/**
 * Label prefix marking context the reviewer recalled from session history
 * rather than the user attaching it. Writers label recalled items with it and
 * consumers order them last, so a recalled item is the first context material
 * a brief drops under its byte budget.
 */
export const RECALL_LABEL_PREFIX = 'Recall: '

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable per-scope evolution memory record owner. */
    evolutionMemory: EvolutionMemoryStore
  }
}

/** Identifies one evolution scope (see `src/types.ts` for the brand rationale). */
export type EvolutionScopeId = EvolutionScopeIdBrand

/**
 * Build the opaque scope identity for one scope: `profile:workspaceId`, or
 * `profile:global` for the profile-wide record. Use {@link storageKey} for
 * the path-safe record key handed to the domain.
 * @param profile - owning profile name; non-empty and free of `:`.
 * @param workspaceId - workspace key within the profile; omit for the global record.
 * @returns the opaque scope identity.
 */
export function EvolutionScopeId(profile: string, workspaceId?: string): EvolutionScopeId {
  if (profile.length === 0) throw new Error('evolution-memory: profile must be non-empty')
  if (profile.includes(':')) throw new Error(`evolution-memory: profile must not contain ':', got ${JSON.stringify(profile)}`)
  const scope = workspaceId ?? 'global'
  if (scope.length === 0) throw new Error('evolution-memory: workspace scope must be non-empty')
  if (scope.includes(':')) throw new Error(`evolution-memory: workspace scope must not contain ':', got ${JSON.stringify(scope)}`)
  return `${profile}:${scope}` as EvolutionScopeId
}

/** Record keys become path segments in the JSON backend; this set is path-safe on every OS. */
const STORAGE_KEY_RE = /^[a-zA-Z0-9_-]+$/

/**
 * Internal file encoding for one scope: `<profile>--<workspaceId>` or
 * `<profile>--global`. The external identity stays the opaque
 * `profile:workspaceId` key because `:` is unambiguous when profiles and
 * scopes never contain it; the JSON backend forbids `:` in per-record keys,
 * so the store never hands the opaque key to the domain.
 * @param id - opaque scope identity.
 * @returns the path-safe record key used as the domain table key.
 */
export function storageKey(id: EvolutionScopeId): string {
  const raw = String(id)
  const separator = raw.indexOf(':')
  if (separator === -1) throw new Error(`evolution-memory: scope identity '${raw}' is missing ':'`)
  const key = `${raw.slice(0, separator)}--${raw.slice(separator + 1)}`
  if (!STORAGE_KEY_RE.test(key)) {
    throw new Error(`evolution-memory: scope '${raw}' is not path-safe as '${key}' (must match ${STORAGE_KEY_RE})`)
  }
  return key
}

/**
 * Decode one storage key back to its opaque scope identity, splitting on the
 * last `--` so profiles containing `--` still round-trip (workspace keys are
 * UUIDs without `--`, and the global record ends in `--global`).
 * @param key - path-safe record key.
 * @returns the opaque scope identity.
 */
export function scopeIdFromStorageKey(key: string): EvolutionScopeId {
  const separator = key.lastIndexOf('--')
  if (separator === -1) throw new Error(`evolution-memory: storage key '${key}' is missing '--'`)
  return `${key.slice(0, separator)}:${key.slice(separator + 2)}` as EvolutionScopeId
}

/** Deployment-chosen caps for stored evolution memory. */
export interface Config {
  /** Capacity-bar denominator and hard ceiling on stored bytes. */
  capacityBytes: number
  /** Lessons cap: UTF-8 bytes of the serialized artifact array. */
  maxAgentBytes?: number
  /** User profile document cap in UTF-8 bytes. */
  maxUserBytes?: number
  /** Per-item cap in UTF-8 bytes, and ceiling on a file item's observed size. */
  maxContextItemBytes?: number
  /** Item count cap. */
  maxContextItems?: number
  /** Produced-file index size. */
  maxOutputs?: number
  /** Decided staged entries retained per scope. */
  maxResolutions?: number
  /** Minimum similarity to an existing artifact that justifies merging instead of storing separately. */
  mergeSimilarityFloor?: number
}

/** Capacity-bar denominator and hard ceiling on stored bytes. */
const capacityBytesField = z.number().step(1).min(1).required()

/** Lessons cap: UTF-8 bytes of the serialized artifact array. */
const maxAgentBytesField = z.number().step(1).min(1).default(65536)

/** User profile document cap in UTF-8 bytes. */
const maxUserBytesField = z.number().step(1).min(1).default(32768)

/** Per-item cap in UTF-8 bytes, and ceiling on a file item's observed size. */
const maxContextItemBytesField = z.number().step(1).min(1).default(262144)

/** Item count cap. */
const maxContextItemsField = z.number().step(1).min(1).default(50)

/** Produced-file index size. */
const maxOutputsField = z.number().step(1).min(1).default(200)

/** Decided staged entries retained per scope. */
const maxResolutionsField = z.number().step(1).min(1).default(200)

/** Similarity floor for merging a candidate into an existing artifact. */
const mergeSimilarityFloorField = z.number().min(0).max(1).default(0.87)

/** Validated deployment choices; `capacityBytes` is required. */
export const Config: z<Config> = z.object({
  capacityBytes: capacityBytesField,
  maxAgentBytes: maxAgentBytesField,
  maxUserBytes: maxUserBytesField,
  maxContextItemBytes: maxContextItemBytesField,
  maxContextItems: maxContextItemsField,
  maxOutputs: maxOutputsField,
  maxResolutions: maxResolutionsField,
  mergeSimilarityFloor: mergeSimilarityFloorField,
})

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  capacityBytes: number
  maxAgentBytes: number
  maxUserBytes: number
  maxContextItemBytes: number
  maxContextItems: number
  maxOutputs: number
  maxResolutions: number
  mergeSimilarityFloor: number
}

/**
 * Resolve defaults for optional caps.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const {
    capacityBytes,
    maxAgentBytes = 65536,
    maxUserBytes = 32768,
    maxContextItemBytes = 262144,
    maxContextItems = 50,
    maxOutputs = 200,
    maxResolutions = 200,
    mergeSimilarityFloor = 0.87,
  } = config
  return {
    capacityBytes,
    maxAgentBytes,
    maxUserBytes,
    maxContextItemBytes,
    maxContextItems,
    maxOutputs,
    maxResolutions,
    mergeSimilarityFloor,
  }
}

function freshRecord(): Omit<EvolutionMemoryRecord, 'updatedAt'> & { updatedAt?: string } {
  return {
    instructions: '',
    agentLessons: [],
    userProfile: '',
    instructionsUpdatedAt: null,
    lessonsUpdatedAt: null,
    profileUpdatedAt: null,
    memoryUpdatedAt: null,
    contextItems: [],
    outputs: [],
    lastExtraction: null,
    staged: [],
    resolutions: [],
  }
}

/** Fields a stamped write may touch; each family stamps only its own instant. */
type MemoryFamily = 'instructions' | 'lessons' | 'profile'

/**
 * Derive the release-compatible `memoryUpdatedAt` from the per-family stamps.
 * @param record - candidate record carrying both family stamps.
 * @returns the later lessons or profile stamp, or null when neither exists.
 */
function memoryUpdatedAtOf(
  record: Pick<EvolutionMemoryRecord, 'lessonsUpdatedAt' | 'profileUpdatedAt'>,
): string | null {
  const { lessonsUpdatedAt, profileUpdatedAt } = record
  if (lessonsUpdatedAt === null) return profileUpdatedAt
  if (profileUpdatedAt === null) return lessonsUpdatedAt
  return lessonsUpdatedAt > profileUpdatedAt ? lessonsUpdatedAt : profileUpdatedAt
}

/**
 * Stamp one memory family on a candidate record and keep the derived
 * aggregate current. Other families keep their own stamps untouched.
 * @param record - candidate record without the stamp.
 * @param family - the family the write changed.
 * @param at - ISO-8601 instant of the write.
 * @returns the record with that family's stamp and the derived aggregate.
 */
function stampFamily(record: EvolutionMemoryRecord, family: MemoryFamily, at: string): EvolutionMemoryRecord {
  if (family === 'instructions') return { ...record, instructionsUpdatedAt: at }
  const stamped = family === 'lessons' ? { ...record, lessonsUpdatedAt: at } : { ...record, profileUpdatedAt: at }
  return { ...stamped, memoryUpdatedAt: memoryUpdatedAtOf(stamped) }
}

/**
 * Prepend one decision to the resolution log and enforce its cap.
 * @param existing - the record's resolutions, newest first.
 * @param entry - the decided staged entry.
 * @param decision - what the decision was.
 * @param at - ISO-8601 instant of the decision.
 * @param maxResolutions - retained-entry cap.
 * @returns the new resolution log, newest first.
 */
function withResolution(
  existing: readonly StagedResolution[],
  entry: StagedWrite,
  decision: 'approved' | 'rejected',
  at: string,
  maxResolutions: number,
): StagedResolution[] {
  const resolution: StagedResolution = {
    id: entry.id,
    kind: entry.kind,
    op: entry.op,
    gist: entry.gist,
    decision,
    at,
    originSessionId: entry.originSessionId,
  }
  return [resolution, ...existing].slice(0, maxResolutions)
}

function tooLarge(field: string, bytes: number, maxBytes: number): RemoteError<'evolution/too-large'> {
  return new RemoteError(
    'evolution/too-large',
    `evolution memory field '${field}' is ${bytes} bytes, exceeding the ${maxBytes} byte cap`,
    { field, bytes, maxBytes },
  )
}

function capacityExceeded(usedBytes: number, capacityBytes: number): RemoteError<'evolution/capacity-exceeded'> {
  return new RemoteError(
    'evolution/capacity-exceeded',
    `evolution memory write would use ${usedBytes} of ${capacityBytes} bytes`,
    { usedBytes, capacityBytes },
  )
}

function itemNotFound(itemId: string): RemoteError<'evolution/item-not-found'> {
  return new RemoteError('evolution/item-not-found', `no evolution memory item '${itemId}'`, { itemId })
}

function stagedNotFound(stagedId: string): RemoteError<'evolution/staged-not-found'> {
  return new RemoteError('evolution/staged-not-found', `no staged evolution write '${stagedId}'`, { stagedId })
}

function checkCapacity(record: EvolutionMemoryRecord, capacityBytes: number): void {
  const used = usedBytesOf(record)
  if (used > capacityBytes) throw capacityExceeded(used, capacityBytes)
}

/**
 * Measure one context item against the per-item cap.
 * @param input - caller-supplied label plus text or observed file size.
 * @param resolved - normalized caps.
 * @returns the bytes the item charges against capacity.
 */
function contextItemSize(input: EvolutionContextItemInput, resolved: ResolvedConfig): number {
  const sizeBytes = input.kind === 'text' ? utf8Bytes(input.text) : input.sizeBytes
  if (sizeBytes > resolved.maxContextItemBytes) {
    throw tooLarge('contextItem', sizeBytes, resolved.maxContextItemBytes)
  }
  return sizeBytes
}

/**
 * Enforce both lessons caps on a candidate record: the serialized artifact
 * array against `maxAgentBytes`, then the whole record against the scope
 * capacity.
 * @param record - candidate record value, before the family stamp.
 * @param resolved - normalized caps.
 */
function checkArtifactCaps(record: EvolutionMemoryRecord, resolved: ResolvedConfig): void {
  const bytes = artifactBytesOf(record.agentLessons)
  if (bytes > resolved.maxAgentBytes) throw tooLarge('agentLessons', bytes, resolved.maxAgentBytes)
  checkCapacity(record, resolved.capacityBytes)
}

/**
 * Derive the identity a candidate stores under, refusing a statement that
 * normalizes away to nothing. An empty identity is not merely useless: it
 * would persist a record the artifact schema rejects, and the next open of the
 * domain would refuse the whole store.
 * @param candidate - validated caller-supplied artifact fields.
 * @returns the non-empty identity.
 */
function artifactIdOf(candidate: LessonArtifactInput): string {
  const id = artifactKey(candidate.statement)
  if (id.length === 0) {
    throw new Error(
      `evolution-memory: artifact statement ${JSON.stringify(candidate.statement)} is blank once normalized and cannot key an artifact`,
    )
  }
  return id
}

/**
 * Build one stored artifact from a validated candidate, assigning the fields
 * no caller supplies.
 * @param candidate - validated caller-supplied artifact fields.
 * @param id - identity the artifact stores under.
 * @param now - ISO-8601 instant to stamp as both instants.
 * @returns the artifact with its store-assigned identity, counters, and instants.
 */
function freshArtifact(candidate: LessonArtifactInput, id: string, now: string): LessonArtifact {
  return {
    ...structuredClone(candidate),
    id,
    validationCount: 0,
    refutationCount: 0,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Add one candidate to a record's artifacts. A candidate whose identity is
 * already present stores nothing under `keep_both`, because a second artifact
 * with the same identity cannot be told apart from the first; under any other
 * strategy the artifact `pickMergeTarget` selected absorbs the candidate. A
 * candidate with no selected target becomes its own artifact.
 * @param record - current record value.
 * @param candidate - validated caller-supplied artifact fields.
 * @param strategy - how the candidate folds into a selected artifact.
 * @param target - the artifact selected for this candidate outside the write
 * chain, where the similarity lookup can await; undefined when nothing
 * matched closely enough.
 * @param now - ISO-8601 instant to stamp.
 * @returns the candidate record without the family stamp, or `record` itself
 * when the add stores nothing.
 */
function addArtifactTo(
  record: EvolutionMemoryRecord,
  candidate: LessonArtifactInput,
  strategy: LessonMergeStrategy,
  target: LessonArtifact | undefined,
  now: string,
): EvolutionMemoryRecord {
  const id = artifactIdOf(candidate)
  if (target !== undefined) {
    const merged = mergeArtifact(target, candidate, strategy, now)
    return { ...record, agentLessons: record.agentLessons.map(artifact => artifact.id === target.id ? merged : artifact) }
  }
  if (record.agentLessons.some(artifact => artifact.id === id)) return record
  return { ...record, agentLessons: [...record.agentLessons, freshArtifact(candidate, id, now)] }
}

/**
 * Replace the whole artifact array from a candidate list, refusing an identity
 * that appears twice and a statement that normalizes away to nothing.
 * @param record - current record value.
 * @param candidates - validated caller-supplied artifact fields.
 * @param now - ISO-8601 instant to stamp as both instants.
 * @returns the candidate record without the family stamp.
 */
function replaceArtifactsIn(
  record: EvolutionMemoryRecord,
  candidates: readonly LessonArtifactInput[],
  now: string,
): EvolutionMemoryRecord {
  const seen = new Set<string>()
  const artifacts: LessonArtifact[] = []
  for (const candidate of candidates) {
    const id = artifactIdOf(candidate)
    if (seen.has(id)) {
      throw new Error(`evolution-memory: replacement artifact list repeats identity '${id}'`)
    }
    seen.add(id)
    artifacts.push(freshArtifact(candidate, id, now))
  }
  return { ...record, agentLessons: artifacts }
}

/**
 * Apply a patch to one existing artifact. Fields the patch omits keep their
 * stored value; identity, counters, statement, and the creation instant never
 * change. Identities are unique within a record, so this replaces exactly one
 * artifact.
 * @param record - current record value.
 * @param id - the addressed artifact.
 * @param patch - caller-supplied changes; absent fields are left alone.
 * @param now - ISO-8601 instant to stamp.
 * @returns the candidate record without the family stamp.
 */
function patchArtifactIn(
  record: EvolutionMemoryRecord,
  id: string,
  patch: object,
  now: string,
): EvolutionMemoryRecord {
  const existing = record.agentLessons.find(artifact => artifact.id === id)
  if (existing === undefined) throw itemNotFound(id)
  const merged = mergeArtifact(existing, { ...existing, ...patch }, 'overwrite', now)
  return { ...record, agentLessons: record.agentLessons.map(artifact => artifact.id === id ? merged : artifact) }
}

/**
 * Drop one existing artifact. Identities are unique within a record, so this
 * removes exactly one.
 * @param record - current record value.
 * @param id - the addressed artifact.
 * @returns the candidate record without the family stamp.
 */
function removeArtifactFrom(record: EvolutionMemoryRecord, id: string): EvolutionMemoryRecord {
  if (!record.agentLessons.some(artifact => artifact.id === id)) throw itemNotFound(id)
  return { ...record, agentLessons: record.agentLessons.filter(artifact => artifact.id !== id) }
}

/**
 * Pure profile replacement with caps enforced; timestamps are the caller's job.
 * @param record - current record value.
 * @param text - replacement profile document.
 * @param resolved - normalized caps.
 * @returns the candidate record without timestamp stamps.
 */
function applySetProfile(record: EvolutionMemoryRecord, text: string, resolved: ResolvedConfig): EvolutionMemoryRecord {
  const bytes = utf8Bytes(text)
  if (bytes > resolved.maxUserBytes) throw tooLarge('userProfile', bytes, resolved.maxUserBytes)
  const next = { ...record, userProfile: text }
  checkCapacity(next, resolved.capacityBytes)
  return next
}

interface StagedPayloadFields {
  readonly text?: unknown
  readonly id?: unknown
  readonly candidate?: unknown
  readonly candidates?: unknown
  readonly patch?: unknown
  readonly strategy?: unknown
  readonly extraction?: unknown
}

function stagedFields(payload: unknown, op: string): StagedPayloadFields {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`evolution-memory: staged op '${op}' payload must be an object`)
  }
  return payload
}

/**
 * Read the required replacement text of a staged payload.
 * @param fields - payload fields.
 * @param op - staged op name for the failure message.
 * @returns the string value.
 */
function requiredText(fields: StagedPayloadFields, op: string): string {
  const value = fields.text
  if (typeof value !== 'string') throw new Error(`evolution-memory: staged op '${op}' payload must carry a string 'text'`)
  return value
}

/**
 * Read the artifact identity an `updateArtifact` or `removeArtifact` payload addresses.
 * @param fields - payload fields.
 * @returns the addressed artifact identity.
 */
function requiredId(fields: StagedPayloadFields): string {
  const value = fields.id
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error("evolution-memory: staged artifact op payload must carry a non-empty string 'id'")
  }
  return value
}

/**
 * Read the patch object of an `updateArtifact` payload.
 * @param fields - payload fields.
 * @returns the candidate patch object, validated when it is merged.
 */
function patchFields(fields: StagedPayloadFields): object {
  const patch = fields.patch
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new Error("evolution-memory: staged updateArtifact payload must carry an object 'patch'")
  }
  return patch
}

/**
 * Read the candidate list of a `replaceArtifacts` payload.
 * @param fields - payload fields.
 * @returns the raw entries, each validated against the input schema by the caller.
 */
function requiredCandidates(fields: StagedPayloadFields): readonly unknown[] {
  const value = fields.candidates
  if (!Array.isArray(value)) {
    throw new Error("evolution-memory: staged replaceArtifacts payload must carry an array 'candidates'")
  }
  return value
}

/**
 * Read the optional merge strategy of an `addArtifact` payload.
 * @param value - the raw payload field.
 * @returns the strategy, defaulting to `keep_both`.
 */
function mergeStrategyField(value: unknown): LessonMergeStrategy {
  if (value === undefined) return 'keep_both'
  if (value !== 'overwrite' && value !== 'merge' && value !== 'keep_both') {
    throw new Error(`evolution-memory: unknown merge strategy ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Stamp extraction provenance from a staged payload when one is present.
 * @param record - candidate record value.
 * @param fields - payload fields.
 * @returns the record with `lastExtraction` replaced, or unchanged.
 */
function withStagedExtraction(record: EvolutionMemoryRecord, fields: StagedPayloadFields): EvolutionMemoryRecord {
  if (fields.extraction === undefined) return record
  const parsed = evolutionExtraction.safeParse(fields.extraction)
  if (!parsed.success) throw new Error('evolution-memory: staged memory op carries an invalid extraction')
  return { ...record, lastExtraction: parsed.data }
}

/**
 * Apply one memory-kind staged operation to a record value. Cap and
 * unknown-identity rejections propagate with the staged entry kept.
 * @param record - current record value.
 * @param entry - staged entry to apply.
 * @param resolved - normalized caps.
 * @param addTarget - the artifact a staged `addArtifact` absorbs, selected
 * before the write chain was entered; undefined for every other op.
 * @returns the candidate record without timestamp stamps, plus the memory
 * family the op changed, or `null` when the op stored nothing.
 */
function applyMemoryStagedOp(
  record: EvolutionMemoryRecord,
  entry: StagedWrite,
  resolved: ResolvedConfig,
  addTarget: LessonArtifact | undefined,
): { record: EvolutionMemoryRecord; family: MemoryFamily | null } {
  const fields = stagedFields(entry.payload, entry.op)
  switch (entry.op) {
    case 'setInstructions': {
      const next = { ...record, instructions: requiredText(fields, entry.op) }
      checkCapacity(next, resolved.capacityBytes)
      return { record: next, family: 'instructions' }
    }
    case 'addArtifact': {
      const candidate = lessonArtifactInput.parse(fields.candidate)
      const strategy = mergeStrategyField(fields.strategy)
      const next = addArtifactTo(record, candidate, strategy, addTarget, new Date().toISOString())
      if (next === record) return { record, family: null }
      checkArtifactCaps(next, resolved)
      return { record: withStagedExtraction(next, fields), family: 'lessons' }
    }
    case 'updateArtifact': {
      const next = patchArtifactIn(record, requiredId(fields), patchFields(fields), new Date().toISOString())
      checkArtifactCaps(next, resolved)
      return { record: withStagedExtraction(next, fields), family: 'lessons' }
    }
    case 'removeArtifact': {
      return { record: removeArtifactFrom(record, requiredId(fields)), family: 'lessons' }
    }
    case 'replaceArtifacts': {
      const candidates = requiredCandidates(fields).map(raw => lessonArtifactInput.parse(raw))
      const next = replaceArtifactsIn(record, candidates, new Date().toISOString())
      checkArtifactCaps(next, resolved)
      return { record: withStagedExtraction(next, fields), family: 'lessons' }
    }
    case 'setUserProfile': {
      const next = withStagedExtraction(applySetProfile(record, requiredText(fields, entry.op), resolved), fields)
      return { record: next, family: 'profile' }
    }
    default:
      throw new Error(`evolution-memory: unknown staged memory op '${entry.op}'`)
  }
}

/**
 * Fold stored and fresh output entries into one newest-first index,
 * collapsing repeats onto the newer `at` and truncating to the cap. An older
 * repeat and a same-instant repeat with identical facts keep the stored entry.
 * @param stored - the index already on the record, or empty when seeding.
 * @param fresh - newly observed entries.
 * @param maxOutputs - index size cap.
 * @returns the merged index, newest first.
 */
function mergeOutputs(
  stored: readonly EvolutionOutput[],
  fresh: readonly EvolutionOutput[],
  maxOutputs: number,
): EvolutionOutput[] {
  const merged = new Map<string, EvolutionOutput>()
  for (const entry of [...stored, ...fresh]) {
    const prior = merged.get(entry.path)
    if (prior === undefined) {
      merged.set(entry.path, { ...entry })
      continue
    }
    if (entry.at < prior.at) continue
    if (entry.at === prior.at && entry.tool === prior.tool && entry.sessionId === prior.sessionId) continue
    merged.set(entry.path, { ...entry })
  }
  return [...merged.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, maxOutputs)
}

/**
 * The slice of `ctx.embeddings` this store calls. It is declared here rather
 * than imported so the store keeps no dependency on an embeddings package:
 * the seam is optional, and the store must work with nothing mounted.
 */
interface EmbeddingsSeam {
  /** Embed one batch of texts, one vector per text in request order. */
  embed(request: { texts: readonly string[] }): Promise<{ vectors: readonly (readonly number[])[] }>
}

/**
 * Whether a context value offers the embeddings seam this store calls. An
 * absent or foreign value answers false instead of throwing, and `Object`
 * keeps the check total for nullish and primitive values.
 * @param value - the value read from `ctx.get('embeddings')`.
 * @returns whether the value can embed a batch.
 */
function isEmbeddingsSeam(value: unknown): value is EmbeddingsSeam {
  return typeof Reflect.get(Object(value), 'embed') === 'function'
}

/**
 * Durable per-scope evolution memory store. Opens the `evolution_memory`
 * domain at init and closes it through `ctx.effect`.
 */
export class EvolutionMemoryStore extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<EvolutionScopeId, EvolutionMemoryRecord>
  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - Host context carrying the storage domain.
   * @param config - capacity and per-field caps from the composition.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'evolutionMemory')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(evolutionMemoryDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-memory.domainClose')
    this.table = domain.table('records')
  }

  /**
   * Read one scope's record.
   * @param id - scope identity.
   * @returns a detached copy, or undefined when absent.
   */
  read(id: EvolutionScopeId): EvolutionMemoryRecord | undefined {
    const found = this.requireTable().get(storageKey(id) as EvolutionScopeId)
    return found === undefined ? undefined : structuredClone(found)
  }

  /**
   * Capacity accounting for one scope.
   * @param id - scope identity.
   * @returns charged bytes and the configured ceiling.
   */
  usage(id: EvolutionScopeId): EvolutionMemoryUsage {
    return {
      usedBytes: usedBytesOf(this.requireTable().get(storageKey(id) as EvolutionScopeId)),
      capacityBytes: this.resolved.capacityBytes,
    }
  }

  /**
   * Digest of the brief's inputs for one scope.
   * @param id - scope identity.
   * @returns `'empty'` when absent, else the sha1 of the covered inputs.
   */
  digest(id: EvolutionScopeId): string {
    return digestOf(this.requireTable().get(storageKey(id) as EvolutionScopeId))
  }

  /**
   * Replace the user-authored instruction text. Instructions carry no
   * per-field cap; only the scope capacity bounds them.
   * @param id - scope identity.
   * @param instructions - new rules.
   * @returns the stored record.
   */
  async setInstructions(id: EvolutionScopeId, instructions: string): Promise<EvolutionMemoryRecord> {
    const now = new Date().toISOString()
    return this.write(id, (record) => {
      const next = { ...record, instructions }
      checkCapacity(next, this.resolved.capacityBytes)
      return stampFamily(next, 'instructions', now)
    })
  }

  /**
   * Add one candidate artifact to the lessons. A candidate whose identity —
   * its normalized statement — is already present stores nothing under
   * `keep_both`, and under `overwrite` or `merge` folds into the artifact the
   * candidate matches: the one its identity already keys, otherwise the most
   * similar artifact at or above `mergeSimilarityFloor`, measured through the
   * optional `ctx.embeddings` seam. Without that seam only identity matches,
   * so a paraphrase is stored as an artifact of its own. `keep_both` never
   * merges: a candidate that is not an exact identity is stored beside the
   * artifact it resembles.
   * @param id - scope identity.
   * @param candidate - the fact to store.
   * @param strategy - how the candidate folds into the artifact it matches.
   * @returns the stored record, or the current record unchanged when the add
   * stores nothing.
   */
  async addArtifact(
    id: EvolutionScopeId,
    candidate: LessonArtifactInput,
    strategy: LessonMergeStrategy = 'keep_both',
  ): Promise<EvolutionMemoryRecord> {
    const parsed = lessonArtifactInput.parse(candidate)
    const key = artifactKey(parsed.statement)
    const current = this.requireTable().get(storageKey(id) as EvolutionScopeId)
    const artifacts = current?.agentLessons ?? []
    // An add that stores nothing must not enter the write chain, which stamps
    // `updatedAt` on every accepted call. `addArtifactTo` reaches the same
    // decision for the staged path.
    if (strategy === 'keep_both' && current !== undefined && current.agentLessons.some(artifact => artifact.id === key)) {
      return structuredClone(current)
    }
    const target = strategy === 'keep_both'
      ? undefined
      : pickMergeTarget(parsed, artifacts, await this.similarities(parsed, artifacts), this.resolved.mergeSimilarityFloor)
    const now = new Date().toISOString()
    return this.write(id, (record) => {
      const next = addArtifactTo(record, parsed, strategy, target, now)
      checkArtifactCaps(next, this.resolved)
      return stampFamily(next, 'lessons', now)
    })
  }

  /**
   * Patch one existing artifact. Identity, counters, statement, and the
   * creation instant are not patchable.
   * @param id - scope identity.
   * @param artifactId - the addressed artifact.
   * @param patch - changes to apply; absent fields keep their stored value.
   * @returns the stored record.
   */
  async updateArtifact(
    id: EvolutionScopeId,
    artifactId: string,
    patch: LessonArtifactPatch,
  ): Promise<EvolutionMemoryRecord> {
    const now = new Date().toISOString()
    return this.write(id, (record) => {
      const next = patchArtifactIn(record, artifactId, patch, now)
      checkArtifactCaps(next, this.resolved)
      return stampFamily(next, 'lessons', now)
    })
  }

  /**
   * Drop one existing artifact.
   * @param id - scope identity.
   * @param artifactId - the addressed artifact.
   * @returns the stored record.
   */
  async removeArtifact(id: EvolutionScopeId, artifactId: string): Promise<EvolutionMemoryRecord> {
    const now = new Date().toISOString()
    return this.write(id, record => stampFamily(removeArtifactFrom(record, artifactId), 'lessons', now))
  }

  /**
   * Replace the whole lessons document from a candidate list: the
   * document-level counterpart to {@link addArtifact}, {@link updateArtifact},
   * and {@link removeArtifact}, not a compatibility shim. The markdown
   * extraction pipeline rewrites a scope's lessons as one document and uses
   * this until it emits per-candidate ops. Every candidate is validated and
   * given a fresh identity, counters, and instants, so a candidate list that
   * repeats an identity is refused.
   * @param id - scope identity.
   * @param candidates - the whole lessons document, one candidate per fact.
   * @returns the stored record.
   */
  async replaceArtifacts(
    id: EvolutionScopeId,
    candidates: readonly LessonArtifactInput[],
  ): Promise<EvolutionMemoryRecord> {
    const parsed = candidates.map(candidate => lessonArtifactInput.parse(candidate))
    const now = new Date().toISOString()
    return this.write(id, (record) => {
      const next = replaceArtifactsIn(record, parsed, now)
      checkArtifactCaps(next, this.resolved)
      return stampFamily(next, 'lessons', now)
    })
  }

  /**
   * Replace the whole user profile document by hand or from extraction.
   * @param id - scope identity.
   * @param text - replacement profile document.
   * @param extraction - provenance when model-written.
   * @returns the stored record.
   */
  async setUserProfile(id: EvolutionScopeId, text: string, extraction?: EvolutionExtraction): Promise<EvolutionMemoryRecord> {
    const now = new Date().toISOString()
    return this.write(id, record => stampFamily({
      ...applySetProfile(record, text, this.resolved),
      ...extraction === undefined ? {} : { lastExtraction: structuredClone(extraction) },
    }, 'profile', now))
  }

  /**
   * Attach pasted text or a scope file.
   * @param id - scope identity.
   * @param input - label plus text or path with its observed size.
   * @returns the stored record.
   */
  async addContextItem(id: EvolutionScopeId, input: EvolutionContextItemInput): Promise<EvolutionMemoryRecord> {
    const sizeBytes = contextItemSize(input, this.resolved)
    const current = this.requireTable().get(storageKey(id) as EvolutionScopeId)
    const items = current?.contextItems ?? []
    const nextUsed = usedBytesOf(current) + sizeBytes
    if (items.length + 1 > this.resolved.maxContextItems || nextUsed > this.resolved.capacityBytes) {
      throw capacityExceeded(nextUsed, this.resolved.capacityBytes)
    }
    const now = new Date().toISOString()
    const item: EvolutionContextItem = input.kind === 'text'
      ? { id: randomUUID(), kind: 'text', label: input.label, sizeBytes, addedAt: now, text: input.text }
      : { id: randomUUID(), kind: 'file', label: input.label, sizeBytes, addedAt: now, path: input.path }
    return this.write(id, record => ({ ...record, contextItems: [...record.contextItems, item] }))
  }

  /**
   * Detach one context item.
   * @param id - scope identity.
   * @param itemId - context item identity.
   * @returns the stored record.
   */
  async removeContextItem(id: EvolutionScopeId, itemId: string): Promise<EvolutionMemoryRecord> {
    const current = this.requireTable().get(storageKey(id) as EvolutionScopeId)
    if (current === undefined || !current.contextItems.some(item => item.id === itemId)) {
      throw itemNotFound(itemId)
    }
    return this.write(id, record => ({ ...record, contextItems: record.contextItems.filter(item => item.id !== itemId) }))
  }

  /**
   * Stage one write for later approval. Staged entries never count toward
   * capacity; `memoryUpdatedAt` stays untouched until approval. The payload
   * is a durable record field, so it is validated as a JSON value here: a
   * non-JSON payload is refused loudly and nothing is stored.
   * @param input - scope, kind, op, payload, origin session, and gist.
   * @returns the staged entry.
   */
  async stageWrite(input: StagedWriteInput): Promise<StagedWrite> {
    const kind: unknown = input.kind
    if (kind !== 'memory' && kind !== 'skill') {
      throw new Error(`evolution-memory: staged kind must be 'memory' or 'skill', got ${JSON.stringify(kind)}`)
    }
    if (input.op.length === 0) throw new Error('evolution-memory: staged op must be non-empty')
    if (input.gist.length === 0) throw new Error('evolution-memory: staged gist must be non-empty')
    const payload = stagedWritePayload.safeParse(input.payload)
    if (!payload.success) throw new Error('evolution-memory: staged payload must be a JSON value')
    const now = new Date().toISOString()
    const entry: StagedWrite = {
      id: randomUUID(),
      kind: input.kind,
      op: input.op,
      payload: structuredClone(payload.data),
      originSessionId: input.originSessionId,
      createdAt: now,
      gist: input.gist,
    }
    await this.write(input.scopeId, record => ({ ...record, staged: [...record.staged, entry] }))
    return structuredClone(entry)
  }

  /**
   * Approve one staged write. Memory-kind entries apply their op first, so a
   * cap or substring rejection keeps the entry staged and propagates; the
   * entry drops only after the op lands. Skill-kind entries only drop: the
   * approver reads the payload from the scope record and performs the skill
   * write before approving. Either decision is recorded in the scope's
   * resolution log, newest first.
   * @param id - staged entry identity.
   * @returns resolution after durability.
   */
  async approveStaged(id: string): Promise<void> {
    const located = this.findStaged(id)
    if (located === undefined) throw stagedNotFound(id)
    const resolved = this.resolved
    const addTarget = await this.stagedAddTarget(located.record, located.entry)
    await this.requireTable().update(located.scope, (record) => {
      const target = record.staged.find(candidate => candidate.id === id)
      if (target === undefined) throw stagedNotFound(id)
      const now = new Date().toISOString()
      const remaining = record.staged.filter(candidate => candidate.id !== id)
      const resolutions = withResolution(record.resolutions, target, 'approved', now, resolved.maxResolutions)
      if (target.kind === 'skill') return { ...record, staged: remaining, resolutions, updatedAt: now }
      const applied = applyMemoryStagedOp(record, target, resolved, addTarget)
      const stamped = applied.family === null ? applied.record : stampFamily(applied.record, applied.family, now)
      return { ...stamped, staged: remaining, resolutions, updatedAt: now }
    })
  }

  /**
   * Drop one staged write without applying it.
   * @param id - staged entry identity.
   * @returns resolution after durability.
   */
  async rejectStaged(id: string): Promise<void> {
    const located = this.findStaged(id)
    if (located === undefined) throw stagedNotFound(id)
    const maxResolutions = this.resolved.maxResolutions
    await this.requireTable().update(located.scope, (record) => {
      const target = record.staged.find(candidate => candidate.id === id)
      if (target === undefined) throw stagedNotFound(id)
      const now = new Date().toISOString()
      return {
        ...record,
        staged: record.staged.filter(candidate => candidate.id !== id),
        resolutions: withResolution(record.resolutions, target, 'rejected', now, maxResolutions),
        updatedAt: now,
      }
    })
  }

  /**
   * Index produced files newest-first, collapsing repeats onto the newer
   * `at` and truncating to `maxOutputs`. Resolves without writing when the
   * resulting list is unchanged.
   * @param id - scope identity.
   * @param entries - output entries with path, tool, session, and instant.
   * @returns resolution after durability, or immediately when unchanged.
   */
  async recordOutputs(id: EvolutionScopeId, entries: readonly EvolutionOutput[]): Promise<void> {
    if (entries.length === 0) return
    const table = this.requireTable()
    const key = storageKey(id) as EvolutionScopeId
    const current = table.get(key)
    const outputs = mergeOutputs(current?.outputs ?? [], entries, this.resolved.maxOutputs)
    if (current !== undefined && sameOutputs(current.outputs, outputs)) return
    const now = new Date().toISOString()
    if (current === undefined) {
      await table.put(key, {
        ...freshRecord() as EvolutionMemoryRecord,
        outputs,
        updatedAt: now,
      })
      return
    }
    await table.update(key, record => ({ ...record, outputs, updatedAt: new Date().toISOString() }))
  }

  /**
   * Locate the record holding one staged entry. Table keys are storage keys;
   * the returned scope is the same encoding `update` expects.
   * @param id - staged entry identity.
   * @returns the owning scope, its record, and the entry, or undefined when no
   * scope holds it.
   */
  private findStaged(
    id: string,
  ): { scope: EvolutionScopeId; record: EvolutionMemoryRecord; entry: StagedWrite } | undefined {
    for (const [scope, record] of this.requireTable().entries()) {
      const entry = record.staged.find(candidate => candidate.id === id)
      if (entry !== undefined) return { scope, record, entry }
    }
    return undefined
  }

  /**
   * Resolve the artifact a staged `addArtifact` folds into, before the write
   * chain is entered: the similarity lookup awaits the embeddings seam, and
   * the table update runs its callback synchronously.
   * @param record - the owning scope's current record.
   * @param entry - the staged entry being approved.
   * @returns the selected target, or undefined when the entry is not an
   * `addArtifact` that merges.
   */
  private async stagedAddTarget(
    record: EvolutionMemoryRecord,
    entry: StagedWrite,
  ): Promise<LessonArtifact | undefined> {
    if (entry.kind !== 'memory' || entry.op !== 'addArtifact') return undefined
    const fields = stagedFields(entry.payload, entry.op)
    if (mergeStrategyField(fields.strategy) === 'keep_both') return undefined
    const candidate = lessonArtifactInput.parse(fields.candidate)
    return pickMergeTarget(
      candidate,
      record.agentLessons,
      await this.similarities(candidate, record.agentLessons),
      this.resolved.mergeSimilarityFloor,
    )
  }

  /**
   * Measure one candidate against a scope's artifacts through the optional
   * `ctx.embeddings` seam. Without that seam nothing is measured, so only an
   * exact statement identity can match; paraphrase detection is off rather
   * than the write failing.
   * @param candidate - validated caller-supplied artifact fields.
   * @param artifacts - the scope's existing artifacts.
   * @returns similarity per artifact id, empty without embeddings.
   */
  private async similarities(
    candidate: LessonArtifactInput,
    artifacts: readonly LessonArtifact[],
  ): Promise<ReadonlyMap<string, number>> {
    const raw: unknown = this.ctx.get('embeddings')
    if (!isEmbeddingsSeam(raw) || artifacts.length === 0) return new Map()
    const result = await raw.embed({ texts: [candidate.statement, ...artifacts.map(artifact => artifact.statement)] })
    const query = result.vectors[0]
    if (query === undefined) return new Map()
    const scores = new Map<string, number>()
    for (const [index, artifact] of artifacts.entries()) {
      const vector = result.vectors[index + 1]
      if (vector === undefined) continue
      scores.set(artifact.id, cosineSimilarity(query, vector))
    }
    return scores
  }

  private async write(
    id: EvolutionScopeId,
    fn: (current: EvolutionMemoryRecord) => Partial<EvolutionMemoryRecord>,
  ): Promise<EvolutionMemoryRecord> {
    const table = this.requireTable()
    const key = storageKey(id) as EvolutionScopeId
    const current = table.get(key)
    if (current === undefined) {
      const now = new Date().toISOString()
      const seeded: EvolutionMemoryRecord = { ...(freshRecord() as EvolutionMemoryRecord), updatedAt: now }
      const next: EvolutionMemoryRecord = { ...seeded, ...fn(seeded), updatedAt: now }
      await table.put(key, structuredClone(next))
      return structuredClone(next)
    }
    const next = await table.update(key, (record) => {
      const candidate = fn(record)
      return { ...record, ...candidate, updatedAt: new Date().toISOString() }
    })
    return structuredClone(next)
  }

  private requireTable(): KvTable<EvolutionScopeId, EvolutionMemoryRecord> {
    if (this.table === undefined) throw new Error('evolution memory store is not started yet')
    return this.table
  }
}

function sameOutputs(left: readonly EvolutionOutput[], right: readonly EvolutionOutput[]): boolean {
  if (left.length !== right.length) return false
  return left.every((entry, index) => {
    const other = right[index] as EvolutionOutput
    return entry.path === other.path && entry.tool === other.tool && entry.sessionId === other.sessionId && entry.at === other.at
  })
}

export default EvolutionMemoryStore
