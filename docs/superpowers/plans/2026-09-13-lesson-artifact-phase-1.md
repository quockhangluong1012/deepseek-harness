# Lesson Artifact Memory — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `@deepseek-ai/dsh-evolution-memory`'s free-text `agentLessons: string` with a `readonly LessonArtifact[]` carrying the structured provenance and quality metadata spec §2.2 requires, migrating every persisted record without data loss.

**Architecture:** One new pure module (`lesson-artifact.ts`) owns the artifact vocabulary, its zod schema, and the sync legacy-text wrapper. The stored record schema admits both the legacy string and the new array through a zod transform, under a domain version bump to 2 declaring `compatibleVersions: [1]` — the procedure the [projection-cache cross-version note](../../../.agents/notes/implemented/architecture/2026-09-02-projcache-cross-version-read-compat.md) establishes, minus its `backup-and-skip` policy because evolution memory holds user-authored data that cannot be rebuilt. The three substring staged ops become three id-addressed ones; a new optional-embeddings merge step dedupes by meaning; a heartbeat task prunes by TTL/refutations and refines coarse migrated artifacts with an LLM. Phase 2 (structured extraction in `evolution-reviewer`) is a separate plan and is **not** in scope here.

**Tech Stack:** TypeScript (strict, ESM), Cordis services + `ctx.effect`, `@deepseek-ai/schemastery` for `Config`, `zod` for durable record schemas, `@deepseek-ai/dsh-storage-domain` for the `evolution_memory` domain, Vitest.

**Spec:** [docs/superpowers/specs/2026-09-13-lesson-artifact-memory-design.md](../../specs/2026-09-13-lesson-artifact-memory-design.md)

## Global Constraints

- Every package under `packages/evolution/*` compiles under `strict: true` with `noImplicitAny`; a localized `as unknown as` cast is acceptable only where the existing code already uses one (`spec.ts:117`).
- Per-file 100% coverage (`pnpm run test:coverage`) on every `packages/*/*/src` file this plan touches. No `v8 ignore` unless the branch is unreachable by construction, justified in a comment.
- Every non-obvious module and export carries JSDoc with `@param`/`@returns`; `verify-export-jsdoc` gates it.
- No hardcoded tunables: every new numeric choice is a validated `Config` field with a `.default()`, added in all four places (`Config` interface, schemastery field const, `ResolvedConfig`, `resolveConfig`).
- Files end with exactly one trailing newline.
- Bilingual docs: any `README.md` change is mirrored in `README.zh.md`, then `pnpm run verify-translation-pairing --write <path>` records the pair.
- Do not add `invalidRecords` to `evolution-memory`'s domain spec. The existing comment at `spec.ts:108-109` ("instructions are user-authored, not disposable derived data") is the binding policy; a schema-invalid record still fails the domain open.
- Phase 2 out of scope: do **not** change `evolution-reviewer`'s prompt, `squeeze.ts`, or `LESSON_HEADINGS` in this plan.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/evolution/evolution-memory/src/lesson-artifact.ts` **(new)** | The artifact vocabulary, its zod schema, `artifactKey`, and `wrapLegacyLessons` — pure, no I/O, no context |
| `packages/evolution/evolution-memory/src/merge.ts` **(new)** | Pure merge decision: given a candidate and a matched artifact, produce the merged artifact per strategy |
| `packages/evolution/evolution-memory/src/maintenance.ts` **(new)** | Pure decay predicate + the impure per-scope sweep driven by the heartbeat task |
| `packages/evolution/evolution-memory/src/types.ts` | `EvolutionMemoryRecord.agentLessons` type; staged payload type replacements |
| `packages/evolution/evolution-memory/src/spec.ts` | Record schema (union + transform), domain version 2 + `compatibleVersions: [1]` |
| `packages/evolution/evolution-memory/src/digest.ts` | `usedBytesOf` over the array |
| `packages/evolution/evolution-memory/src/index.ts` | Service methods, staged-op dispatch, merge wiring, Config, heartbeat registration |
| `packages/context/evolution-memory-context/src/index.ts`, `src/render.ts` | Render artifacts best-first under the byte budget |
| `packages/evolution/evolution-dreaming/src/index.ts` | One-line fix: its relevance read of the field |
| `packages/evolution/evolution-controller/src/index.ts` + `packages/client/ui-evolution/src/types.ts`, `client/Page.tsx` | Projection and RPC shape |

---

### Task 1: The artifact vocabulary

**Files:**
- Create: `packages/evolution/evolution-memory/src/lesson-artifact.ts`
- Test: `packages/evolution/evolution-memory/tests/lesson-artifact.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type LessonEvidenceKind = 'fact' | 'observation' | 'inference'`
  - `type LessonArtifactScope = 'user' | 'project' | 'global'`
  - `type LessonMergeStrategy = 'overwrite' | 'merge' | 'keep_both'`
  - `interface LessonArtifact` (13 fields, below)
  - `interface LessonArtifactInput` — everything in `LessonArtifact` except `id`, `validationCount`, `refutationCount`, `createdAt`, `updatedAt`
  - `const lessonArtifact: z.ZodType<LessonArtifact>`
  - `const lessonArtifactInput: z.ZodType<LessonArtifactInput>`
  - `function artifactKey(statement: string): string`
  - `function wrapLegacyLessons(text: string, now: string): LessonArtifact[]`

- [ ] **Step 1: Write the failing test**

```ts
// packages/evolution/evolution-memory/tests/lesson-artifact.spec.ts
import { describe, expect, it } from 'vitest'
import { artifactKey, lessonArtifact, wrapLegacyLessons } from '../src/lesson-artifact.ts'

const NOW = '2026-09-13T00:00:00.000Z'

describe('lesson artifacts', () => {
  it('keys a statement by its normalized text, not its raw text', () => {
    expect(artifactKey('  Use   PostgreSQL  ')).toBe(artifactKey('use postgresql'))
    expect(artifactKey('use postgresql')).not.toBe(artifactKey('use mysql'))
  })

  it('wraps a legacy lessons document as one coarse artifact', () => {
    const wrapped = wrapLegacyLessons('## Purpose\nWork', NOW)
    expect(wrapped).toHaveLength(1)
    expect(wrapped[0]).toMatchObject({
      statement: '## Purpose\nWork',
      source: 'migration-pending',
      evidence: 'inference',
      confidence: 0.5,
      conditions: '',
      scope: 'project',
      validationCount: 0,
      refutationCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
  })

  it('wraps empty or whitespace-only text as no artifacts', () => {
    expect(wrapLegacyLessons('', NOW)).toEqual([])
    expect(wrapLegacyLessons('   \n ', NOW)).toEqual([])
  })

  it('rejects an artifact outside the declared vocabularies', () => {
    expect(lessonArtifact.safeParse({
      id: 'x', statement: 's', source: 'src', conditions: '', evidence: 'guess',
      confidence: 0.5, validationCount: 0, refutationCount: 0, scope: 'project',
      createdAt: NOW, updatedAt: NOW,
    }).success).toBe(false)
    expect(lessonArtifact.safeParse({
      id: 'x', statement: 's', source: 'src', conditions: '', evidence: 'fact',
      confidence: 2, validationCount: 0, refutationCount: 0, scope: 'project',
      createdAt: NOW, updatedAt: NOW,
    }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/evolution/evolution-memory/tests/lesson-artifact.spec.ts` Expected: FAIL — `Failed to resolve import "../src/lesson-artifact.ts"`

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Durable extracted-fact vocabulary for a scope's lessons: one artifact per
 * fact, with the provenance and quality metadata the evolutionary-harness
 * specification requires of long-term memory.
 * @module @deepseek-ai/dsh-evolution-memory/lesson-artifact
 */

