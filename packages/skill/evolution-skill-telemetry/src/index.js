/**
 * Evolution skill telemetry (`ctx.evolutionSkillTelemetry`): per-skill
 * use/view/patch counters with creation provenance, pinning, and lifecycle
 * state over the `evolution_skill_usage` domain. Bundled and hub skills are
 * excluded from every write.
 *
 * Reads are synchronous from the domain's validated memory. Marks seed the
 * record on first touch and resolve without writing when nothing changes.
 * Stored objects never leak by reference.
 * @module @deepseek-ai/dsh-evolution-skill-telemetry
 */
import { Service } from '@deepseek-ai/cordis';
import { skillUsageDomainSpec } from "./spec.js";
export { skillUsageDomainSpec } from "./spec.js";
/** Produced outputs of one path needed before skill creation counts as warranted. */
export const SKILL_CREATION_OUTPUT_THRESHOLD = 3;
/**
 * Count produced outputs as skill-creation evidence. Two outputs are similar
 * when their normalized path matches — case-folded, with `\` and `/` treated
 * alike and trailing separators ignored — so repeated rewrites of one artifact
 * count, while file content is never read or quoted. Reaching
 * {@link SKILL_CREATION_OUTPUT_THRESHOLD} similar outputs is the counted
 * trigger for proposing a skill; no vendor-reported repetition number feeds it.
 * @param paths - produced-file paths in observation order.
 * @returns the repeated paths plus whether any reached the threshold.
 */
export function skillCreationEvidence(paths) {
    const groups = new Map();
    for (const path of paths) {
        const key = path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
        const found = groups.get(key);
        if (found === undefined)
            groups.set(key, { path, count: 1 });
        else
            found.count += 1;
    }
    const repeated = [...groups.values()]
        .filter(entry => entry.count >= SKILL_CREATION_OUTPUT_THRESHOLD)
        .sort((left, right) => right.count - left.count);
    return { repeated, fires: repeated.length > 0 };
}
/**
 * Report whether a skill source is excluded from telemetry and managed
 * writes. Bundled skills ship with the product and hub skills arrive from
 * sharing; neither is locally curated.
 * @param source - discovery source from the skill catalog.
 * @returns whether writes for this source must be skipped.
 */
export function isExcludedSkillSource(source) {
    return source === 'bundled' || source.startsWith('hub');
}
function freshRecord() {
    return {
        useCount: 0,
        viewCount: 0,
        patchCount: 0,
        lastUsedAt: null,
        lastViewedAt: null,
        lastPatchedAt: null,
        createdAt: new Date().toISOString(),
        state: 'active',
        pinned: false,
        createdBy: null,
        absorbedInto: null,
        archivedAt: null,
    };
}
/**
 * Durable per-skill telemetry store. Opens the `evolution_skill_usage`
 * domain at init and closes it through `ctx.effect`. A passive
 * `tools/post-execute` observer counts successful `skill`-tool loads as
 * uses; views, patches, provenance, pins, and states arrive through the
 * explicit marks below.
 */
