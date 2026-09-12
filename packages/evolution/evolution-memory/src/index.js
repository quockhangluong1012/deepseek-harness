/**
 * Durable per-scope evolution memory store (`ctx.evolutionMemory`): the
 * user-authored instructions, the model-maintained lessons and profile
 * documents with provenance and per-family stamps, attached text and file
 * context items, the produced-file index, staged writes awaiting approval,
 * and the newest-first log of decided staged entries, over the
 * `evolution_memory` domain.
 *
 * Reads are synchronous from the domain's validated memory. Every cap is
 * checked before the write chain is entered, and a rejected write never
 * mutates the record. Stored objects never leak by reference.
 * @module @deepseek-ai/dsh-evolution-memory
 */
import { randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { digestOf, usedBytesOf, utf8Bytes } from "./digest.js";
import { evolutionExtraction, evolutionMemoryDomainSpec, stagedWritePayload } from "./spec.js";
export { evolutionMemoryDomainSpec } from "./spec.js";
export { digestOf, usedBytesOf, EMPTY_DIGEST, truncateUtf8, utf8Bytes } from "./digest.js";
/**
 * Label prefix marking context the reviewer recalled from session history
 * rather than the user attaching it. Writers label recalled items with it and
 * consumers order them last, so a recalled item is the first context material
 * a brief drops under its byte budget.
 */
export const RECALL_LABEL_PREFIX = 'Recall: ';
/**
 * Build the opaque scope identity for one scope: `profile:workspaceId`, or
 * `profile:global` for the profile-wide record. Use {@link storageKey} for
 * the path-safe record key handed to the domain.
 * @param profile - owning profile name; non-empty and free of `:`.
 * @param workspaceId - workspace key within the profile; omit for the global record.
 * @returns the opaque scope identity.
 */
export function EvolutionScopeId(profile, workspaceId) {
    if (profile.length === 0)
        throw new Error('evolution-memory: profile must be non-empty');
    if (profile.includes(':'))
        throw new Error(`evolution-memory: profile must not contain ':', got ${JSON.stringify(profile)}`);
    const scope = workspaceId ?? 'global';
    if (scope.length === 0)
        throw new Error('evolution-memory: workspace scope must be non-empty');
    if (scope.includes(':'))
        throw new Error(`evolution-memory: workspace scope must not contain ':', got ${JSON.stringify(scope)}`);
    return `${profile}:${scope}`;
}
/** Record keys become path segments in the JSON backend; this set is path-safe on every OS. */
const STORAGE_KEY_RE = /^[a-zA-Z0-9_-]+$/;
/**
 * Internal file encoding for one scope: `<profile>--<workspaceId>` or
 * `<profile>--global`. The external identity stays the opaque
 * `profile:workspaceId` key because `:` is unambiguous when profiles and
 * scopes never contain it; the JSON backend forbids `:` in per-record keys,
 * so the store never hands the opaque key to the domain.
 * @param id - opaque scope identity.
 * @returns the path-safe record key used as the domain table key.
 */
export function storageKey(id) {
    const raw = String(id);
    const separator = raw.indexOf(':');
    if (separator === -1)
        throw new Error(`evolution-memory: scope identity '${raw}' is missing ':'`);
    const key = `${raw.slice(0, separator)}--${raw.slice(separator + 1)}`;
    if (!STORAGE_KEY_RE.test(key)) {
        throw new Error(`evolution-memory: scope '${raw}' is not path-safe as '${key}' (must match ${STORAGE_KEY_RE})`);
    }
    return key;
}
/**
 * Decode one storage key back to its opaque scope identity, splitting on the
 * last `--` so profiles containing `--` still round-trip (workspace keys are
 * UUIDs without `--`, and the global record ends in `--global`).
 * @param key - path-safe record key.
 * @returns the opaque scope identity.
 */
export function scopeIdFromStorageKey(key) {
    const separator = key.lastIndexOf('--');
    if (separator === -1)
        throw new Error(`evolution-memory: storage key '${key}' is missing '--'`);
    return `${key.slice(0, separator)}:${key.slice(separator + 2)}`;
}
/** Capacity-bar denominator and hard ceiling on stored bytes. */
const capacityBytesField = z.number().step(1).min(1).required();
/** Lessons document cap in UTF-8 bytes. */
const maxAgentBytesField = z.number().step(1).min(1).default(65536);
/** User profile document cap in UTF-8 bytes. */
const maxUserBytesField = z.number().step(1).min(1).default(32768);
/** Per-item cap in UTF-8 bytes, and ceiling on a file item's observed size. */
const maxContextItemBytesField = z.number().step(1).min(1).default(262144);
/** Item count cap. */
const maxContextItemsField = z.number().step(1).min(1).default(50);
/** Produced-file index size. */
const maxOutputsField = z.number().step(1).min(1).default(200);
/** Decided staged entries retained per scope. */
const maxResolutionsField = z.number().step(1).min(1).default(200);
/** Validated deployment choices; `capacityBytes` is required. */
export const Config = z.object({
    capacityBytes: capacityBytesField,
    maxAgentBytes: maxAgentBytesField,
    maxUserBytes: maxUserBytesField,
    maxContextItemBytes: maxContextItemBytesField,
    maxContextItems: maxContextItemsField,
    maxOutputs: maxOutputsField,
    maxResolutions: maxResolutionsField,
});
/**
 * Resolve defaults for optional caps.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config) {
    const { capacityBytes, maxAgentBytes = 65536, maxUserBytes = 32768, maxContextItemBytes = 262144, maxContextItems = 50, maxOutputs = 200, maxResolutions = 200, } = config;
    return { capacityBytes, maxAgentBytes, maxUserBytes, maxContextItemBytes, maxContextItems, maxOutputs, maxResolutions };
}
function freshRecord() {
    return {
        instructions: '',
        agentLessons: '',
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
    };
}
/**
 * Derive the release-compatible `memoryUpdatedAt` from the per-family stamps.
 * @param record - candidate record carrying both family stamps.
 * @returns the later lessons or profile stamp, or null when neither exists.
 */
function memoryUpdatedAtOf(record) {
    const { lessonsUpdatedAt, profileUpdatedAt } = record;
    if (lessonsUpdatedAt === null)
        return profileUpdatedAt;
    if (profileUpdatedAt === null)
        return lessonsUpdatedAt;
    return lessonsUpdatedAt > profileUpdatedAt ? lessonsUpdatedAt : profileUpdatedAt;
}
/**
 * Stamp one memory family on a candidate record and keep the derived
 * aggregate current. Other families keep their own stamps untouched.
 * @param record - candidate record without the stamp.
 * @param family - the family the write changed.
 * @param at - ISO-8601 instant of the write.
 * @returns the record with that family's stamp and the derived aggregate.
 */
function stampFamily(record, family, at) {
    if (family === 'instructions')
        return { ...record, instructionsUpdatedAt: at };
    const stamped = family === 'lessons' ? { ...record, lessonsUpdatedAt: at } : { ...record, profileUpdatedAt: at };
    return { ...stamped, memoryUpdatedAt: memoryUpdatedAtOf(stamped) };
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
function withResolution(existing, entry, decision, at, maxResolutions) {
    const resolution = {
        id: entry.id,
        kind: entry.kind,
        op: entry.op,
        gist: entry.gist,
        decision,
        at,
        originSessionId: entry.originSessionId,
    };
    return [resolution, ...existing].slice(0, maxResolutions);
}
function tooLarge(field, bytes, maxBytes) {
    return new RemoteError('evolution/too-large', `evolution memory field '${field}' is ${bytes} bytes, exceeding the ${maxBytes} byte cap`, { field, bytes, maxBytes });
}
function capacityExceeded(usedBytes, capacityBytes) {
    return new RemoteError('evolution/capacity-exceeded', `evolution memory write would use ${usedBytes} of ${capacityBytes} bytes`, { usedBytes, capacityBytes });
}
function itemNotFound(itemId) {
    return new RemoteError('evolution/item-not-found', `no evolution memory item '${itemId}'`, { itemId });
}
function ambiguousMatch(oldText, candidates) {
    return new RemoteError('evolution/ambiguous-match', `evolution memory lesson '${oldText}' matches ${candidates.length} times; disambiguate with a longer substring`, { oldText, candidates });
}
function stagedNotFound(stagedId) {
    return new RemoteError('evolution/staged-not-found', `no staged evolution write '${stagedId}'`, { stagedId });
}
/** Fixed bound on the ambiguous-match error payload; failed writes carry excerpts, not the document. */
const MAX_AMBIGUOUS_CANDIDATES = 5;
/**
 * Locate every non-overlapping occurrence of a substring.
 * @param haystack - the lessons document to search.
 * @param needle - non-empty substring to find; callers reject empties loudly.
 * @returns start offsets in ascending order.
 */
function findOccurrences(haystack, needle) {
    const offsets = [];
    let from = 0;
    while (true) {
        const at = haystack.indexOf(needle, from);
        if (at === -1)
            return offsets;
        offsets.push(at);
        from = at + needle.length;
    }
}
/**
 * Render one ambiguous occurrence as a bounded excerpt for the rejection payload.
 * @param lessons - the lessons document holding the match.
 * @param at - start offset of the match.
 * @param length - length of the matched substring.
 * @returns surrounding text identifying the occurrence.
 */
function excerptAt(lessons, at, length) {
    return lessons.slice(Math.max(0, at - 30), at + length + 30);
}
/**
 * Resolve one unique lesson substring or reject loudly.
 * @param lessons - the lessons document to search.
 * @param oldText - non-empty substring expected exactly once.
 * @returns the single start offset.
 */
function uniqueOffset(lessons, oldText) {
    const offsets = findOccurrences(lessons, oldText);
    if (offsets.length === 0)
        throw itemNotFound(oldText);
    if (offsets.length > 1) {
        throw ambiguousMatch(oldText, offsets.slice(0, MAX_AMBIGUOUS_CANDIDATES).map(at => excerptAt(lessons, at, oldText.length)));
    }
    return offsets[0];
}
function checkCapacity(record, capacityBytes) {
    const used = usedBytesOf(record);
    if (used > capacityBytes)
        throw capacityExceeded(used, capacityBytes);
}
/**
 * Measure one context item against the per-item cap.
 * @param input - caller-supplied label plus text or observed file size.
 * @param resolved - normalized caps.
 * @returns the bytes the item charges against capacity.
 */
function contextItemSize(input, resolved) {
    const sizeBytes = input.kind === 'text' ? utf8Bytes(input.text) : input.sizeBytes;
    if (sizeBytes > resolved.maxContextItemBytes) {
        throw tooLarge('contextItem', sizeBytes, resolved.maxContextItemBytes);
    }
    return sizeBytes;
}
/**
 * Pure lessons replacement with caps enforced; timestamps are the caller's job.
 * @param record - current record value.
 * @param text - replacement lessons document.
 * @param resolved - normalized caps.
 * @returns the candidate record without timestamp stamps.
 */
function applySetLessons(record, text, resolved) {
    const bytes = utf8Bytes(text);
    if (bytes > resolved.maxAgentBytes)
        throw tooLarge('agentLessons', bytes, resolved.maxAgentBytes);
    const next = { ...record, agentLessons: text };
    checkCapacity(next, resolved.capacityBytes);
    return next;
}
/**
 * Pure profile replacement with caps enforced; timestamps are the caller's job.
 * @param record - current record value.
 * @param text - replacement profile document.
 * @param resolved - normalized caps.
 * @returns the candidate record without timestamp stamps.
 */
function applySetProfile(record, text, resolved) {
    const bytes = utf8Bytes(text);
    if (bytes > resolved.maxUserBytes)
        throw tooLarge('userProfile', bytes, resolved.maxUserBytes);
    const next = { ...record, userProfile: text };
    checkCapacity(next, resolved.capacityBytes);
    return next;
}
function stagedFields(payload, op) {
    if (typeof payload !== 'object' || payload === null) {
        throw new Error(`evolution-memory: staged op '${op}' payload must be an object`);
    }
    return payload;
}
/**
 * Read a required string field from a staged payload.
 * @param fields - payload fields.
 * @param field - field name to read.
 * @param op - staged op name for the failure message.
 * @returns the string value.
 */
function requiredField(fields, field, op) {
    const value = fields[field];
    if (typeof value !== 'string')
        throw new Error(`evolution-memory: staged op '${op}' payload must carry a string '${field}'`);
    return value;
}
/**
 * Stamp extraction provenance from a staged payload when one is present.
 * @param record - candidate record value.
 * @param fields - payload fields.
 * @returns the record with `lastExtraction` replaced, or unchanged.
 */
function withStagedExtraction(record, fields) {
    if (fields.extraction === undefined)
        return record;
    const parsed = evolutionExtraction.safeParse(fields.extraction);
    if (!parsed.success)
        throw new Error('evolution-memory: staged memory op carries an invalid extraction');
    return { ...record, lastExtraction: parsed.data };
}
/**
 * Apply one memory-kind staged operation to a record value. Cap and
 * substring rejections propagate with the staged entry kept.
 * @param record - current record value.
 * @param entry - staged entry to apply.
 * @param resolved - normalized caps.
 * @returns the candidate record without timestamp stamps, plus the memory
 * family the op changed (a duplicate add changes none).
 */
function applyMemoryStagedOp(record, entry, resolved) {
    const fields = stagedFields(entry.payload, entry.op);
    switch (entry.op) {
        case 'setInstructions': {
            const next = { ...record, instructions: requiredField(fields, 'text', entry.op) };
            checkCapacity(next, resolved.capacityBytes);
            return { record: next, family: 'instructions' };
        }
        case 'setLessons': {
            const next = withStagedExtraction(applySetLessons(record, requiredField(fields, 'text', entry.op), resolved), fields);
            return { record: next, family: 'lessons' };
        }
        case 'addLesson': {
            const text = requiredField(fields, 'text', entry.op);
            if (text.length === 0)
                throw new Error(`evolution-memory: staged op '${entry.op}' payload 'text' must be non-empty`);
            if (record.agentLessons.includes(text))
                return { record, family: null };
            const joined = record.agentLessons === '' ? text : `${record.agentLessons}\n${text}`;
            const next = withStagedExtraction(applySetLessons(record, joined, resolved), fields);
            return { record: next, family: 'lessons' };
        }
        case 'replaceLesson': {
            const oldText = requiredField(fields, 'oldText', entry.op);
            const content = requiredField(fields, 'content', entry.op);
            if (oldText.length === 0)
                throw new Error(`evolution-memory: staged op '${entry.op}' payload 'oldText' must be non-empty`);
            const at = uniqueOffset(record.agentLessons, oldText);
            const joined = record.agentLessons.slice(0, at) + content + record.agentLessons.slice(at + oldText.length);
            const next = withStagedExtraction(applySetLessons(record, joined, resolved), fields);
            return { record: next, family: 'lessons' };
        }
        case 'removeLesson': {
            const oldText = requiredField(fields, 'oldText', entry.op);
            if (oldText.length === 0)
                throw new Error(`evolution-memory: staged op '${entry.op}' payload 'oldText' must be non-empty`);
            const at = uniqueOffset(record.agentLessons, oldText);
            const joined = record.agentLessons.slice(0, at) + record.agentLessons.slice(at + oldText.length);
            return { record: { ...record, agentLessons: joined }, family: 'lessons' };
        }
        case 'setUserProfile': {
            const next = withStagedExtraction(applySetProfile(record, requiredField(fields, 'text', entry.op), resolved), fields);
            return { record: next, family: 'profile' };
        }
        default:
            throw new Error(`evolution-memory: unknown staged memory op '${entry.op}'`);
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
function mergeOutputs(stored, fresh, maxOutputs) {
    const merged = new Map();
    for (const entry of [...stored, ...fresh]) {
        const prior = merged.get(entry.path);
        if (prior === undefined) {
            merged.set(entry.path, { ...entry });
            continue;
        }
        if (entry.at < prior.at)
            continue;
        if (entry.at === prior.at && entry.tool === prior.tool && entry.sessionId === prior.sessionId)
            continue;
        merged.set(entry.path, { ...entry });
    }
    return [...merged.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, maxOutputs);
}
/**
 * Durable per-scope evolution memory store. Opens the `evolution_memory`
 * domain at init and closes it through `ctx.effect`.
 */
export class EvolutionMemoryStore extends Service {
    static inject = ['storageDomain'];
    table;
    resolved;
    /**
     * @param ctx - Host context carrying the storage domain.
     * @param config - capacity and per-field caps from the composition.
     */
    constructor(ctx, config) {
        super(ctx, 'evolutionMemory');
        this.resolved = resolveConfig(config);
    }
    /** Open the domain and publish the table handle. */
    async [Service.init]() {
        const domain = await this.ctx.storageDomain.open(evolutionMemoryDomainSpec);
        this.ctx.effect(() => () => domain.close(), 'evolution-memory.domainClose');
        this.table = domain.table('records');
    }
    /**
     * Read one scope's record.
     * @param id - scope identity.
     * @returns a detached copy, or undefined when absent.
     */
    read(id) {
        const found = this.requireTable().get(storageKey(id));
        return found === undefined ? undefined : structuredClone(found);
    }
    /**
     * Capacity accounting for one scope.
     * @param id - scope identity.
     * @returns charged bytes and the configured ceiling.
     */
    usage(id) {
        return {
            usedBytes: usedBytesOf(this.requireTable().get(storageKey(id))),
            capacityBytes: this.resolved.capacityBytes,
        };
    }
    /**
     * Digest of the brief's inputs for one scope.
     * @param id - scope identity.
     * @returns `'empty'` when absent, else the sha1 of the covered inputs.
     */
    digest(id) {
        return digestOf(this.requireTable().get(storageKey(id)));
    }
    /**
     * Replace the user-authored instruction text. Instructions carry no
     * per-field cap; only the scope capacity bounds them.
     * @param id - scope identity.
     * @param instructions - new rules.
     * @returns the stored record.
     */
    async setInstructions(id, instructions) {
        const current = this.requireTable().get(storageKey(id));
        const priorItems = current === undefined
            ? 0
            : current.contextItems.reduce((sum, item) => sum + item.sizeBytes, 0);
        const nextUsed = utf8Bytes(instructions) + utf8Bytes(current?.agentLessons ?? '') + utf8Bytes(current?.userProfile ?? '') + priorItems;
        if (nextUsed > this.resolved.capacityBytes)
            throw capacityExceeded(nextUsed, this.resolved.capacityBytes);
        const now = new Date().toISOString();
        return this.write(id, () => ({ instructions, instructionsUpdatedAt: now }));
    }
    /**
     * Replace the whole lessons document by hand or from extraction.
     * @param id - scope identity.
     * @param text - replacement lessons document.
     * @param extraction - provenance when model-written.
     * @returns the stored record.
     */
    async setLessons(id, text, extraction) {
        const now = new Date().toISOString();
        return this.write(id, record => stampFamily({
            ...applySetLessons(record, text, this.resolved),
            ...extraction === undefined ? {} : { lastExtraction: structuredClone(extraction) },
        }, 'lessons', now));
    }
    /**
     * Append one lesson. An exact duplicate resolves without writing.
     * @param id - scope identity.
     * @param text - non-empty lesson text to append.
     * @returns the stored record, unchanged when the lesson already exists.
     */
    async addLesson(id, text) {
        if (text.length === 0)
            throw new Error('evolution-memory: lesson text must be non-empty');
        const current = this.requireTable().get(storageKey(id));
        if (current !== undefined && current.agentLessons.includes(text))
            return structuredClone(current);
        const now = new Date().toISOString();
        return this.write(id, (record) => {
            const joined = record.agentLessons === '' ? text : `${record.agentLessons}\n${text}`;
            return stampFamily(applySetLessons(record, joined, this.resolved), 'lessons', now);
        });
    }
    /**
     * Replace one uniquely-matching lesson substring.
     * @param id - scope identity.
     * @param oldText - non-empty substring expected exactly once.
     * @param content - replacement text.
     * @returns the stored record.
     */
    async replaceLesson(id, oldText, content) {
        if (oldText.length === 0)
            throw new Error('evolution-memory: oldText must be non-empty');
        const current = this.requireTable().get(storageKey(id));
        if (current === undefined)
            throw itemNotFound(oldText);
        const at = uniqueOffset(current.agentLessons, oldText);
        const joined = current.agentLessons.slice(0, at) + content + current.agentLessons.slice(at + oldText.length);
        const now = new Date().toISOString();
        return this.write(id, record => stampFamily(applySetLessons(record, joined, this.resolved), 'lessons', now));
    }
    /**
     * Remove one uniquely-matching lesson substring.
     * @param id - scope identity.
     * @param oldText - non-empty substring expected exactly once.
     * @returns the stored record.
     */
    async removeLesson(id, oldText) {
        if (oldText.length === 0)
            throw new Error('evolution-memory: oldText must be non-empty');
        const current = this.requireTable().get(storageKey(id));
        if (current === undefined)
            throw itemNotFound(oldText);
        const at = uniqueOffset(current.agentLessons, oldText);
        const joined = current.agentLessons.slice(0, at) + current.agentLessons.slice(at + oldText.length);
        const now = new Date().toISOString();
        return this.write(id, record => stampFamily({ ...record, agentLessons: joined }, 'lessons', now));
    }
    /**
     * Replace the whole user profile document by hand or from extraction.
     * @param id - scope identity.
     * @param text - replacement profile document.
     * @param extraction - provenance when model-written.
     * @returns the stored record.
     */
    async setUserProfile(id, text, extraction) {
        const now = new Date().toISOString();
        return this.write(id, record => stampFamily({
            ...applySetProfile(record, text, this.resolved),
            ...extraction === undefined ? {} : { lastExtraction: structuredClone(extraction) },
        }, 'profile', now));
    }
    /**
     * Attach pasted text or a scope file.
     * @param id - scope identity.
     * @param input - label plus text or path with its observed size.
     * @returns the stored record.
     */
    async addContextItem(id, input) {
        const sizeBytes = contextItemSize(input, this.resolved);
        const current = this.requireTable().get(storageKey(id));
        const items = current?.contextItems ?? [];
        const nextUsed = usedBytesOf(current) + sizeBytes;
        if (items.length + 1 > this.resolved.maxContextItems || nextUsed > this.resolved.capacityBytes) {
            throw capacityExceeded(nextUsed, this.resolved.capacityBytes);
        }
        const now = new Date().toISOString();
        const item = input.kind === 'text'
            ? { id: randomUUID(), kind: 'text', label: input.label, sizeBytes, addedAt: now, text: input.text }
            : { id: randomUUID(), kind: 'file', label: input.label, sizeBytes, addedAt: now, path: input.path };
        return this.write(id, record => ({ ...record, contextItems: [...record.contextItems, item] }));
    }
    /**
     * Detach one context item.
     * @param id - scope identity.
     * @param itemId - context item identity.
     * @returns the stored record.
     */
    async removeContextItem(id, itemId) {
        const current = this.requireTable().get(storageKey(id));
        if (current === undefined || !current.contextItems.some(item => item.id === itemId)) {
            throw itemNotFound(itemId);
        }
        return this.write(id, record => ({ ...record, contextItems: record.contextItems.filter(item => item.id !== itemId) }));
    }
    /**
     * Stage one write for later approval. Staged entries never count toward
     * capacity; `memoryUpdatedAt` stays untouched until approval. The payload
     * is a durable record field, so it is validated as a JSON value here: a
     * non-JSON payload is refused loudly and nothing is stored.
     * @param input - scope, kind, op, payload, origin session, and gist.
     * @returns the staged entry.
     */
    async stageWrite(input) {
        const kind = input.kind;
        if (kind !== 'memory' && kind !== 'skill') {
            throw new Error(`evolution-memory: staged kind must be 'memory' or 'skill', got ${JSON.stringify(kind)}`);
        }
        if (input.op.length === 0)
            throw new Error('evolution-memory: staged op must be non-empty');
        if (input.gist.length === 0)
            throw new Error('evolution-memory: staged gist must be non-empty');
        const payload = stagedWritePayload.safeParse(input.payload);
        if (!payload.success)
            throw new Error('evolution-memory: staged payload must be a JSON value');
        const now = new Date().toISOString();
        const entry = {
            id: randomUUID(),
            kind: input.kind,
            op: input.op,
            payload: structuredClone(payload.data),
            originSessionId: input.originSessionId,
            createdAt: now,
            gist: input.gist,
        };
        await this.write(input.scopeId, record => ({ ...record, staged: [...record.staged, entry] }));
        return structuredClone(entry);
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
    async approveStaged(id) {
        const scope = this.findStagedScope(id);
        if (scope === undefined)
            throw stagedNotFound(id);
        const resolved = this.resolved;
        await this.requireTable().update(scope, (record) => {
            const target = record.staged.find(candidate => candidate.id === id);
            if (target === undefined)
                throw stagedNotFound(id);
            const now = new Date().toISOString();
            const remaining = record.staged.filter(candidate => candidate.id !== id);
            const resolutions = withResolution(record.resolutions, target, 'approved', now, resolved.maxResolutions);
            if (target.kind === 'skill')
                return { ...record, staged: remaining, resolutions, updatedAt: now };
            const applied = applyMemoryStagedOp(record, target, resolved);
            const stamped = applied.family === null ? applied.record : stampFamily(applied.record, applied.family, now);
            return { ...stamped, staged: remaining, resolutions, updatedAt: now };
        });
    }
    /**
     * Drop one staged write without applying it.
     * @param id - staged entry identity.
     * @returns resolution after durability.
     */
    async rejectStaged(id) {
        const scope = this.findStagedScope(id);
        if (scope === undefined)
            throw stagedNotFound(id);
        const maxResolutions = this.resolved.maxResolutions;
        await this.requireTable().update(scope, (record) => {
            const target = record.staged.find(candidate => candidate.id === id);
            if (target === undefined)
                throw stagedNotFound(id);
            const now = new Date().toISOString();
            return {
                ...record,
                staged: record.staged.filter(candidate => candidate.id !== id),
                resolutions: withResolution(record.resolutions, target, 'rejected', now, maxResolutions),
                updatedAt: now,
            };
        });
    }
    /**
     * Index produced files newest-first, collapsing repeats onto the newer
     * `at` and truncating to `maxOutputs`. Resolves without writing when the
     * resulting list is unchanged.
     * @param id - scope identity.
     * @param entries - output entries with path, tool, session, and instant.
     * @returns resolution after durability, or immediately when unchanged.
     */
    async recordOutputs(id, entries) {
        if (entries.length === 0)
            return;
        const table = this.requireTable();
        const key = storageKey(id);
        const current = table.get(key);
        const outputs = mergeOutputs(current?.outputs ?? [], entries, this.resolved.maxOutputs);
        if (current !== undefined && sameOutputs(current.outputs, outputs))
            return;
        const now = new Date().toISOString();
        if (current === undefined) {
            await table.put(key, {
                ...freshRecord(),
                outputs,
                updatedAt: now,
            });
            return;
        }
        await table.update(key, record => ({ ...record, outputs, updatedAt: new Date().toISOString() }));
    }
    /**
     * Locate the record holding one staged entry. Table keys are storage keys;
     * the returned key is the same encoding `update` expects.
     */
    findStagedScope(id) {
        for (const [scope, record] of this.requireTable().entries()) {
            if (record.staged.some(candidate => candidate.id === id))
                return scope;
        }
        return undefined;
    }
    async write(id, fn) {
        const table = this.requireTable();
        const key = storageKey(id);
        const current = table.get(key);
        if (current === undefined) {
            const now = new Date().toISOString();
            const seeded = { ...freshRecord(), updatedAt: now };
            const next = { ...seeded, ...fn(seeded), updatedAt: now };
            await table.put(key, structuredClone(next));
            return structuredClone(next);
        }
        const next = await table.update(key, (record) => {
            const candidate = fn(record);
            return { ...record, ...candidate, updatedAt: new Date().toISOString() };
        });
        return structuredClone(next);
    }
    requireTable() {
        if (this.table === undefined)
            throw new Error('evolution memory store is not started yet');
        return this.table;
    }
}
function sameOutputs(left, right) {
    if (left.length !== right.length)
        return false;
    return left.every((entry, index) => {
        const other = right[index];
        return entry.path === other.path && entry.tool === other.tool && entry.sessionId === other.sessionId && entry.at === other.at;
    });
}
export default EvolutionMemoryStore;
//# sourceMappingURL=index.js.map