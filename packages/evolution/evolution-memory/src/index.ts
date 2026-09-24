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
 * `applyExtractionDecisions` applies one extraction pass's whole confirm /
 * contradict / new batch as a single write, and `replaceArtifacts` is the
 * document-level counterpart a caller uses to replace the whole lessons list
 * by hand — the controller's `setLessons` Remote op is its one caller.
 * `addArtifact` folds a candidate into the artifact it most resembles when an
 * embeddings service is mounted; that seam is optional, so without it only an
 * exact identity matches and a paraphrase is stored as an artifact of its own.
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
import { artifactKey, assertDirectlyAdmissible, lessonArtifactInput, rememberOutcome } from './lesson-artifact.ts'
import type { LessonArtifact, LessonArtifactInput, LessonArtifactPatch, LessonMergeStrategy } from './lesson-artifact.ts'
import { cosineSimilarity, mergeArtifact, pickMergeTarget } from './merge.ts'
import { addArtifactTo, applyLessonDecisions, artifactIdOf, freshArtifact, lessonDecision } from './decisions.ts'
import type { LessonDecision } from './decisions.ts'
import { pruneEpisodic, prunable } from './maintenance.ts'
import type { SweepResult } from './maintenance.ts'
import { appendRecall, bindRecalls, gradeRecall, memoryUtility, recallTarget } from './recall.ts'
import type { MemoryUtility } from './recall.ts'
import { evolutionExtraction, evolutionMemoryDomainSpec, stagedWritePayload } from './spec.ts'
import { contractJson, validateCaptureContract } from './capture-contract.ts'
import type {
  EvolutionContextItem,
  EvolutionContextItemInput,
  EvolutionDecisionsApplied,
  EvolutionExtraction,
  EvolutionMemoryRecord,
  EvolutionMemoryUsage,
  EvolutionOutput,
  EvolutionScopeId as EvolutionScopeIdBrand,
  RecordedRecall,
  StagedResolution,
  StagedWrite,
  StagedWriteInput,
} from './types.ts'

export type {
  EvolutionContextItem,
  EvolutionContextItemInput,
  EvolutionDecisionsApplied,
  EvolutionExtraction,
  EvolutionMemoryRecord,
  EvolutionMemoryUsage,
  EvolutionOutput,
  MemoryStagedAddArtifactPayload,
  MemoryStagedApplyDecisionsPayload,
  MemoryStagedRemoveArtifactPayload,
  MemoryStagedReplaceArtifactsPayload,
  MemoryStagedTextPayload,
  MemoryStagedUpdateArtifactPayload,
  MemoryRecall,
  RecallOutcome,
  RecordedRecall,
  StagedResolution,
  StagedWrite,
  StagedWriteInput,
  CaptureContract,
} from './types.ts'
export { validateCaptureContract } from './capture-contract.ts'
export { contractJson } from './capture-contract.ts'
export type { CaptureContractVerdict } from './capture-contract.ts'
export { applyLessonDecisions, lessonDecision } from './decisions.ts'
export type { LessonDecision } from './decisions.ts'
export { evolutionMemoryDomainSpec } from './spec.ts'
export { RECALL_LABEL_PREFIX, memoryUtility, recallTarget } from './recall.ts'
export type { MemoryUtility } from './recall.ts'
export { digestOf, usedBytesOf, EMPTY_DIGEST, truncateUtf8, utf8Bytes, artifactBytesOf } from './digest.ts'
export { admissionIssues, artifactKey, assertDirectlyAdmissible, rememberOutcome, lessonArtifact, lessonArtifactInput, normalizeStatement, scrubArtifactText, utilityValue, wrapLegacyLessons } from './lesson-artifact.ts'
export { cosineSimilarity, mergeArtifact, pickMergeTarget } from './merge.ts'
export { demotable } from './maintenance.ts'
export type { SweepResult } from './maintenance.ts'
export type {
  LessonArtifact,
  LessonArtifactInput,
  LessonArtifactPatch,
  LessonArtifactScope,
  LessonEvidenceKind,
  LessonLineage,
  LessonMergeStrategy,
  LessonTrust,
  LessonSupersession,
  UtilityEstimate,
} from './lesson-artifact.ts'