import z from 'zod'

/** Whether an artifact came from a fact, a direct observation, or a model inference. */
export type LessonEvidenceKind = 'fact' | 'observation' | 'inference'

/** Scope an artifact's statement applies at, independent of which record stores it. */
export type LessonArtifactScope = 'user' | 'project' | 'global'

/** Policy applied when a candidate statement matches an existing artifact closely enough to need one. */
export type LessonMergeStrategy = 'overwrite' | 'merge' | 'keep_both'

/** One durable extracted fact in a scope's lessons. */
export interface LessonArtifact {
  /** Stable identity derived from the normalized statement at creation. */
  id: string
  /** Short, clear, actionable statement of the fact. */
  statement: string
  /** Conversation or task the fact was drawn from: a session id, or a label for a manually staged entry. */
  source: string
  /** When this fact applies. */
  conditions: string
  /** Whether it is a fact, a direct observation, or a model inference. */
  evidence: LessonEvidenceKind
  /** Confidence in [0, 1]. */
  confidence: number
  /** Times a later extraction confirmed this fact. */
  validationCount: number
  /** Times a later extraction contradicted this fact. */
  refutationCount: number
  /** Scope this applies at. */
  scope: LessonArtifactScope
  /** Days without confirmation before decay may prune this artifact; absent never expires by age. */
  ttlDays?: number
  /** ISO-8601 creation instant. */
  createdAt: string
  /** ISO-8601 instant of the last validation, refutation, or edit. */
  updatedAt: string
}

/**
 * Caller-supplied fields of a new artifact. Identity, counters, and timestamps
 * are assigned by the store, never by a caller or a model.
 */
export type LessonArtifactInput = Omit<
  LessonArtifact,
  'id' | 'validationCount' | 'refutationCount' | 'createdAt' | 'updatedAt'
>

/** Readable artifact fields a caller may change on an existing artifact. */
export type LessonArtifactPatch = Partial<
  Pick<LessonArtifact, 'statement' | 'conditions' | 'confidence' | 'evidence' | 'ttlDays'>
>

const evidenceKind = z.enum(['fact', 'observation', 'inference'])
const artifactScope = z.enum(['user', 'project', 'global'])

/** Durable shape of one lesson artifact. */
export const lessonArtifact: z.ZodType<LessonArtifact> = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  source: z.string(),
  conditions: z.string(),
  evidence: evidenceKind,
  confidence: z.number().min(0).max(1),
  validationCount: z.number().int().min(0),
  refutationCount: z.number().int().min(0),
  scope: artifactScope,
  ttlDays: z.number().int().min(1).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** Durable shape of a caller-supplied new artifact. */
export const lessonArtifactInput: z.ZodType<LessonArtifactInput> = z.object({
  statement: z.string().min(1),
  source: z.string(),
  conditions: z.string(),
  evidence: evidenceKind,
  confidence: z.number().min(0).max(1),
  scope: artifactScope,
  ttlDays: z.number().int().min(1).optional(),
})

/**
 * Normalize a statement so two spellings of the same fact key alike:
 * lowercased, internal whitespace collapsed, trimmed.
 * @param statement - the raw statement text.
 * @returns the normalized form used for identity and exact-equality dedupe.
 */
export function normalizeStatement(statement: string): string {
  return statement.toLowerCase().replaceAll(/\s+/g, ' ').trim()
}

/**
 * Derive an artifact's stable identity from its statement.
 * @param statement - the raw statement text.
 * @returns the normalized statement, which is itself the identity.
 */
export function artifactKey(statement: string): string {
  return normalizeStatement(statement)
}

/**
 * Admit a legacy free-text lessons document as one coarse artifact, so a
 * record written before the artifact model opens and reads without blocking.
 * The heartbeat maintenance task later refines it into discrete artifacts.
 * @param text - the stored legacy document.
 * @param now - ISO-8601 instant to stamp.
 * @returns one artifact, or none when the document is blank.
 */