export class EvolutionSkillTelemetry extends Service {
    static inject = ['storageDomain', 'skills'];
    table;
    consolidationCostRow;
    /**
     * @param ctx - Host context carrying the storage domain and skill registry.
     */
    constructor(ctx) {
        super(ctx, 'evolutionSkillTelemetry');
        ctx.on('tools/post-execute', async (exec, result, next) => {
            const decision = await next();
            if (exec.name === 'skill' && !result.isError) {
                const name = exec.arguments.name;
                if (typeof name === 'string') {
                    try {
                        await this.markUsed(name);
                    }
                    catch (error) {
                        this.ctx.logger.warn(`evolution skill telemetry use recording failed for '${name}': ${String(error)}`);
                    }
                }
            }
            return decision;
        });
    }
    /** Open the domain and publish the table handle. */
    async [Service.init]() {
        const domain = await this.ctx.storageDomain.open(skillUsageDomainSpec);
        this.ctx.effect(() => () => domain.close(), 'evolution-skill-telemetry.domainClose');
        this.table = domain.table('records');
    }
    /**
     * Read one skill's record.
     * @param name - skill name.
     * @returns a detached copy, or undefined when never touched.
     */
    read(name) {
        const found = this.requireTable().get(name);
        return found === undefined ? undefined : structuredClone(found);
    }
    /**
     * List every tracked skill with its record.
     * @returns name/record pairs with detached copies.
     */
    entries() {
        return [...this.requireTable().entries()].map(([name, record]) => ({ name, usage: structuredClone(record) }));
    }
    /**
     * Count one successful model load. Bundled and hub skills resolve to no
     * record: the observer still delegates, only the write is skipped.
     * @param name - skill name.
     * @param source - catalog source when the caller already resolved it.
     * @returns the stored record, or undefined for excluded sources.
     */
    async markUsed(name, source) {
        if (isExcludedSkillSource(source ?? await this.lookupSource(name)))
            return undefined;
        const now = new Date().toISOString();
        return this.write(name, record => ({ ...record, useCount: record.useCount + 1, lastUsedAt: now }));
    }
    /**
     * Count one human view. Exclusion matches {@link markUsed}.
     * @param name - skill name.
     * @param source - catalog source when the caller already resolved it.
     * @returns the stored record, or undefined for excluded sources.
     */
    async markViewed(name, source) {
        if (isExcludedSkillSource(source ?? await this.lookupSource(name)))
            return undefined;
        const now = new Date().toISOString();
        return this.write(name, record => ({ ...record, viewCount: record.viewCount + 1, lastViewedAt: now }));
    }
    /**
     * Count one skill-management mutation. Exclusion matches {@link markUsed}.
     * @param name - skill name.
     * @param source - catalog source when the caller already resolved it.
     * @returns the stored record, or undefined for excluded sources.
     */
    async markPatched(name, source) {
        if (isExcludedSkillSource(source ?? await this.lookupSource(name)))
            return undefined;
        const now = new Date().toISOString();
        return this.write(name, record => ({ ...record, patchCount: record.patchCount + 1, lastPatchedAt: now }));
    }
    /**
     * Record background-review authorship. Resolves without writing when the
     * record already carries it; foreground creates never call this, so their
     * provenance stays user-directed.
     * @param name - skill name.
     * @returns the stored record.
     */
    async markAgentCreated(name) {
        const current = this.requireTable().get(name);
        if (current !== undefined && current.createdBy === 'agent')
            return structuredClone(current);
        return this.write(name, record => ({ ...record, createdBy: 'agent' }));
    }
    /**
     * Adopt one agent-created skill into user-directed standing. Only records
     * carrying background-review authorship move; everything else rejects, and
     * clocks never reset.
     * @param name - skill name.
     * @returns the stored record with user-directed provenance.
     */
    async markAdopted(name) {
        const current = this.requireTable().get(name);
        if (current === undefined)
            throw new Error(`evolution skill telemetry has no record for '${name}'`);
        if (current.createdBy !== 'agent') {
            throw new Error(`evolution skill telemetry cannot adopt '${name}' without background-review authorship`);
        }
        return this.write(name, record => ({ ...record, createdBy: 'foreground' }));
    }
    /**
     * Forget one skill's record entirely. Purge calls this after removing the
     * skill directory; absent names resolve without writing.
     * @param name - skill name.
     * @returns whether a record was removed.
     */
    async drop(name) {
        return this.requireTable().delete(name);
    }
    /**
     * Record the cost row of a consolidation-scale run before its fan-out
     * begins, so the curator and command surfaces read one frozen shape of
     * planned spend instead of quoting ad-hoc numbers. Only the latest row is
     * kept; a run that never fans out leaves the previous row untouched.
     * @param row - planned cost facts of the upcoming run.
     */
    recordConsolidationCost(row) {
        this.consolidationCostRow = { ...row };
    }
    /**
     * Read the cost row recorded for the most recent consolidation-scale run.
     * @returns a detached copy of the row, or undefined when no run was recorded.
     */
    readConsolidationCost() {
        return this.consolidationCostRow === undefined ? undefined : { ...this.consolidationCostRow };
    }
    /**
     * Pin or unpin one skill. Pins block automatic transitions and managed
     * deletion; patches stay allowed. Resolves without writing when unchanged.
     * @param name - skill name.
     * @param pinned - new pin state.
     * @returns the stored record.
     */
    async setPinned(name, pinned) {
        const current = this.requireTable().get(name);
        if (current !== undefined && current.pinned === pinned)
            return structuredClone(current);
        return this.write(name, record => ({ ...record, pinned }));
    }
    /**
     * Move one skill through its curation lifecycle. Entering `archived`
     * stamps the instant; leaving clears it. The absorption target replaces
     * any previous one, so plain transitions carry none.
     * @param name - skill name.
     * @param state - new lifecycle state.
     * @param absorbedInto - consolidation umbrella, or null when standalone.
     * @returns the stored record.
     */
    async setState(name, state, absorbedInto = null) {
        return this.write(name, (record) => {
            if (state === 'archived' && record.state !== 'archived') {
                return { ...record, state, absorbedInto, archivedAt: new Date().toISOString() };
            }
            if (state !== 'archived' && record.state === 'archived') {
                return { ...record, state, absorbedInto, archivedAt: null };
            }
            return { ...record, state, absorbedInto };
        });
    }
    async lookupSource(name) {
        try {
            const found = (await this.ctx.skills.list()).find(skill => skill.name === name);
            return found?.source ?? 'custom';
        }
        catch {
            // A failing provider must not lose the count: unresolvable skills
            // record under the custom source, which is never excluded.
            return 'custom';
        }
    }
    async write(name, fn) {
        const table = this.requireTable();
        if (table.get(name) === undefined) {
            const next = fn(freshRecord());
            await table.put(name, structuredClone(next));
            return structuredClone(next);
        }
        const next = await table.update(name, fn);
        return structuredClone(next);
    }
    requireTable() {
        if (this.table === undefined)
            throw new Error('evolution skill telemetry is not started yet');
        return this.table;
    }
}
export default EvolutionSkillTelemetry;
//# sourceMappingURL=index.js.map