/** Heartbeat task name carrying the automatic maintenance sweep. */
export const EVOLUTION_MEMORY_MAINTENANCE_TASK = 'evolution-memory-maintenance'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable per-scope evolution memory record owner. */
    evolutionMemory: EvolutionMemoryStore
  }

  interface Events {
    /**
     * One extraction pass's decision batch landed on a scope's record,
     * emitted once per applied batch strictly after the write is durable.
     * Deriving consumers — the knowledge graph's claim layer is the shipped
     * one — fold the batch into their own state here; a listener failure is
     * their own to contain, because the batch it reports is already stored.
     *
     * A batch applied without provenance is not published: every decision is
     * attributed to the session that reported it, and a batch whose session
     * is unknown would carry unattributable evidence.
     * @param batch - scope, source session, decisions, and the artifacts they addressed.
     * @mode emit
     */
    'evolution/decisions-applied'(batch: EvolutionDecisionsApplied): void
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
  /** Recalls retained per scope in the recall ledger, newest kept. */
  maxRecalls?: number
  /** Minimum similarity to an existing artifact that justifies merging instead of storing separately. */
  mergeSimilarityFloor?: number
  /** Hours between two maintenance sweeps of every stored scope. */
  maintenanceIntervalHours?: number
  /** Refutations at or above which decay prunes an artifact regardless of age. */
  refutationFloor?: number
  /**
   * Days a new artifact is given as its ttl when its caller supplies none.
   * Decay prunes an artifact this many days after the last write that touched
   * it, so keeping one alive takes a write that reaches it: a refine pass over
   * the scope's lessons or an explicit edit, never a read.
   */
  defaultTtlDays?: number
  /**
   * Days an episodic note stays readable after it landed; the append path
   * drops older notes, so the tier stays a short-lived daily log.
   */
  episodicRetentionDays?: number
  /** Episodic notes retained per scope past the age cut, newest kept. */
  maxEpisodicEntries?: number
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

/** Recalls retained per scope in the recall ledger. */
const maxRecallsField = z.number().step(1).min(1).default(50)

/** Similarity floor for merging a candidate into an existing artifact. */
const mergeSimilarityFloorField = z.number().min(0).max(1).default(0.87)

/** Hours between two maintenance sweeps of every stored scope. */
const maintenanceIntervalHoursField = z.number().step(1).min(1).default(24)

/** Refutations at or above which decay prunes an artifact regardless of age. */
const refutationFloorField = z.number().step(1).min(1).default(3)

/** Days a new artifact is given when its caller supplies no ttl. */
const defaultTtlDaysField = z.number().step(1).min(1).default(30)

/** Days an episodic note stays readable after it landed. */
const episodicRetentionDaysField = z.number().step(1).min(1).default(7)

/** Episodic notes retained per scope past the age cut, newest kept. */
const maxEpisodicEntriesField = z.number().step(1).min(1).default(100)

/** Validated deployment choices; `capacityBytes` is required. */
export const Config: z<Config> = z.object({
  capacityBytes: capacityBytesField,
  maxAgentBytes: maxAgentBytesField,
  maxUserBytes: maxUserBytesField,
  maxContextItemBytes: maxContextItemBytesField,
  maxContextItems: maxContextItemsField,
  maxOutputs: maxOutputsField,
  maxResolutions: maxResolutionsField,
  maxRecalls: maxRecallsField,
  mergeSimilarityFloor: mergeSimilarityFloorField,
  maintenanceIntervalHours: maintenanceIntervalHoursField,
  refutationFloor: refutationFloorField,
  defaultTtlDays: defaultTtlDaysField,
  episodicRetentionDays: episodicRetentionDaysField,
  maxEpisodicEntries: maxEpisodicEntriesField,
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
  maxRecalls: number
  mergeSimilarityFloor: number
  maintenanceIntervalHours: number
  refutationFloor: number
  defaultTtlDays: number
  episodicRetentionDays: number
  maxEpisodicEntries: number
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
    maxRecalls = 50,
    mergeSimilarityFloor = 0.87,
    maintenanceIntervalHours = 24,
    refutationFloor = 3,
    defaultTtlDays = 30,
    episodicRetentionDays = 7,
    maxEpisodicEntries = 100,
  } = config
  return {
    capacityBytes,
    maxAgentBytes,
    maxUserBytes,
    maxContextItemBytes,
    maxContextItems,
    maxOutputs,
    maxResolutions,
    maxRecalls,
    mergeSimilarityFloor,
    maintenanceIntervalHours,
    refutationFloor,
    defaultTtlDays,
    episodicRetentionDays,
    maxEpisodicEntries,
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
    recalls: [],
    episodic: [],
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
    mergeKey: entry.mergeKey,
    recurrence: entry.recurrence,
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

function stagedBlocked(stagedId: string, neededEvidence: readonly string[]): RemoteError<'evolution/staged-blocked'> {
  return new RemoteError(
    'evolution/staged-blocked',
    `staged evolution write '${stagedId}' is blocked: ${neededEvidence.join('; ')}`,
    { stagedId, neededEvidence: [...neededEvidence] },
  )
}

/**
 * Name the admission evidence a creation proposal is missing. A payload that
 * is not an object cannot carry a contract at all. Only `create` proposals
 * are gated: a patch revises an already-admitted capability and carries the
 * measurement that justifies it.
 * @param payload - the staged entry's JSON payload.
 * @returns the missing evidence, empty when the contract admits the skill.
 */
function skillContractIssues(payload: unknown): string[] {
  const contract = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)['contract']
    : undefined
  const verdict = validateCaptureContract(contract)
  return verdict.ok ? [] : [...verdict.issues]
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
 * Replace the whole artifact array from a candidate list, refusing an identity
 * that appears twice and a statement that normalizes away to nothing.
 * @param record - current record value.
 * @param candidates - validated caller-supplied artifact fields.
 * @param now - ISO-8601 instant to stamp as both instants.
 * @param defaultTtlDays - ttl an artifact is given when its candidate carries none.
 * @returns the candidate record without the family stamp.
 */
function replaceArtifactsIn(
  record: EvolutionMemoryRecord,
  candidates: readonly LessonArtifactInput[],
  now: string,
  defaultTtlDays: number,
): EvolutionMemoryRecord {
  const seen = new Set<string>()
  const artifacts: LessonArtifact[] = []
  for (const candidate of candidates) {
    const id = artifactIdOf(candidate)
    if (seen.has(id)) {
      throw new Error(`evolution-memory: replacement artifact list repeats identity '${id}'`)
    }
    seen.add(id)
    artifacts.push(freshArtifact(candidate, id, now, defaultTtlDays))
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
  readonly decisions?: unknown
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
 * Read the decision batch of an `applyDecisions` payload, validating every
 * entry: a payload a later reader cannot fold is refused when the batch is
 * applied, not when an artifact is halfway written.
 * @param fields - payload fields.
 * @returns the validated decisions, in reported order.
 */
function requiredDecisions(fields: StagedPayloadFields): readonly LessonDecision[] {
  const value = fields.decisions
  if (!Array.isArray(value)) {
    throw new Error("evolution-memory: staged applyDecisions payload must carry an array 'decisions'")
  }
  return value.map(raw => lessonDecision.parse(raw))
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
 * Fold one decision batch into a record, resolving each `new` decision's
 * pre-selected merge target by index before the fold starts. Targets were
 * selected outside the write chain and re-resolve against the record actually
 * being written, so a vanished one falls back rather than dropping a decision.
 * @param record - current record value.
 * @param decisions - validated decisions, in reported order.
 * @param resolved - normalized caps and the default ttl.
 * @param addTargets - merge target per `new` decision index, already resolved
 * for this batch against a record read before the write chain.
 * @returns the candidate record without the family stamp.
 */
function applyDecisionsTo(
  record: EvolutionMemoryRecord,
  decisions: readonly LessonDecision[],
  resolved: ResolvedConfig,
  addTargets: readonly (LessonArtifact | undefined)[],
): EvolutionMemoryRecord {
  const now = new Date().toISOString()
  const targets = new Map<number, LessonArtifact | undefined>()
  for (const [index, decision] of decisions.entries()) {
    if (decision.kind === 'new') targets.set(index, addTargets[index])
  }
  return applyLessonDecisions(record, decisions, targets, now, resolved.defaultTtlDays)
}

/**
 * Apply one memory-kind staged operation to a record value. Cap and
 * unknown-identity rejections propagate with the staged entry kept.
 * @param record - current record value.
 * @param entry - staged entry to apply.
 * @param resolved - normalized caps.
 * @param addTargets - the artifacts the staged entry's `new` decisions absorb,
 * in decision order, selected before the write chain was entered; an empty
 * array for every other op.
 * @returns the candidate record without timestamp stamps, plus the memory
 * family the op changed, or `null` when the op stored nothing.
 */
function applyMemoryStagedOp(
  record: EvolutionMemoryRecord,
  entry: StagedWrite,
  resolved: ResolvedConfig,
  addTargets: readonly (LessonArtifact | undefined)[],
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
      const next = addArtifactTo(record, candidate, strategy, addTargets[0], new Date().toISOString(), resolved.defaultTtlDays)
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
      const next = replaceArtifactsIn(record, candidates, new Date().toISOString(), resolved.defaultTtlDays)
      checkArtifactCaps(next, resolved)
      return { record: withStagedExtraction(next, fields), family: 'lessons' }
    }
    case 'applyDecisions': {
      const decisions = requiredDecisions(fields)
      const next = applyDecisionsTo(record, decisions, resolved, addTargets)
      // A batch that stored and changed nothing — an empty batch, or only
      // no-ops — stamps no family, exactly as the `addArtifact` case above.
      if (next === record) return { record, family: null }
      checkArtifactCaps(next, resolved)
      return { record: withStagedExtraction(next, fields), family: 'lessons' }
    }
    case 'setUserProfile': {
      const next = withStagedExtraction(applySetProfile(record, requiredText(fields, entry.op), resolved), fields)
      return { record: next, family: 'profile' }
    }
    case 'appendEpisodic': {
      const text = requiredText(fields, entry.op)
      if (text.trim().length === 0) {
        throw new Error("evolution-memory: staged appendEpisodic payload must carry a non-blank 'text'")
      }
      const now = new Date().toISOString()
      const next = {
        ...record,
        // Episodic material stamps no family: it is unapproved consolidation
        // input, not a curated document, so no family instant moves for it.
        episodic: pruneEpisodic(
          [...record.episodic, { day: now.slice(0, 10), text, addedAt: now }],
          Date.parse(now),
          resolved.episodicRetentionDays,
          resolved.maxEpisodicEntries,
        ),
      }
      checkCapacity(next, resolved.capacityBytes)
      return { record: next, family: null }
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
 * The slice of `ctx.evolutionHeartbeat` this store registers with. It is
 * declared here rather than imported so the store keeps no dependency on the
 * heartbeat package: the engine is optional infrastructure, and the store must
 * work — with `sweep` callable directly — when nothing mounts one.
 */
interface HeartbeatSeam {
  /**
   * Register one periodic maintenance task.
   * @param task - identity, cadence, and the work to run.
   * @returns the disposer removing the task.
   */
  register(task: {
    name: string
    intervalHours: number
    run: (signal: AbortSignal) => Promise<void> | void
  }): () => void
}

/**
 * Whether a context value offers the heartbeat seam this store calls. Mirrors
 * {@link isEmbeddingsSeam}: absent and foreign values answer false instead of
 * throwing.
 * @param value - the value read from `ctx.get('evolutionHeartbeat')`.
 * @returns whether the value can register a task.
 */
function isHeartbeatSeam(value: unknown): value is HeartbeatSeam {
  return typeof Reflect.get(Object(value), 'register') === 'function'
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

  /** Open the domain, publish the table handle, and register the maintenance sweep. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(evolutionMemoryDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-memory.domainClose')
    this.table = domain.table('records')
    const heartbeat: unknown = this.ctx.get('evolutionHeartbeat')
    if (!isHeartbeatSeam(heartbeat)) return
    this.ctx.effect(
      () => heartbeat.register({
        name: EVOLUTION_MEMORY_MAINTENANCE_TASK,
        intervalHours: this.resolved.maintenanceIntervalHours,
        run: async (signal: AbortSignal) => {
          for (const [key] of this.requireTable().entries()) {
            if (signal.aborted) return
            await this.sweep(scopeIdFromStorageKey(key))
          }
        },
      }),
      'evolution-memory.heartbeatTask',
    )
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
    assertDirectlyAdmissible(parsed)
    const key = artifactKey(parsed.statement)
    const current = this.requireTable().get(storageKey(id) as EvolutionScopeId)
    const artifacts = current?.agentLessons ?? []
    // An add that stores nothing must not enter the write chain, which stamps
    // `updatedAt` on every accepted call. `addArtifactTo` reaches the same
    // decision for the staged path.
    if (strategy === 'keep_both' && current !== undefined && current.agentLessons.some(artifact => artifact.id === key)) {
      return structuredClone(current)
    }
    const target = strategy === 'keep_both' ? undefined : await this.pickTarget(parsed, artifacts)
    const now = new Date().toISOString()
    return this.write(id, (record) => {
      const next = addArtifactTo(record, parsed, strategy, target, now, this.resolved.defaultTtlDays)
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
   * Apply one extraction pass's whole decision batch: a `confirms` bumps the
   * addressed artifact's `validationCount`, a `contradicts` bumps its
   * `refutationCount` and replaces the statement and confidence it carries,
   * and a `new` candidate is added through {@link addArtifact}'s
   * merge-by-meaning path — so a candidate the model called new that
   * coincides with an artifact outside the list it was shown folds into that
   * artifact rather than accumulating beside it.
   *
   * A decision naming an artifact the record no longer holds is skipped, not
   * refused: the target was resolved against an earlier read, and a prune can
   * land in between.
   *
   * The batch is one write: it stages or applies as a unit and stamps one
   * lessons family stamp, matching the one-item-per-call shape this path
   * replaces. A batch that changed nothing — an empty one, or one whose only
   * decisions named artifacts the record no longer holds — stamps no family,
   * exactly as {@link addArtifact} does when its add stores nothing; the
   * provenance of the call that found nothing is still recorded.
   *
   * A batch applied with provenance is also published as one
   * `evolution/decisions-applied` event once the write is durable, carrying
   * the artifacts as they read before it. A batch applied without provenance
   * is not published: every decision would carry unattributable evidence.
   * @param id - scope identity.
   * @param decisions - the confirmed, contradicted, and new facts, in the
   * order the extraction reported them.
   * @param extraction - provenance of the call that produced the batch.
   * @returns the stored record.
   */
  async applyExtractionDecisions(
    id: EvolutionScopeId,
    decisions: readonly LessonDecision[],
    extraction?: EvolutionExtraction,
  ): Promise<EvolutionMemoryRecord> {
    const parsed = decisions.map(decision => lessonDecision.parse(decision))
    // An extraction that read untrusted content cannot promote it: its
    // candidates are staged for approval instead of landing directly.
    for (const decision of parsed) {
      if (decision.kind === 'new') assertDirectlyAdmissible(decision.candidate)
    }
    const artifacts = this.read(id)?.agentLessons ?? []
    const addTargets = await this.decisionAddTargets(artifacts, parsed)
    const now = new Date().toISOString()
    const record = await this.write(id, (current) => {
      const next = applyDecisionsTo(current, parsed, this.resolved, addTargets)
      checkArtifactCaps(next, this.resolved)
      return {
        ...next === current ? {} : stampFamily(next, 'lessons', now),
        ...extraction === undefined ? {} : {
          lastExtraction: structuredClone(extraction),
          // Every recall still awaiting a decision is bound to this batch: the
          // extraction that landed after it is the recorded decision the
          // recalled material was in play for, and its session is what a
          // grader reads an outcome from.
          recalls: bindRecalls(next.recalls, extraction.sessionId, now),
        },
      }
    })
    if (extraction !== undefined) {
      this.publish({
        scopeId: id,
        sessionId: extraction.sessionId,
        decisions: parsed,
        artifacts,
      })
    }
    return record
  }

  /**
   * Replace the whole lessons document from a candidate list: the
   * document-level counterpart to {@link addArtifact}, {@link updateArtifact},
   * and {@link removeArtifact}, not a compatibility shim. A caller replaces
   * the whole list by hand this way; the controller's `setLessons` Remote op
   * is its one caller. Every candidate is validated and given a fresh
   * identity, counters, and instants, so a candidate list that repeats an
   * identity is refused.
   * @param id - scope identity.
   * @param candidates - the whole lessons document, one candidate per fact.
   * @param extraction - provenance when model-written.
   * @returns the stored record.
   */
  async replaceArtifacts(
    id: EvolutionScopeId,
    candidates: readonly LessonArtifactInput[],
    extraction?: EvolutionExtraction,
  ): Promise<EvolutionMemoryRecord> {
    const parsed = candidates.map(candidate => lessonArtifactInput.parse(candidate))
    const now = new Date().toISOString()
    return this.write(id, (record) => {
      const next = replaceArtifactsIn(record, parsed, now, this.resolved.defaultTtlDays)
      checkArtifactCaps(next, this.resolved)
      return stampFamily({
        ...next,
        ...extraction === undefined ? {} : { lastExtraction: structuredClone(extraction) },
      }, 'lessons', now)
    })
  }

  /**
   * Apply decay to one scope's artifacts: drop every artifact `prunable`
   * condemns by ttl or refutation floor and leave the rest untouched. A sweep
   * that finds nothing to drop reaches no write at all, so it moves neither
   * `updatedAt` nor the lessons family stamp; a sweep that drops something
   * stamps the lessons family like any other lessons write.
   *
   * `refined` is always 0. The extraction protocol folds decisions into the
   * artifacts it reads rather than refining them, so nothing yet splits the
   * coarse artifact `wrapLegacyLessons` admits from a legacy lessons
   * document; until a pass does that, the coarse artifact is a correct,
   * permanent fallback and this sweep never calls an extractor.
   * @param scopeId - scope identity.
   * @param now - ISO-8601 instant to judge decay at and stamp the write with,
   * defaulting to the wall clock.
   * @returns what the sweep changed.
   */
  async sweep(scopeId: EvolutionScopeId, now: string = new Date().toISOString()): Promise<SweepResult> {
    const record = this.read(scopeId)
    if (record === undefined) return { pruned: 0, refined: 0 }
    const instant = Date.parse(now)
    const decayed = (artifact: LessonArtifact): boolean => prunable(artifact, instant, this.resolved.refutationFloor)
    if (!record.agentLessons.some(decayed)) return { pruned: 0, refined: 0 }
    // The record the snapshot above decided on is not necessarily the record
    // the write chain resolves: another write can land in between. Both the
    // survivors and the count therefore come from the record actually being
    // written, so `pruned` is what this sweep removed, never what the stale
    // snapshot expected it to remove.
    let pruned = 0
    await this.write(scopeId, (current) => {
      const kept = current.agentLessons.filter(artifact => !decayed(artifact))
      pruned = current.agentLessons.length - kept.length
      return stampFamily({ ...current, agentLessons: kept }, 'lessons', now)
    })
    return { pruned, refined: 0 }
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
   * Attach pasted text or a scope file. An item whose label carries the stored
   * `RECALL_LABEL_PREFIX` is a recall of the memory the label names, so the
   * write also appends one row to the scope's recall ledger: that is §23's
   * `retrieved` link, counted where the shipped recall path already writes.
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
    const recalled = recallTarget(input.label)
    return this.write(id, record => ({
      ...record,
      contextItems: [...record.contextItems, item],
      ...recalled === undefined ? {} : {
        recalls: appendRecall(record.recalls, {
          id: recalled,
          itemId: item.id,
          at: now,
          decidedInSessionId: null,
          decidedAt: null,
          outcome: null,
          outcomeAt: null,
        }, this.resolved.maxRecalls),
      },
    }))
  }

  /**
   * Every recall the profile's scopes recorded, newest first within its scope,
   * each naming the scope it landed in. §23's loop is read from here; which
   * session read a recalled item is not among the recorded links.
   * @returns one row per recorded recall.
   */
  recalls(): readonly RecordedRecall[] {
    const rows: RecordedRecall[] = []
    for (const [key, record] of this.requireTable().entries()) {
      const scopeId = scopeIdFromStorageKey(key)
      for (const recall of record.recalls) rows.push({ ...structuredClone(recall), scopeId })
    }
    return rows
  }

  /**
   * Record the graded outcome of one recall: the §23 loop's `helped outcome`
   * link. The grader is whichever pass reads the outcome record — the
   * curator's idle pass is the shipped one, which grades the session the
   * recall's decision batch was extracted from off the feedback store. The
   * newest recall of that memory still awaiting an outcome is the one graded,
   * so a memory recalled again after an outcome is graded again on its newer
   * recall. A memory with no awaiting recall is refused loudly rather than
   * graded twice.
   * @param id - scope identity.
   * @param recalledId - recalled memory's identity, as its label carried it.
   * @param outcome - `ok` when the graded session's evidence was clean, else `failed`.
   * @param at - ISO-8601 instant the outcome was recorded, defaulting to the wall clock.
   * @returns the stored record.
   */
  async recordRecallOutcome(
    id: EvolutionScopeId,
    recalledId: string,
    outcome: 'ok' | 'failed',
    at: string = new Date().toISOString(),
  ): Promise<EvolutionMemoryRecord> {
    const current = this.requireTable().get(storageKey(id) as EvolutionScopeId)
    if (current === undefined || !current.recalls.some(recall => recall.id === recalledId && recall.outcome === null)) {
      throw itemNotFound(recalledId)
    }
    return this.write(id, record => ({
      ...record,
      recalls: gradeRecall(record.recalls, recalledId, outcome, at),
      // S8: the fact that was surfaced earns the outcome its task reached, so a
      // demotion rests on observed outcomes instead of on age alone. A recall of
      // something that is not a lesson keeps its ledger row and updates nothing.
      agentLessons: record.agentLessons.map(artifact => artifact.id === recalledId
        ? { ...artifact, utility: rememberOutcome(artifact.utility, outcome) }
        : artifact),
    }))
  }

  /**
   * §24's utility for every memory the recall ledger holds, one reading per
   * recalled memory across the profile's scopes. Reads the same rows
   * {@link recalls} returns.
   * @returns the derived readings.
   */
  recallUtility(): readonly MemoryUtility[] {
    return memoryUtility(this.recalls())
  }

  /**
   * Detach one context item. The recall ledger keeps its row: the recall
   * happened, and dropping the item from the brief does not un-retrieve it.
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
   *
   * A non-empty `mergeKey` dedupes while pending: re-staging the same key in
   * the same scope bumps the pending entry's `recurrence` instead of
   * appending a duplicate, so a repeatedly proposed candidate is remembered,
   * not silently retried.
   * @param input - scope, kind, op, payload, origin session, gist, and merge key.
   * @returns the staged entry, or the bumped pending entry on a repeated key.
   */
  async stageWrite(input: StagedWriteInput): Promise<StagedWrite> {
    const kind: unknown = input.kind
    if (kind !== 'memory' && kind !== 'skill') {
      throw new Error(`evolution-memory: staged kind must be 'memory' or 'skill', got ${JSON.stringify(kind)}`)
    }
    if (input.op.length === 0) throw new Error('evolution-memory: staged op must be non-empty')
    if (input.gist.length === 0) throw new Error('evolution-memory: staged gist must be non-empty')
    const mergeKey = input.mergeKey ?? null
    if (mergeKey !== null && mergeKey.length === 0) throw new Error('evolution-memory: staged mergeKey must be non-empty')
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
      mergeKey,
      recurrence: 1,
      blockedReason: null,
      neededEvidence: [],
    }
    let staged: StagedWrite = entry
    await this.write(input.scopeId, (record) => {
      const pending = mergeKey === null
        ? undefined
        : record.staged.find(candidate => candidate.mergeKey === mergeKey)
      if (pending === undefined) return { ...record, staged: [...record.staged, entry] }
      staged = { ...pending, recurrence: pending.recurrence + 1 }
      return { ...record, staged: record.staged.map(candidate => candidate.id === pending.id ? staged : candidate) }
    })
    return structuredClone(staged)
  }

  /**
   * Approve one staged write. Memory-kind entries apply their op first, so a
   * cap or substring rejection keeps the entry staged and propagates; the
   * entry drops only after the op lands. Skill-kind entries only drop: the
   * approver reads the payload from the scope record and performs the skill
   * write before approving. A `create` proposal is additionally admitted on
   * its capture contract — a capability claim needs independent validation
   * evidence — so without one the entry stays staged with its `blockedReason`
   * and `neededEvidence` set and the block propagates, like a cap rejection.
   * A `patch` revises a capability that was already admitted: its evidence is
   * the baseline-versus-candidate measurement its proposer recorded, which
   * this store has no way to read, so it drops on the human's approval.
   * Either decision is recorded in the scope's resolution log, newest first.
   * An approved `applyDecisions` batch is published as one
   * `evolution/decisions-applied` event under the entry's origin session, on
   * the same terms {@link applyExtractionDecisions} states.
   * @param id - staged entry identity.
   * @returns resolution after durability.
   */
  async approveStaged(id: string): Promise<void> {
    const located = this.findStaged(id)
    if (located === undefined) throw stagedNotFound(id)
    if (located.entry.kind === 'skill' && located.entry.op === 'create') {
      const issues = skillContractIssues(located.entry.payload)
      if (issues.length > 0) {
        await this.requireTable().update(located.scope, (record) => {
          if (record.staged.every(candidate => candidate.id !== id)) throw stagedNotFound(id)
          const now = new Date().toISOString()
          return {
            ...record,
            staged: record.staged.map(candidate => candidate.id === id
              ? { ...candidate, blockedReason: 'capture-contract', neededEvidence: issues }
              : candidate),
            updatedAt: now,
          }
        })
        throw stagedBlocked(id, issues)
      }
    }
    const resolved = this.resolved
    const addTargets = await this.stagedAddTargets(located.record, located.entry)
    // A decision batch is the one memory op whose content other stores
    // derive from, so the batch and the artifacts it addressed are captured
    // here, before the write chain, and published once the write is durable.
    const batch: EvolutionDecisionsApplied | undefined = located.entry.kind === 'memory' && located.entry.op === 'applyDecisions'
      ? {
        // The located scope is the table key the entry was found under;
        // consumers read records, so the batch carries the scope identity.
        scopeId: scopeIdFromStorageKey(located.scope),
        sessionId: located.entry.originSessionId,
        decisions: requiredDecisions(stagedFields(located.entry.payload, located.entry.op)),
        artifacts: located.record.agentLessons,
      }
      : undefined
    await this.requireTable().update(located.scope, (record) => {
      const target = record.staged.find(candidate => candidate.id === id)
      if (target === undefined) throw stagedNotFound(id)
      const now = new Date().toISOString()
      const remaining = record.staged.filter(candidate => candidate.id !== id)
      const resolutions = withResolution(record.resolutions, target, 'approved', now, resolved.maxResolutions)
      if (target.kind === 'skill') return { ...record, staged: remaining, resolutions, updatedAt: now }
      const applied = applyMemoryStagedOp(record, target, resolved, addTargets)
      const stamped = applied.family === null ? applied.record : stampFamily(applied.record, applied.family, now)
      return { ...stamped, staged: remaining, resolutions, updatedAt: now }
    })
    if (batch !== undefined) this.publish(batch)
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
   * Mark one pending staged write as blocked, keeping it pending. A blocked
   * entry remembers why approval cannot proceed and what evidence would
   * unblock it, so the same proposal is not silently retried. Re-blocking
   * overwrites the previous reason; approving or rejecting clears it by
   * removing the entry.
   * @param id - staged entry identity.
   * @param reason - short block code, e.g. `capture-contract`.
   * @param neededEvidence - evidence that would unblock approval.
   */
  async blockStaged(id: string, reason: string, neededEvidence: readonly string[]): Promise<void> {
    if (reason.length === 0) throw new Error('evolution-memory: blocked reason must be non-empty')
    const located = this.findStaged(id)
    if (located === undefined) throw stagedNotFound(id)
    await this.requireTable().update(located.scope, (record) => {
      if (record.staged.every(candidate => candidate.id !== id)) throw stagedNotFound(id)
      const now = new Date().toISOString()
      return {
        ...record,
        staged: record.staged.map(candidate => candidate.id === id
          ? { ...candidate, blockedReason: reason, neededEvidence: [...neededEvidence] }
          : candidate),
        updatedAt: now,
      }
    })
  }

  /**
   * Attach a capture contract to one pending skill proposal. The contract
   * must be fully valid to land; a rejected supply leaves the entry
   * untouched. A valid supply lifts the block, but the entry still needs an
   * explicit approval.
   * @param id - staged entry identity.
   * @param contract - the admission evidence to attach.
   */
  async supplyStagedContract(id: string, contract: unknown): Promise<void> {
    const verdict = validateCaptureContract(contract)
    if (!verdict.ok) {
      throw new Error(`evolution-memory: staged contract is missing evidence: ${verdict.issues.join('; ')}`)
    }
    const located = this.findStaged(id)
    if (located === undefined) throw stagedNotFound(id)
    if (located.entry.kind !== 'skill') {
      throw new Error(`evolution-memory: staged entry '${id}' is not a skill proposal`)
    }
    await this.requireTable().update(located.scope, (record) => {
      const target = record.staged.find(candidate => candidate.id === id)
      if (target === undefined) throw stagedNotFound(id)
      const current = target.payload
      if (typeof current !== 'object' || current === null || Array.isArray(current)) {
        throw new Error(`evolution-memory: staged skill proposal '${id}' payload must be an object to carry a contract`)
      }
      const now = new Date().toISOString()
      return {
        ...record,
        staged: record.staged.map(candidate => candidate.id === id
          ? { ...candidate, payload: { ...current, contract: contractJson(verdict.contract) }, blockedReason: null, neededEvidence: [] }
          : candidate),
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
   * Resolve the merge targets a staged memory write folds new content into,
   * before the write chain is entered: the similarity lookup awaits the
   * embeddings seam, and the table update runs its callback synchronously.
   * @param record - the owning scope's current record.
   * @param entry - the staged entry being approved.
   * @returns a positional list: one selected target per `addArtifact`
   * candidate or per `applyDecisions` decision, and an empty list for every
   * other op.
   */
  private async stagedAddTargets(
    record: EvolutionMemoryRecord,
    entry: StagedWrite,
  ): Promise<readonly (LessonArtifact | undefined)[]> {
    if (entry.kind !== 'memory') return []
    const fields = stagedFields(entry.payload, entry.op)
    if (entry.op === 'addArtifact') {
      if (mergeStrategyField(fields.strategy) === 'keep_both') return [undefined]
      return [await this.pickTarget(lessonArtifactInput.parse(fields.candidate), record.agentLessons)]
    }
    if (entry.op === 'applyDecisions') {
      return await this.decisionAddTargets(record.agentLessons, requiredDecisions(fields))
    }
    return []
  }

  /**
   * Resolve the merge target of every `new` decision in one batch, measured
   * against a record read before the write chain. A decision that is not
   * `new` resolves nothing, and neither does a `new` decision under
   * `keep_both`, whose add stores nothing once it meets a taken identity.
   * @param artifacts - the scope's artifacts as the batch's caller read them.
   * @param decisions - the validated batch, in reported order.
   * @returns one entry per decision: the selected target, or undefined.
   */
  private async decisionAddTargets(
    artifacts: readonly LessonArtifact[],
    decisions: readonly LessonDecision[],
  ): Promise<readonly (LessonArtifact | undefined)[]> {
    const targets: (LessonArtifact | undefined)[] = []
    for (const decision of decisions) {
      targets.push(
        decision.kind !== 'new' || decision.strategy === 'keep_both'
          ? undefined
          : await this.pickTarget(decision.candidate, artifacts),
      )
    }
    return targets
  }

  /**
   * Select the artifact one candidate folds into under the configured
   * similarity floor.
   * @param candidate - validated caller-supplied artifact fields.
   * @param artifacts - the artifacts to match against.
   * @returns the selected artifact, or undefined when nothing is close enough.
   */
  private async pickTarget(
    candidate: LessonArtifactInput,
    artifacts: readonly LessonArtifact[],
  ): Promise<LessonArtifact | undefined> {
    return pickMergeTarget(candidate, artifacts, await this.similarities(candidate, artifacts), this.resolved.mergeSimilarityFloor)
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

  /**
   * Publish one landed decision batch to deriving consumers. The write that
   * published it is already durable, so a listener that throws is logged
   * rather than propagated: a consumer's failure must not turn a stored batch
   * into a rejected call and invite the caller to repeat it.
   * @param batch - the scope, source session, decisions, and artifacts to publish.
   */
  private publish(batch: EvolutionDecisionsApplied): void {
    try {
      this.ctx.emit('evolution/decisions-applied', batch)
    } catch (error) {
      this.ctx.logger.warn(`evolution-memory: decisions-applied listener failed: ${String(error)}`)
    }
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