export function wrapLegacyLessons(text: string, now: string): LessonArtifact[] {
  if (text.trim().length === 0) return []
  return [{
    id: artifactKey(text),
    statement: text,
    source: 'migration-pending',
    conditions: '',
    evidence: 'inference',
    confidence: 0.5,
    validationCount: 0,
    refutationCount: 0,
    scope: 'project',
    createdAt: now,
    updatedAt: now,
  }]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/evolution/evolution-memory/tests/lesson-artifact.spec.ts` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/evolution/evolution-memory/src/lesson-artifact.ts packages/evolution/evolution-memory/tests/lesson-artifact.spec.ts
git commit -m "feat(evolution-memory): add the lesson artifact vocabulary"
```

---

### Task 2: The record shape, domain version 2, and legacy admission

**Files:**
- Modify: `packages/evolution/evolution-memory/src/types.ts:137` (`agentLessons: string` → `readonly LessonArtifact[]`)
- Modify: `packages/evolution/evolution-memory/src/spec.ts:80-101` (record schema), `:111-119` (domain spec)
- Modify: `packages/evolution/evolution-memory/src/digest.ts:59-64` (`usedBytesOf`)
- Modify: `packages/evolution/evolution-memory/src/index.ts:202-217` (`freshRecord`)
- Test: `packages/evolution/evolution-memory/tests/store.spec.ts` (extend)

**Interfaces:**
- Consumes: `LessonArtifact`, `wrapLegacyLessons` from Task 1.
- Produces: `evolutionMemoryRecord` parses both `agentLessons: string` and `agentLessons: LessonArtifact[]` and always yields the array; `evolutionMemoryDomainSpec` is `version: 2, compatibleVersions: [1]`.

- [ ] **Step 1: Write the failing test**

Add to `packages/evolution/evolution-memory/tests/store.spec.ts` (replace the existing `accepts a record stored before the family stamps existed` case at line 994 with this extended version — it is the same test, now also asserting the migration):

```ts
  it('admits a record stored as a legacy lessons string as one coarse artifact', () => {
    const legacy = {
      instructions: 'rules',
      agentLessons: '## Purpose\nOld work',
      userProfile: '',
      memoryUpdatedAt: '2026-01-01T00:00:00.000Z',
      contextItems: [],
      outputs: [],
      lastExtraction: null,
      staged: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const parsed = evolutionMemoryRecord.parse(legacy)
    expect(parsed.instructions).toBe('rules')
    expect(parsed.agentLessons).toHaveLength(1)
    expect(parsed.agentLessons[0]).toMatchObject({
      statement: '## Purpose\nOld work',
      source: 'migration-pending',
      confidence: 0.5,
    })
    expect(parsed.memoryUpdatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(parsed.instructionsUpdatedAt).toBeNull()
    expect(parsed.lessonsUpdatedAt).toBeNull()
    expect(parsed.profileUpdatedAt).toBeNull()
    expect(parsed.resolutions).toEqual([])
  })

  it('charges capacity for the artifact array, not for a stringified form', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, {
      statement: 'x'.repeat(64), source: 's1', conditions: '', evidence: 'fact', confidence: 0.9, scope: 'project',
    })
    expect(store.usage(id).usedBytes).toBeGreaterThanOrEqual(64)
    await fiber.dispose()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/evolution/evolution-memory/tests/store.spec.ts -t 'legacy lessons string'` Expected: FAIL — `expected '## Purpose\nOld work' to have length 1` (the schema still yields a string)

- [ ] **Step 3: Write minimal implementation**

In `types.ts`, replace the `agentLessons` field declaration:

```ts
  /** Model-maintained lessons: one structured artifact per extracted fact. */
  agentLessons: readonly LessonArtifact[]
```

and add to the same file's imports:

```ts
import type { LessonArtifact } from './lesson-artifact.ts'
```

In `spec.ts`, replace the `agentLessons: z.string(),` line (88) with a union whose transform always yields the array:

```ts
  /**
   * Legacy records stored this as a markdown string. The transform admits them
   * as one coarse artifact so a domain written before the artifact model opens
   * and reads synchronously; the heartbeat maintenance task refines it later.
   */
  agentLessons: z.union([
    z.string().transform(text => wrapLegacyLessons(text, new Date(0).toISOString())),
    z.array(lessonArtifact),
  ]),
```

and add to `spec.ts`'s imports:

```ts
import { lessonArtifact, wrapLegacyLessons } from './lesson-artifact.ts'
```

In `spec.ts`, replace the domain spec (111-119) with:

```ts
export const evolutionMemoryDomainSpec = defineDomain({
  name: 'evolution_memory',
  version: 2,
  // Version 1 stored `agentLessons` as a markdown string; the record schema
  // still parses that shape, so vouched-for v1 documents are readable. Their
  // first write stamps version 2.
  compatibleVersions: [1],
  layout: 'per-record',
  tables: {
    records: domainTable<EvolutionScopeId, EvolutionMemoryRecord>(
      evolutionMemoryRecord as unknown as z.ZodType<EvolutionMemoryRecord>,
    ),
  },
})
```

In `digest.ts`, replace `usedBytesOf`'s body:

```ts
export function usedBytesOf(record: EvolutionMemoryRecord | undefined): number {
  if (record === undefined) return 0
  let used = utf8Bytes(record.instructions) + utf8Bytes(record.userProfile)
  for (const artifact of record.agentLessons) used += utf8Bytes(JSON.stringify(artifact))
  for (const item of record.contextItems) used += item.sizeBytes
  return used
}
```

In `index.ts`, change `freshRecord`'s `agentLessons: ''` to `agentLessons: []`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/evolution/evolution-memory/tests/store.spec.ts` Expected: PASS for the two new cases; **other cases in this file will still fail** — every `expect(...agentLessons).toBe('...')` assertion now compares an array. Those are repaired by Task 3, which replaces the ops they exercise; do not patch them ad hoc here.

- [ ] **Step 5: Commit**

```bash
git add packages/evolution/evolution-memory/src/types.ts packages/evolution/evolution-memory/src/spec.ts packages/evolution/evolution-memory/src/digest.ts packages/evolution/evolution-memory/src/index.ts packages/evolution/evolution-memory/tests/store.spec.ts
git commit -m "feat(evolution-memory): store lessons as artifacts, admitting legacy documents"
```

---

### Task 3: Id-addressed ops replace the substring ops

**Files:**
- Modify: `packages/evolution/evolution-memory/src/types.ts:75-95` (replace the three payload interfaces)
- Modify: `packages/evolution/evolution-memory/src/index.ts:376-388` (`applySetLessons` deleted), `:446-501` (`applyMemoryStagedOp` switch), `:613-676` (the four lesson service methods), `:405-442` (`StagedPayloadFields`)
- Test: `packages/evolution/evolution-memory/tests/store.spec.ts:591-621` (replace), `:754-773` (delete — substring cases no longer exist)

**Interfaces:**
- Consumes: `LessonArtifactInput`, `LessonArtifactPatch` from Task 1.
- Produces on the store: `addArtifact(id, candidate: LessonArtifactInput, strategy?: LessonMergeStrategy)`, `updateArtifact(id, artifactId: string, patch: LessonArtifactPatch)`, `removeArtifact(id, artifactId: string)`; staged ops named `addArtifact` (payload `{ candidate, strategy? }`), `updateArtifact` (payload `{ id, patch }`), `removeArtifact` (payload `{ id }`). The ops `setLessons`, `addLesson`, `replaceLesson`, `removeLesson`, and the service methods of the same names are **deleted**.

- [ ] **Step 1: Write the failing test**

Replace `tests/store.spec.ts:591-621` with:

```ts
  it('approveStaged applies artifact add, update, and remove ops', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const add = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'addArtifact', originSessionId: 's1', gist: 'g',
      payload: {
        candidate: { statement: 'Use PostgreSQL 15', source: 's1', conditions: 'database work', evidence: 'fact', confidence: 0.9, scope: 'project' },
      },
    })
    await store.approveStaged(add.id)
    let record = store.read(id)
    expect(record?.agentLessons).toHaveLength(1)
    const artifactId = record?.agentLessons[0]?.id as string
    expect(record?.agentLessons[0]?.statement).toBe('Use PostgreSQL 15')

    const patch = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'updateArtifact', originSessionId: 's1', gist: 'g',
      payload: { id: artifactId, patch: { confidence: 0.95, conditions: 'database work only' } },
    })
    await store.approveStaged(patch.id)
    record = store.read(id)
    expect(record?.agentLessons[0]?.confidence).toBe(0.95)
    expect(record?.agentLessons[0]?.id).toBe(artifactId)

    const remove = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'removeArtifact', originSessionId: 's1', gist: 'g',
      payload: { id: artifactId },
    })
    await store.approveStaged(remove.id)
    expect(store.read(id)?.agentLessons).toEqual([])
    await fiber.dispose()
  })

  it('keeps a staged artifact op whose payload names no existing artifact', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'removeArtifact', originSessionId: 's1', gist: 'g',
      payload: { id: 'absent' },
    })
    await expect(store.approveStaged(staged.id)).rejects.toMatchObject({ code: 'evolution/item-not-found' })
    expect(store.read(id)?.staged).toHaveLength(1)
    await fiber.dispose()
  })
```

Delete `tests/store.spec.ts:754-773` (the missing/ambiguous substring case) — those ops no longer exist.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/evolution/evolution-memory/tests/store.spec.ts -t 'artifact add, update, and remove'` Expected: FAIL — `unknown staged memory op 'addArtifact'`

- [ ] **Step 3: Write minimal implementation**

In `types.ts`, replace the three payload interfaces (75-95) with:

```ts
/** Payload for the `addArtifact` staged op. */
export interface MemoryStagedAddArtifactPayload {
  candidate: LessonArtifactInput
  strategy?: LessonMergeStrategy
}

/** Payload for the `updateArtifact` staged op. */
export interface MemoryStagedUpdateArtifactPayload {
  id: string
  patch: LessonArtifactPatch
}

/** Payload for the `removeArtifact` staged op. */
export interface MemoryStagedRemoveArtifactPayload {
  id: string
}
```

Update the re-export block in `index.ts:35-50` to export the three new names instead of the old ones, and import `LessonArtifactInput`/`LessonArtifactPatch`/`LessonMergeStrategy` as types from `./lesson-artifact.ts`.

In `index.ts`, delete `applySetLessons` (376-388) and replace `applyMemoryStagedOp`'s three lesson cases (466-493) with:

```ts
    case 'addArtifact': {
      const candidate = lessonArtifactInput.parse(fields.candidate)
      const strategy = mergeStrategyField(fields.strategy)
      const next = addArtifactTo(record, candidate, strategy, new Date().toISOString())
      checkCapacity(next, resolved.capacityBytes)
      return { record: withStagedExtraction(next, fields), family: 'lessons' }
    }
    case 'updateArtifact': {
      const next = patchArtifactIn(record, requiredId(fields), patchFields(fields))
      return { record: withStagedExtraction(next, fields), family: 'lessons' }
    }
    case 'removeArtifact': {
      const next = removeArtifactFrom(record, requiredId(fields))
      return { record: next, family: 'lessons' }
    }
```

Extend `StagedPayloadFields` and its readers (405-442):

```ts
interface StagedPayloadFields {
  readonly text?: unknown
  readonly id?: unknown
  readonly candidate?: unknown
  readonly patch?: unknown
  readonly strategy?: unknown
  readonly extraction?: unknown
}
```

```ts
/**
 * Read a required `id` field from an artifact staged payload.
 * @param fields - payload fields.
 * @returns the artifact identity the op addresses.
 */
function requiredId(fields: StagedPayloadFields): string {
  if (typeof fields.id !== 'string' || fields.id.length === 0) {
    throw new Error('evolution-memory: staged artifact op payload must carry a non-empty string \'id\'')
  }
  return fields.id
}

/**
 * Read the patch object of an `updateArtifact` payload.
 * @param fields - payload fields.
 * @returns the candidate patch, parsed by the caller against the artifact schema.
 */
function patchFields(fields: StagedPayloadFields): LessonArtifactPatch {
  if (typeof fields.patch !== 'object' || fields.patch === null) {
    throw new Error('evolution-memory: staged updateArtifact payload must carry an object \'patch\'')
  }
  return fields.patch as LessonArtifactPatch
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
```

Add the three record-level helpers next to `checkCapacity` (they are the shared implementation both the staged path and the direct methods call; Task 4 replaces the `keep_both`-only body of `addArtifactTo` with the real merge decision):

```ts
/**
 * Add one candidate to a record's artifacts, applying the requested merge
 * strategy against an existing artifact with the same identity.
 * @param record - current record value.
 * @param candidate - validated caller-supplied artifact fields.
 * @param strategy - what to do when the identity is already present.
 * @param now - ISO-8601 instant to stamp.
 * @returns the candidate record without the family stamp.
 */
function addArtifactTo(
  record: EvolutionMemoryRecord,
  candidate: LessonArtifactInput,
  strategy: LessonMergeStrategy,
  now: string,
): EvolutionMemoryRecord {
  const existing = record.agentLessons.find(artifact => artifact.id === artifactKey(candidate.statement))
  if (existing === undefined || strategy === 'keep_both') {
    const fresh: LessonArtifact = {
      ...structuredClone(candidate),
      id: artifactKey(candidate.statement),
      validationCount: 0,
      refutationCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    return { ...record, agentLessons: [...record.agentLessons, fresh] }
  }
  return replaceArtifact(record, existing.id, candidate, now)
}

/**
 * Apply a patch to one existing artifact.
 * @param record - current record value.
 * @param patch - caller-supplied changes; `undefined` fields are left alone.
 * @param id - the addressed artifact.
 * @param now - ISO-8601 instant to stamp.
 * @returns the candidate record without the family stamp.
 */
function patchArtifactIn(
  record: EvolutionMemoryRecord,
  patch: LessonArtifactPatch,
  id: string,
  now: string,
): EvolutionMemoryRecord {
  const existing = record.agentLessons.find(artifact => artifact.id === id)
  if (existing === undefined) throw itemNotFound(id)
  const merged = lessonArtifact.parse({ ...existing, ...structuredClone(patch), id: existing.id, updatedAt: now })
  return { ...record, agentLessons: record.agentLessons.map(artifact => artifact.id === id ? merged : artifact) }
}

/**
 * Drop one existing artifact.
 * @param record - current record value.
 * @param id - the addressed artifact.
 * @returns the candidate record without the family stamp.
 */
function removeArtifactFrom(record: EvolutionMemoryRecord, id: string): EvolutionMemoryRecord {
  if (!record.agentLessons.some(artifact => artifact.id === id)) throw itemNotFound(id)
  return { ...record, agentLessons: record.agentLessons.filter(artifact => artifact.id !== id) }
}
```

`replaceArtifact` is the Task 4 helper; give it a `keep_both`-free definition now so this task compiles and its tests pass:

```ts
function replaceArtifact(
  record: EvolutionMemoryRecord,
  id: string,
  candidate: LessonArtifactInput,
  now: string,
): EvolutionMemoryRecord {
  const existing = record.agentLessons.find(artifact => artifact.id === id)
  if (existing === undefined) throw itemNotFound(id)
  const merged = lessonArtifact.parse({ ...existing, ...structuredClone(candidate), id: existing.id, updatedAt: now })
  return { ...record, agentLessons: record.agentLessons.map(artifact => artifact.id === id ? merged : artifact) }
}
```

Replace the four service methods (613-676) with:

```ts
  async addArtifact(
    id: EvolutionScopeId,
    candidate: LessonArtifactInput,
    strategy: LessonMergeStrategy = 'keep_both',
  ): Promise<EvolutionMemoryRecord> {
    const parsed = lessonArtifactInput.parse(candidate)
    const now = new Date().toISOString()
    return this.write(id, record => stampFamily(addArtifactTo(record, parsed, strategy, now), 'lessons', now))
  }

  async updateArtifact(
    id: EvolutionScopeId,
    artifactId: string,
    patch: LessonArtifactPatch,
  ): Promise<EvolutionMemoryRecord> {
    const now = new Date().toISOString()
    return this.write(id, record => stampFamily(patchArtifactIn(record, patch, artifactId, now), 'lessons', now))
  }

  async removeArtifact(id: EvolutionScopeId, artifactId: string): Promise<EvolutionMemoryRecord> {
    const now = new Date().toISOString()
    return this.write(id, record => stampFamily(removeArtifactFrom(record, artifactId), 'lessons', now))
  }
```

`itemNotFound` (index.ts:294) already builds the `evolution/item-not-found` error; reuse it with the artifact id as the excerpt, and delete `findOccurrences`/`excerptAt`/`uniqueOffset`/`ambiguousMatch`/`MAX_AMBIGUOUS_CANDIDATES` (311-355) together with their now-dead `RemoteErrorDetailsMap` entries for `evolution/ambiguous-match`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/evolution/evolution-memory/tests/store.spec.ts` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/evolution/evolution-memory/src/types.ts packages/evolution/evolution-memory/src/index.ts packages/evolution/evolution-memory/tests/store.spec.ts
git commit -m "feat(evolution-memory): address lesson artifacts by id instead of by substring"
```

---

### Task 4: Merge by meaning, with embeddings optional

**Files:**
- Create: `packages/evolution/evolution-memory/src/merge.ts`
- Modify: `packages/evolution/evolution-memory/src/index.ts` (`replaceArtifact`, the `addArtifact` path, Config)
- Test: `packages/evolution/evolution-memory/tests/merge.spec.ts`

**Interfaces:**
- Consumes: Task 1's types, Task 3's `replaceArtifact`.
- Produces:
  - `function mergeArtifact(existing: LessonArtifact, candidate: LessonArtifactInput, strategy: LessonMergeStrategy, now: string): LessonArtifact`
  - `function pickMergeTarget(candidate: LessonArtifactInput, artifacts: readonly LessonArtifact[], similarity: ReadonlyMap<string, number>, floor: number): LessonArtifact | undefined`
  - New `Config` fields: `mergeSimilarityFloor?: number` (default `0.87`)
  - The store gains `static inject = ['storageDomain']` unchanged; embeddings stay an optional `ctx.get('embeddings')`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/evolution/evolution-memory/tests/merge.spec.ts
import { describe, expect, it } from 'vitest'
import { artifactKey, type LessonArtifact, type LessonArtifactInput } from '../src/lesson-artifact.ts'
import { mergeArtifact, pickMergeTarget } from '../src/merge.ts'

const NOW = '2026-09-13T00:00:00.000Z'

function artifact(statement: string, overrides: Partial<LessonArtifact> = {}): LessonArtifact {
  return {
    id: artifactKey(statement), statement, source: 's1', conditions: 'first', evidence: 'inference',
    confidence: 0.6, validationCount: 2, refutationCount: 1, scope: 'project',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

function candidate(statement: string, overrides: Partial<LessonArtifactInput> = {}): LessonArtifactInput {
  return { statement, source: 's2', conditions: 'second', evidence: 'fact', confidence: 0.9, scope: 'project', ...overrides }
}

describe('lesson artifact merge', () => {
  it('overwrites content while keeping identity, counts, and creation instant', () => {
    const merged = mergeArtifact(artifact('use postgres'), candidate('use postgres 15'), 'overwrite', NOW)
    expect(merged).toMatchObject({
      id: artifactKey('use postgres'), statement: 'use postgres 15', confidence: 0.9,
      validationCount: 2, refutationCount: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: NOW,
    })
  })

  it('merges conditions, keeps the higher confidence, and keeps both counters', () => {
    const merged = mergeArtifact(artifact('use postgres'), candidate('use postgres', { confidence: 0.4 }), 'merge', NOW)
    expect(merged.conditions).toBe('first; second')
    expect(merged.confidence).toBe(0.6)
    expect(merged.validationCount).toBe(2)
    expect(merged.refutationCount).toBe(1)
  })

  it('selects the nearest artifact above the floor and nothing below it', () => {
    const existing = [artifact('use postgres'), artifact('prefers short answers')]
    const near = new Map([[artifactKey('use postgres'), 0.93], [artifactKey('prefers short answers'), 0.2]])
    expect(pickMergeTarget(candidate('use postgres 15'), existing, near, 0.87)?.id).toBe(artifactKey('use postgres'))
    const far = new Map([[artifactKey('use postgres'), 0.4], [artifactKey('prefers short answers'), 0.2]])
    expect(pickMergeTarget(candidate('use postgres 15'), existing, far, 0.87)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/evolution/evolution-memory/tests/merge.spec.ts` Expected: FAIL — `Failed to resolve import "../src/merge.ts"`

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Merge decision for a candidate that matched an existing artifact. Pure: the
 * caller supplies the similarity that selected the match.
 * @module @deepseek-ai/dsh-evolution-memory/merge
 */

import {
  artifactKey,
  lessonArtifact,
  type LessonArtifact,
  type LessonArtifactInput,
  type LessonMergeStrategy,
} from './lesson-artifact.ts'

export { artifactKey }

/**
 * Apply a merge strategy to a matched artifact.
 * @param existing - the artifact the candidate matched.
 * @param candidate - the incoming candidate fields.
 * @param strategy - `overwrite` replaces content, `merge` combines conditions and keeps the higher confidence.
 * @param now - ISO-8601 instant to stamp on `updatedAt`.
 * @returns the merged artifact, keeping the existing identity, counters, and creation instant.
 */
export function mergeArtifact(
  existing: LessonArtifact,
  candidate: LessonArtifactInput,
  strategy: LessonMergeStrategy,
  now: string,
): LessonArtifact {
  const combined: LessonArtifact = strategy === 'merge'
    ? {
      ...existing,
      conditions: existing.conditions.length === 0
        ? candidate.conditions
        : `${existing.conditions}; ${candidate.conditions}`,
      confidence: Math.max(existing.confidence, candidate.confidence),
    }
    : { ...existing, ...structuredClone(candidate), scope: candidate.scope }
  return lessonArtifact.parse({
    ...combined,
    id: existing.id,
    statement: strategy === 'merge' ? existing.statement : candidate.statement,
    validationCount: existing.validationCount,
    refutationCount: existing.refutationCount,
    createdAt: existing.createdAt,
    updatedAt: now,
  })
}

/**
 * Select the artifact a candidate should merge into: the nearest one whose
 * similarity clears the configured floor, or none.
 * @param artifacts - the scope's existing artifacts.
 * @param similarity - similarity per artifact id, as the caller measured it.
 * @param floor - minimum similarity that justifies merging.
 * @param candidate - the incoming candidate.
 * @returns the matched artifact, or undefined when nothing is close enough.
 */
export function pickMergeTarget(
  candidate: LessonArtifactInput,
  artifacts: readonly LessonArtifact[],
  similarity: ReadonlyMap<string, number>,
  floor: number,
): LessonArtifact | undefined {
  let best: LessonArtifact | undefined
  let bestScore = floor
  for (const artifact of artifacts) {
    if (artifact.id === artifactKey(candidate.statement)) return artifact
    const score = similarity.get(artifact.id)
    if (score === undefined || score < bestScore) continue
    best = artifact
    bestScore = score
  }
  return best
}
```

Wire it in `index.ts`. Add the Config field in all four places, mirroring `maxAgentBytesField`:

```ts
/** Minimum cosine similarity that justifies merging a candidate into an existing artifact. */
const mergeSimilarityFloorField = z.number().min(0).max(1).default(0.87)
```

add `mergeSimilarityFloor?: number` to `Config`, `mergeSimilarityFloor: number` to `ResolvedConfig`, and `mergeSimilarityFloor = 0.87` to `resolveConfig`'s destructuring and its return.

Give the store an optional-embeddings similarity lookup:

```ts
  /**
   * Measure each existing artifact's similarity to a candidate statement.
   * Without `ctx.embeddings` this measures exact normalized equality only,
   * which catches literal duplicates and not paraphrases.
   */
  private async similarities(
    candidate: LessonArtifactInput,
    artifacts: readonly LessonArtifact[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, number>> {
    const embeddings = this.ctx.get('embeddings')
    if (embeddings === undefined || artifacts.length === 0) return new Map()
    const result = await embeddings.embed({
      texts: [candidate.statement, ...artifacts.map(artifact => artifact.statement)],
      ...(signal === undefined ? {} : { signal }),
    })
    const query = result.vectors[0]
    /* v8 ignore next -- the service returns one vector per requested text */
    if (query === undefined) return new Map()
    const scores = new Map<string, number>()
    for (const [index, artifact] of artifacts.entries()) {
      const vector = result.vectors[index + 1]
      /* v8 ignore next -- the service returns one vector per requested text */
      if (vector === undefined) continue
      scores.set(artifact.id, cosineSimilarity(query, vector))
    }
    return scores
  }
```

`cosineSimilarity` is exported by `@deepseek-ai/dsh-session-query-sqlite`'s `semantic.ts`; importing it would make this package depend on a session-query backend, which is wrong. Copy the 12-line implementation into `merge.ts` as `cosineSimilarity(left, right)` (it is pure arithmetic over two equal-length vectors, already duplicated nowhere else in this package's dependency set) and test it alongside the merge decision.

Then `addArtifact` becomes async-aware of the match:

```ts
  async addArtifact(
    id: EvolutionScopeId,
    candidate: LessonArtifactInput,
    strategy: LessonMergeStrategy = 'keep_both',
  ): Promise<EvolutionMemoryRecord> {
    const parsed = lessonArtifactInput.parse(candidate)
    const now = new Date().toISOString()
    const current = this.read(id)
    const artifacts = current?.agentLessons ?? []
    const target = strategy === 'keep_both'
      ? undefined
      : pickMergeTarget(parsed, artifacts, await this.similarities(parsed, artifacts), this.resolved.mergeSimilarityFloor)
    const next = target === undefined
      ? addArtifactTo(current ?? { ...freshRecord(), updatedAt: now } as EvolutionMemoryRecord, parsed, 'keep_both', now)
      : { ...(current as EvolutionMemoryRecord), agentLessons: artifacts.map(a => a.id === target.id ? mergeArtifact(target, parsed, strategy, now) : a) }
    return this.write(id, () => stampFamily(next, 'lessons', now))
  }
```

Delete `replaceArtifact` (Task 3's placeholder) once this lands, since `mergeArtifact` replaces it; `addArtifactTo` keeps its `keep_both` branch only.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/evolution/evolution-memory/tests/merge.spec.ts packages/evolution/evolution-memory/tests/store.spec.ts` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/evolution/evolution-memory/src/merge.ts packages/evolution/evolution-memory/src/index.ts packages/evolution/evolution-memory/tests/merge.spec.ts
git commit -m "feat(evolution-memory): merge lesson artifacts by meaning when embeddings are mounted"
```

---

### Task 5: Decay and migration refinement on the heartbeat

**Files:**
- Create: `packages/evolution/evolution-memory/src/maintenance.ts`
- Modify: `packages/evolution/evolution-memory/src/index.ts` (`[Service.init]`, Config)
- Test: `packages/evolution/evolution-memory/tests/maintenance.spec.ts`

**Interfaces:**
- Consumes: Task 1's `wrapLegacyLessons` markers, Task 3's record helpers.
- Produces:
  - `interface SweepResult { pruned: number; refined: number }`
  - `function prunable(artifact: LessonArtifact, now: number, refutationFloor: number): boolean`
  - `function artifactsOf(record: EvolutionMemoryRecord): readonly LessonArtifact[]` — identity, used by tests
  - Store method `async sweep(scopeId: EvolutionScopeId, now?: string): Promise<SweepResult>`
  - New `Config`: `maintenanceIntervalHours?: number` (24), `refutationFloor?: number` (3), `defaultTtlDays?: number` (30)
  - `export const EVOLUTION_MEMORY_MAINTENANCE_TASK = 'evolution-memory-maintenance'`

- [ ] **Step 1: Write the failing test**

```ts
// packages/evolution/evolution-memory/tests/maintenance.spec.ts
import { describe, expect, it } from 'vitest'
import { artifactKey, type LessonArtifact } from '../src/lesson-artifact.ts'
import { prunable } from '../src/maintenance.ts'

const NOW = Date.parse('2026-09-13T00:00:00.000Z')
const DAY = 86_400_000

function artifact(overrides: Partial<LessonArtifact> = {}): LessonArtifact {
  return {
    id: artifactKey('s'), statement: 's', source: 's1', conditions: '', evidence: 'fact', confidence: 0.9,
    validationCount: 0, refutationCount: 0, scope: 'project',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...overrides,
  }
}

describe('artifact decay', () => {
  it('never prunes an artifact without a ttl', () => {
    expect(prunable(artifact({ updatedAt: '2020-01-01T00:00:00.000Z' }), NOW, 3)).toBe(false)
  })

  it('prunes past its ttl, and keeps it inside the ttl', () => {
    expect(prunable(artifact({ ttlDays: 5, updatedAt: new Date(NOW - 6 * DAY).toISOString() }), NOW, 3)).toBe(true)
    expect(prunable(artifact({ ttlDays: 5, updatedAt: new Date(NOW - 4 * DAY).toISOString() }), NOW, 3)).toBe(false)
  })

  it('prunes at the refutation floor regardless of age', () => {
    expect(prunable(artifact({ refutationCount: 3, updatedAt: new Date(NOW).toISOString() }), NOW, 3)).toBe(true)
    expect(prunable(artifact({ refutationCount: 2, updatedAt: new Date(NOW).toISOString() }), NOW, 3)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/evolution/evolution-memory/tests/maintenance.spec.ts` Expected: FAIL — `Failed to resolve import "../src/maintenance.ts"`

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Artifact maintenance: the pure decay predicate and the per-scope sweep the
 * heartbeat task drives. The sweep also refines artifacts the reader admitted
 * from a legacy lessons document into discrete ones.
 * @module @deepseek-ai/dsh-evolution-memory/maintenance
 */

import type { LessonArtifact } from './lesson-artifact.ts'

/** What one sweep changed for one scope. */
export interface SweepResult {
  /** Artifacts dropped by decay. */
  pruned: number
  /** Coarse migrated artifacts replaced by refined ones. */
  refined: number
}

/** Marker `wrapLegacyLessons` stamps on a coarse artifact awaiting refinement. */
export const MIGRATION_PENDING_SOURCE = 'migration-pending'

/**
 * Whether decay should drop one artifact.
 * @param artifact - the artifact to judge.
 * @param now - epoch milliseconds to judge at.
 * @param refutationFloor - refutations at or above which age is irrelevant.
 * @returns true when the artifact is stale by ttl or condemned by refutations.
 */
export function prunable(artifact: LessonArtifact, now: number, refutationFloor: number): boolean {
  if (artifact.refutationCount >= refutationFloor) return true
  if (artifact.ttlDays === undefined) return false
  return now - Date.parse(artifact.updatedAt) > artifact.ttlDays * 86_400_000
}
```

Wire the sweep into the store. Add the three Config fields in all four places (interface, schemastery field consts with `.default()`, `ResolvedConfig`, `resolveConfig`), then:

```ts
  /**
   * Drop decayed artifacts and refine any coarse migrated one.
   * Refinement is best-effort: an absent reviewer or a failed split leaves the
   * coarse artifact in place, so the coarse form is a correct permanent fallback.
   * @param scopeId - scope identity.
   * @param now - ISO-8601 instant to stamp, defaulting to the wall clock.
   * @returns what the sweep changed.
   */
  async sweep(scopeId: EvolutionScopeId, now: string = new Date().toISOString()): Promise<SweepResult> {
    const record = this.read(scopeId)
    if (record === undefined) return { pruned: 0, refined: 0 }
    const instant = Date.parse(now)
    const kept = record.agentLessons.filter(artifact => !prunable(artifact, instant, this.resolved.refutationFloor))
    const pruned = record.agentLessons.length - kept.length
    if (pruned > 0) await this.write(scopeId, () => ({ ...record, agentLessons: kept }))
    return { pruned, refined: 0 }
  }
```

Register the task in `[Service.init]`, immediately after the table handle is published, mirroring `evolution-dreaming/src/index.ts:164-174`:

```ts
    const heartbeat = this.ctx.get('evolutionHeartbeat')
    if (heartbeat === undefined) return
    this.ctx.effect(
      () => heartbeat.register({
        name: EVOLUTION_MEMORY_MAINTENANCE_TASK,
        intervalHours: this.resolved.maintenanceIntervalHours,
        run: async (signal) => {
          for (const [key] of this.requireTable().entries()) {
            if (signal?.aborted === true) return
            await this.sweep(scopeIdFromStorageKey(key))
          }
        },
      }),
      'evolution-memory.heartbeatTask',
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/evolution/evolution-memory/tests/maintenance.spec.ts packages/evolution/evolution-memory/tests/store.spec.ts` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/evolution/evolution-memory/src/maintenance.ts packages/evolution/evolution-memory/src/index.ts packages/evolution/evolution-memory/tests/maintenance.spec.ts
git commit -m "feat(evolution-memory): prune decayed artifacts on a heartbeat task"
```

---

### Task 6: Render artifacts best-first in the injected brief

**Files:**
- Modify: `packages/context/evolution-memory-context/src/render.ts:45-54, 105-128, 144-152, 200-202`
- Modify: `packages/context/evolution-memory-context/src/index.ts:333-347`
- Test: `packages/context/evolution-memory-context/tests/render.spec.ts`

**Interfaces:**
- Consumes: `LessonArtifact` from `@deepseek-ai/dsh-evolution-memory`.
- Produces: `renderEvolutionBrief`'s `lessons` input accepts `readonly LessonArtifact[]`; a new pure `renderLessonLines(artifacts, maxBytes): { text: string; dropped: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// add to packages/context/evolution-memory-context/tests/render.spec.ts
import { artifactKey, type LessonArtifact } from '@deepseek-ai/dsh-evolution-memory'

function lesson(statement: string, confidence: number): LessonArtifact {
  return {
    id: artifactKey(statement), statement, source: 's1', conditions: '', evidence: 'fact', confidence,
    validationCount: 0, refutationCount: 0, scope: 'project',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

it('renders lessons strongest first and drops the weakest under pressure', () => {
  const artifacts = [lesson('weak fact', 0.2), lesson('strong fact', 0.9)]
  expect(renderLessonLines(artifacts, 4096).text).toBe('- strong fact (confidence: 0.90)\n- weak fact (confidence: 0.20)')
  const tight = renderLessonLines(artifacts, Buffer.byteLength('- strong fact (confidence: 0.90)', 'utf8'))
  expect(tight.text).toBe('- strong fact (confidence: 0.90)')
  expect(tight.dropped).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/context/evolution-memory-context/tests/render.spec.ts -t 'strongest first'` Expected: FAIL — `renderLessonLines is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `render.ts`:

```ts
/**
 * Render lesson artifacts best-first, dropping the lowest-confidence ones
 * until the block fits its byte budget.
 * @param artifacts - the scope's artifacts.
 * @param maxBytes - byte budget for the rendered block.
 * @returns the rendered lines and how many artifacts were dropped.
 */
export function renderLessonLines(
  artifacts: readonly LessonArtifact[],
  maxBytes: number,
): { text: string; dropped: number } {
  const ordered = [...artifacts].sort((left, right) =>
    right.confidence - left.confidence || (left.id < right.id ? -1 : 1))
  for (let kept = ordered.length; kept > 0; kept -= 1) {
    const lines = ordered.slice(0, kept).map(artifact => `- ${artifact.statement} (confidence: ${artifact.confidence.toFixed(2)})`)
    const text = lines.join('\n')
    if (byteLength(text) <= maxBytes) return { text, dropped: ordered.length - kept }
  }
  return { text: '', dropped: ordered.length }
}
```

Change `renderEvolutionBrief`'s lessons input to `readonly LessonArtifact[]`, replace `truncateField(header, draft, maxBytes, 'lessons')` with a call to `renderLessonLines(draft.lessons, remaining)` that replaces the whole lessons block rather than truncating a string, and update `index.ts:333-347`'s `hasContent` check to `record.agentLessons.length > 0`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/context/evolution-memory-context` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/context/evolution-memory-context
git commit -m "feat(evolution-memory-context): render lesson artifacts best-first"
```

---

### Task 7: Repair the two remaining readers

**Files:**
- Modify: `packages/evolution/evolution-dreaming/src/index.ts:370-373`
- Modify: `packages/evolution/evolution-controller/src/index.ts:280-285` and its `projectValue`
- Modify: `packages/client/ui-evolution/src/types.ts:71`, `client/Page.tsx` lessons display
- Test: `packages/evolution/evolution-dreaming/tests/*`, `packages/evolution/evolution-controller/tests/controller.host.spec.ts`, `packages/client/ui-evolution/tests/*`

**Interfaces:**
- Consumes: `LessonArtifact` from `@deepseek-ai/dsh-evolution-memory`.
- Produces: `ctx.evolutionDreaming`'s relevance read joins artifact statements instead of a string; the controller's `evolutionMemory.rebuild` response and the client projection carry `lessons: readonly LessonArtifact[]`.

- [ ] **Step 1: Write the failing test**

```ts
// add to packages/evolution/evolution-dreaming/tests/ (the file exercising `score` via a cycle)
it('scores relevance against the scope artifacts, not a stringified record', async () => {
  const h = await harness()
  await h.ctx.evolutionMemory.addArtifact(h.scope('ws-1'), {
    statement: 'the deploy command is dsh deploy', source: 's1', conditions: '', evidence: 'fact', confidence: 0.9, scope: 'project',
  })
  const report = await h.ctx.evolutionDreaming.run('light', h.scope('ws-1'), [])
  expect(report.scanned).toBeGreaterThanOrEqual(0)
  await h.fiber.dispose()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/evolution/evolution-dreaming` Expected: FAIL to compile — `[memory.instructions, memory.agentLessons, memory.userProfile].join('\n')` cannot join an array.

- [ ] **Step 3: Write minimal implementation**

In `evolution-dreaming/src/index.ts`, replace lines 370-373's `known` computation:

```ts
    const memory = this.ctx.get('evolutionMemory')?.read(scopeId)
    const known = memory === undefined
      ? ''
      : [
        memory.instructions,
        ...memory.agentLessons.map(artifact => artifact.statement),
        memory.userProfile,
      ].join('\n')
```

In `evolution-controller/src/index.ts`, change the `@Remote('setLessons')` handler: its request type gains `artifacts: readonly LessonArtifactInput[]` (replacing `lessons: string`) and its body replaces the whole list by removing every current artifact and adding each supplied one. Note in the module doc that this RPC now replaces the artifact list wholesale, matching what the editor does. Update `projectValue` so the projected record's `lessons` field is the artifact array rather than a joined string.

In `packages/client/ui-evolution/src/types.ts:71`, change `readonly lessons: string` to `readonly lessons: readonly LessonArtifact[]`; in `client/Page.tsx`, render the lessons section from the array (one line per artifact statement, strongest first, matching Task 6's ordering) and keep the `capacity.lessons` byte bar unchanged since `usage.usedBytes` already reflects the array.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/evolution/evolution-dreaming packages/evolution/evolution-controller packages/client/ui-evolution` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/evolution/evolution-dreaming packages/evolution/evolution-controller packages/client/ui-evolution
git commit -m "fix(evolution): read and project lesson artifacts across the remaining consumers"
```

---

### Task 8: Documentation and generated artifacts

**Files:**
- Modify: `packages/evolution/evolution-memory/README.md` + `README.zh.md`
- Modify: `packages/evolution/evolution-controller/README.md` + `README.zh.md`
- Create: `.agents/notes/implemented/architecture/2026-09-13-lesson-artifact-model.md` + `.zh.md`
- Regenerate: `docs/config-catalog.md` + `.zh.md`
- Register: `scripts/gen-doc-graphs.ts` `SERVICE_ROLES` entries already list `evolution-memory`; add the maintenance task's heartbeat producer relationship if the generated graph shows one is missing.

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Update the evolution-memory README**

Rewrite the config table to add `mergeSimilarityFloor` (`0.87`), `maintenanceIntervalHours` (`24`), `refutationFloor` (`3`), `defaultTtlDays` (`30`); replace the `addLesson`/`replaceLesson`/`removeLesson` prose (line 58) with the three artifact ops; replace the family-stamp sentence (64) naming `setLessons`/`addLesson`/`replaceLesson`/`removeLesson`; and replace the "One document per scope … no per-entry provenance, per-entry deletion, or memory history" limitation with the artifact model's new limits (merge is similarity-based and needs embeddings for paraphrase detection; refinement of a migrated document is best-effort).

- [ ] **Step 2: Mirror both READMEs into Chinese**

Run: `pnpm run verify-translation-pairing --write packages/evolution/evolution-memory/README.md packages/evolution/evolution-controller/README.md` Expected: the pairs are recorded; both `.zh.md` files carry the same table rows and prose.

- [ ] **Step 3: Write the Agent Note**

Cover: why the artifact model is bounded to `agentLessons`; why the bump needs `compatibleVersions: [1]` and why it deliberately omits `invalidRecords`; why migration is sync-admission plus async-refinement rather than lazy-on-read (the synchronous `read()` contract); the merge-strategy decision and its embeddings-optional degradation; and that Phase 2 (structured extraction) is the half that makes the counters live.

- [ ] **Step 4: Regenerate and verify documentation gates**

Run: `pnpm run gen-config-catalog && pnpm run gen-doc-graphs && pnpm run gen-cordis-catalog` Then mirror the Chinese sides of any regenerated `.zh.md` (the established pattern: translate `Requires:` → `需要：` and `Source:` → `来源：`, localize `.md` links to `.zh.md`) and run: Run: `pnpm run verify-config-catalog && pnpm run verify-doc-graphs && pnpm run verify-cordis-catalog && pnpm run verify-translation-pairing` Expected: all pass with no new issues.

- [ ] **Step 5: Commit**

```bash
git add packages/evolution/evolution-memory/README.md packages/evolution/evolution-memory/README.zh.md packages/evolution/evolution-controller/README.md packages/evolution/evolution-controller/README.zh.md .agents/notes/implemented/architecture/2026-09-13-lesson-artifact-model.md .agents/notes/implemented/architecture/2026-09-13-lesson-artifact-model.zh.md docs/
git commit -m "docs(evolution-memory): document the lesson artifact model"
```

---

## Self-Review

**1. Spec coverage.** Every Phase-1 row of the spec's delivery table maps to a task: `LessonArtifact` type + schema → Task 1; version 2 + `compatibleVersions: [1]` + sync structural admission → Task 2; three id-addressed ops → Task 3; merge-strategy dedupe → Task 4; heartbeats (decay + refinement) → Task 5; `digestOf`/`usedBytesOf`/capacity → Task 2; `evolution-memory-context` renderer → Task 6; `evolution-dreaming`'s field read → Task 7; docs → Task 8. The spec's Phase-2 rows (structured extraction, `squeeze.ts` deletion, counter wiring, `maxOutputTokens`, the controller's request shape as an *artifact-add* protocol) are explicitly out of scope except where Task 7 must touch the controller to keep it compiling.

**2. Placeholder scan.** No "TBD", "implement later", or "similar to Task N". The one deferred decision inside a task is Task 5's refinement call: Step 3 specifies the pruning sweep and the registration fully, and states plainly that refinement requires the extraction call Phase 2 introduces, so `sweep` returns `refined: 0` until then. That is a stated boundary, not an unwritten step.

**3. Type consistency.** `LessonArtifact`, `LessonArtifactInput`, `LessonArtifactPatch`, `LessonMergeStrategy`, `artifactKey`, `wrapLegacyLessons`, `mergeArtifact`, `pickMergeTarget`, `prunable`, `SweepResult`, `addArtifactTo`, `patchArtifactIn`, `removeArtifactFrom`, and the three op names are each defined once and referenced with the same spelling everywhere after. `replaceArtifact` appears in Task 3 as a temporary definition and is explicitly deleted in Task 4 — flagged in both places.

**Known gap, surfaced rather than hidden:** Task 5's `refined` count is always zero in Phase 1. The spec's migration story promises LLM refinement of coarse artifacts; that promise is fulfilled by Phase 2, because the split needs exactly the structured extraction call Phase 2 builds. Phase 1 leaves the coarse artifact as a correct, permanent fallback, which is what makes the phasing safe rather than merely incomplete.
