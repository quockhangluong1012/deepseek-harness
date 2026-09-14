# Graph+vector fusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the evolution knowledge graph on a heartbeat and fuse its neighborhood into active-memory briefs, so pre-step retrieval combines vector discovery with graph navigation.

**Architecture:** A heartbeat task in `evolution-graph` extracts triples from newly committed session text (buffered from `session/event`, never history reads) via the existing `extract` path; the `active-memory-context` pre-step gains a fail-soft graph leg (seed `find` → `expand` → label FTS → RRF merge via existing `fusion.ts`).

**Tech Stack:** TypeScript strict + `exactOptionalPropertyTypes`, Cordis services, schemastery Config, vitest, oxlint.

**Spec:** `docs/superpowers/specs/2026-09-14-graph-vector-fusion-design.md` — the plan argues from it; executors read both.

## Global Constraints

- `exactOptionalPropertyTypes: true` — optional object fields that receive an explicit `undefined` must be typed `T | undefined`.
- No new synchronous session-history reads (`ownEvents`, `eventAt`, `snapshotEvents` banned in production source by `typescript/no-deprecated`).
- Every exported function carries JSDoc with `@param`/`@returns`.
- Test files: type every `JSON.parse` result (`no-unsafe-return`); global `fetch`/service stubs restored in `finally`.
- `v8 ignore` only for genuinely unreachable-by-construction lines, with the reason in the comment.
- Bilingual docs: every README/config-table/prose change mirrored EN+ZH, then `pnpm exec tsx scripts/verify-translation-pairing.ts --write <touched pairs>` (scoped, never `--all`).
- New tunables are validated Config fields, never `?? default` at use sites and never module constants.
- Coverage gate: 100% statements AND branches on every touched `src` file, verified via the JSON recipe in Task 3.

## Deviation from spec (approved design, cheaper implementation)

The spec names a `lastExtractAt` watermark in a new `extract-state` domain table (a domain version bump + migration). The plan replaces it with a consume-on-success pending-text buffer: the heartbeat extracts whatever accumulated since the last run and clears afterward, so an idle scope still costs zero LLM calls and no migration exists. Restart loses unextracted buffer text (documented staleness, bounded by one heartbeat interval). The extraction route resolves as configured provider/model ?? a buffered scope session's `requestHeader()` route (the `evolution-reviewer.resolveTurnRoute` pattern), so the bundle YAML needs no model values.

## File structure

- `packages/evolution/evolution-graph/src/index.ts` — Config `intervalHours` + `profile`, static inject + `'llm'`, `session/event` buffer, heartbeat task registration + run.
- `packages/evolution/evolution-graph/tests/graph.spec.ts` — producer tests (existing file, append describes).
- `packages/context/active-memory-context/src/index.ts` — Config `profile` + `graphDepth` + `graphLimit`, graph leg in pre-step.
- `packages/context/active-memory-context/src/render.ts` — accept scoreless fused hits.
- `packages/context/active-memory-context/tests/index.spec.ts` — consumer + renderer tests.
- Docs: both packages' READMEs (EN+ZH), `docs/config-catalog.md` + `.zh.md`, one bilingual Agent Note.

---

### Task 1: Heartbeat extraction producer in `evolution-graph`

**Files:**
- Modify: `packages/evolution/evolution-graph/src/index.ts` (Config, inject, buffer, task)
- Test: `packages/evolution/evolution-graph/tests/graph.spec.ts` (append `describe('heartbeat extraction')`)

**Interfaces:**
- Consumes: `EvolutionScopeId` + `truncateUtf8` (already imported from `@deepseek-ai/dsh-evolution-memory`), `heartbeat.register({name, intervalHours, run})` (mirror `packages/evolution/evolution-memory/src/index.ts:802-816`), existing `extract(scopeId, text, route, signal)` + `observe`, `ctx.workspaceRegistry.list()` entries with `.sessionIds: SessionId[]` + `.id` (mirror `packages/context/active-memory-context/src/index.ts:157`), `ctx.sessions.get(id)?.requestHeader()` returning `{config: {provider, model}}` or undefined (mirror `packages/evolution/evolution-reviewer/src/index.ts:954-959`).
- Produces: `EVOLUTION_GRAPH_EXTRACT_TASK = 'evolution-graph-extract'` const; populated graph records readable via existing `read`/`find`/`expand` (Task 2's only dependency on this task).

- [ ] **Step 1: Write the failing registration test**

Append a new top-level `describe('heartbeat extraction')` to `packages/evolution/evolution-graph/tests/graph.spec.ts`, reusing the file's existing imports (`Context`, `Storage`, `DomainFacility`, `MemoryMediaPool`, `MemoryStorageBackend`, `EvolutionGraph`) — the storage wiring below copies the file's `harness()` lines 36-43 verbatim, and the `llm` provide is included because Step 3 adds `'llm'` to static inject (providing it early is harmless):

```ts
describe('heartbeat extraction', () => {
  it('registers the extract task on the heartbeat seam', async () => {
    const tasks: Array<{ name: string; intervalHours: number; run: (signal: AbortSignal) => Promise<void> | void }> = []
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    ctx.provide('llm', { stream: () => (async function* () {})() } as never)
    ctx.provide('evolutionHeartbeat', {
      register: (task: { name: string; intervalHours: number; run: (signal: AbortSignal) => Promise<void> | void }) => {
        tasks.push(task)
        return () => {}
      },
    } as never)
    const fiber = await ctx.plugin(EvolutionGraph, {})
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.name).toBe('evolution-graph-extract')
    expect(tasks[0]?.name).toBe(EVOLUTION_GRAPH_EXTRACT_TASK)
    expect(tasks[0]?.intervalHours).toBe(6)
    await fiber.dispose()
  })
})
```

(`EVOLUTION_GRAPH_EXTRACT_TASK` is added to the `../src/index.ts` import next to the existing `resolveConfig` import.)

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm exec vitest run packages/evolution/evolution-graph --reporter=dot 2>&1 | tail -n 5`
Expected: FAIL (`tasks` is empty — no registration exists).

- [ ] **Step 3: Implement Config + inject + registration (no run body yet)**

In `packages/evolution/evolution-graph/src/index.ts`: add `intervalHours?: number` (`z.number().step(1).min(1).default(6)`, resolve `?? 6`) and `profile?: string` (`z.string().default('default')`, resolve `?? 'default'`, comment: matches the `profile: default` rows in `packages/bundle/web-app/cordis.patch.yml`). Change `static inject` to `['storageDomain', 'llm']`. Export `export const EVOLUTION_GRAPH_EXTRACT_TASK = 'evolution-graph-extract'`. In `[Service.init]`, after `this.table = domain.table('records')`, declare the local `HeartbeatSeam` interface + `isHeartbeatSeam` guard (copy `packages/evolution/evolution-memory/src/index.ts:754-776`, renaming nothing) and register inside `ctx.effect`, mirroring lines 804-816 with effect name `'evolution-graph.heartbeatTask'`:

```ts
const heartbeat: unknown = this.ctx.get('evolutionHeartbeat')
if (!isHeartbeatSeam(heartbeat)) return
this.ctx.effect(
  () => heartbeat.register({
    name: EVOLUTION_GRAPH_EXTRACT_TASK,
    intervalHours: this.resolved.intervalHours,
    run: (signal: AbortSignal) => this.extractPending(signal),
  }),
  'evolution-graph.heartbeatTask',
)
```

Add the stub `private async extractPending(_signal: AbortSignal): Promise<void> {}` (body comes in Step 6; the underscore prefix marks the unused param under strict lint).

- [ ] **Step 4: Run the registration test, watch it pass**

Run: `pnpm exec vitest run packages/evolution/evolution-graph --reporter=dot 2>&1 | tail -n 5`
Expected: PASS (1 passed; other suites untouched).

- [ ] **Step 5: Write the failing buffer + extraction tests**

Append inside `describe('heartbeat extraction')` (reuse the Step 1 ctx setup; the file's `harness()` already provides a scripted `llm` stream via `answer('...')` chunks — new tests that need custom chunks replicate the harness with their own `chunks` argument shape, i.e. copy `harness()` adding a `chunks` parameter defaulting to `answer('{"triples":[]}')`):

```ts
it('extracts buffered scope text and clears the buffer on success', async () => {
  // ctx with workspaceRegistry fake: { list: () => [{ id: 'ws', sessionIds: [session.id] }] },
  // session with requestHeader() -> { config: { provider: 'p', model: 'm' } },
  // llm chunks answer('{"triples":[{"from":"Ava","relation":"worked_on","to":"Atlas"}]}').
  // Append a user/message event carrying text 'Ava worked on Atlas', capture tasks[0].run(new AbortController().signal),
  // then: expect(graph.find(EvolutionScopeId('default', 'ws'), 'ava')).toHaveLength(1);
  // run again -> llm stream call count unchanged (buffer cleared, idle skip, zero new calls).
})
it('makes no LLM call when no scope has buffered text', async () => {
  // run() on a fresh graph -> llm stream call count stays 0.
})
it('skips scopes whose route cannot be resolved', async () => {
  // requestHeader() returns undefined and no configured provider/model:
  // run() -> llm stream never called.
})
it('clears the buffer even when extraction fails', async () => {
  // llm chunks answer('not json'): run() completes (per-scope catch), second run() makes no new llm call for the same text.
})
```


Decision locked here: `run()` catches per-scope errors internally (one bad scope must not starve the others) and ALWAYS clears the attempted batch (at-most-once delivery, no poison retry loop).

- [ ] **Step 6: Implement the buffer + run**

State: `private readonly pending = new Map<string, { scope: EvolutionScopeId; sessionIds: SessionId[]; texts: string[]; bytes: number }>()` keyed by `String(scope)` (`SessionId` type already importable from `@deepseek-ai/dsh-session`; record the event's `session.id` alongside its text, deduplicated). In `[Service.init]`, `ctx.on('session/event', ...)` (disposal follows ctx lifetime; follow active-memory's `ctx.effect` cache-clear pattern with effect name `'evolution-graph.pendingText'`): for `user/message` and `assistant/message` events, extract text parts (mirror active-memory `textOf`: concatenate `message.content` parts where `part.type === 'text'`), resolve workspace via `ctx.workspaceRegistry` obtained with `ctx.get` + guard (absent → skip event), scope = `EvolutionScopeId(this.resolved.profile, String(workspace.id))`. Append while `bytes + textBytes <= maxInputBytes`, else shift the oldest texts out first until it fits or the buffer is empty (a single text larger than the cap is dropped whole). `run(signal)`: iterate buffered scopes (bail between scopes when `signal.aborted`); route = configured `{provider, model}` pair if both set, else the first buffered `sessionIds` entry's `requestHeader()` route via `ctx.sessions.get(id)` (mirror reviewer `resolveTurnRoute`); route undefined → keep the buffer and continue; else `try { await this.extract(scope, texts.join('\n'), route, signal) } catch { /* per-scope isolation */ }` with `pending.delete(key)` executed on both paths (at-most-once).

- [ ] **Step 7: Run tests + coverage for the package**

Run: `pnpm exec vitest run packages/evolution/evolution-graph --reporter=dot 2>&1 | tail -n 5` — Expected: all PASS.
Coverage recipe: `pnpm exec vitest run packages/evolution/evolution-graph --coverage --coverage.include='packages/evolution/evolution-graph/src/**' --coverage.reporter=json --coverage.reportsDirectory=/tmp/covgraph` then parse `coverage-final.json` for zero-coverage statements/branches (recipe used before — every touched line must be hit).

- [ ] **Step 8: Commit**

```bash
git add packages/evolution/evolution-graph/src/index.ts packages/evolution/evolution-graph/tests/graph.spec.ts
git commit -m "feat(evolution-graph): heartbeat extraction producer with consume-on-success buffer"
```

### Task 2: Graph leg in `active-memory-context` pre-step

**Files:**
- Modify: `packages/context/active-memory-context/src/index.ts` (Config + graph leg)
- Modify: `packages/context/active-memory-context/src/render.ts` (scoreless hits)
- Test: `packages/context/active-memory-context/tests/index.spec.ts` (append describes)

**Interfaces:**
- Consumes: graph `find(scopeId, query, 1): GraphNode[]`, `expand(scopeId, label, depth, limit): GraphReach[]` (`GraphReach = { node: GraphNode; path: string[]; depth: number }` — node labels via `.node.label`), existing `searchSessions({query, sessionFilters, limit})` returning `SessionSearchHit[]`, existing `fuseSessionRankings(...rankings)` from `@deepseek-ai/dsh-session-query/fusion`, `EvolutionScopeId` from `@deepseek-ai/dsh-evolution-memory`, existing `scopeSessionIds`/`others` closure values inside `apply`.
- Produces: fused briefs through the widened `renderActiveMemoryBrief` + unchanged pre-step splice (no new exports except Config fields).

- [ ] **Step 1: Write the failing renderer test**

In `packages/context/active-memory-context/tests/index.spec.ts` (or the render spec if one exists — check first, follow it):

```ts
it('renders fused hits that carry no vector score', () => {
  const hits = [{ header: { id: 's1' }, bestMatch: { time: 10, snippet: 'atlas launch' } }] as never
  const text = renderActiveMemoryBrief(hits, 4096)
  expect(text).toContain('[session s1 @')
  expect(text).not.toContain('similarity')
})
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm exec vitest run packages/context/active-memory-context --reporter=dot 2>&1 | tail -n 5`
Expected: FAIL (renderer requires `score`; `.toFixed` on undefined throws).

- [ ] **Step 3: Widen the renderer**

Change `renderActiveMemoryBrief` param to `readonly (SemanticSessionSearchHit | SessionSearchHit)[]` (import type `SessionSearchHit` alongside the existing import) and `buildText` line to:

```ts
const similarity = 'score' in hit && typeof hit.score === 'number' ? `, similarity ${hit.score.toFixed(2)}` : ', via graph connections'
return `${index + 1}. [session ${hit.header.id} @ ${when}${similarity}] ${escapeFrameBody(hit.bestMatch.snippet)}`
```

(`'score' in hit` narrows the union without a cast; both existing scored tests keep passing unchanged.)

- [ ] **Step 4: Run renderer tests, watch them pass**

Same command. Expected: PASS (old + new).

- [ ] **Step 5: Write the failing graph-leg tests**

```ts
it('merges graph-neighbor sessions into the brief', async () => {
  // harness with fake embeddings (existing fakeEmbeddings), workspace with sessions s1 (live) + s2, s3;
  // provide 'evolutionGraph' fake: find -> [{ id: 'atlas', label: 'Atlas' }], expand -> [{ node: { id: 'ava', label: 'Ava' }, path: ['worked_on'], depth: 1 }];
  // persist s2 mentioning 'Atlas', s3 mentioning 'Ava' (existing persist/messageEvents helpers);
  // pre-step with query 'atlas' -> briefsOf(decision.messages) contains sessions s2 AND s3.
})
it('behaves exactly as today when no graph is mounted', async () => {
  // same harness minus the graph provide: decision messages equal the vector-only result (compare against a run with graph mounted but empty? simplest: assert no throw + brief present from vector hits).
})
it('passes through when the graph is empty', async () => {
  // provide graph whose find returns [] -> brief equals vector-only brief (assert s3 absent).
})
```

- [ ] **Step 6: Implement Config + graph leg**

Config additions (interface + zod + `resolveConfig`, following the existing `topK` pattern): `profile?: string` (zod `.default('default')`, comment: must match the profile the scope's graph was extracted under), `graphDepth?: number` (zod step/min/default 1), `graphLimit?: number` (zod step/min/default 5). Local `isGraphSeam` guard mirroring evolution-memory's `isHeartbeatSeam` (`find` and `expand` functions via `Reflect.get`). Inside `apply`, after the existing `search` closure, add:

```ts
const searchGraph = async (
  session: Session,
  scopeIds: readonly SessionId[],
  query: string,
): Promise<readonly SessionSearchHit[]> => {
  const graph: unknown = ctx.get('evolutionGraph')
  if (graph === null || typeof graph !== 'object' || !isGraphSeam(graph)) return []
  const workspace = /* workspace entry for session, reuse memberSessionIds-equivalent: find list entry whose sessionIds includes session.id */
  if (workspace === undefined) return []
  const scope = EvolutionScopeId(profile, String(workspace.id))
  let seed: GraphNode | undefined
  try {
    seed = graph.find(scope, query, 1)[0]
  } catch { return [] }
  if (seed === undefined) return []
  let reached: readonly GraphReach[]
  try {
    reached = graph.expand(scope, seed.label, graphDepth, graphLimit)
  } catch { return [] }
  const labels = [...new Set([seed.label, ...reached.map(entry => entry.node.label)])].slice(0, graphLimit)
  const others = scopeIds.filter(id => id !== session.id)
  const out: SessionSearchHit[] = []
  for (const label of labels) {
    try {
      const page = await ctx.sessionQuery.searchSessions(
        { query: label, sessionFilters: [{ kind: 'id', values: others }], limit: topK },
      )
      out.push(...page.items)
    } catch (error) {
      if (error instanceof SessionQueryError) continue
      throw error
    }
  }
  return out
}
```

(`GraphNode`/`GraphReach` types: `import type` from `@deepseek-ai/dsh-evolution-graph` — check that package's export name in its package.json first; the pre-step handler then becomes: `const vectorHits = await search(...)` (existing call, keep threshold filter); `const graphHits = await searchGraph(...)` wrapped so it never throws past the existing fail-soft contract; `const fused = fuseSessionRankings(vectorHits, graphHits)`; render `fused` (type now `(SemanticSessionSearchHit | SessionSearchHit)[]`); note the existing `if (hits.length === 0) return decision` becomes `if (fused.length === 0) return decision`. Import `fuseSessionRankings` from `@deepseek-ai/dsh-session-query/fusion` and `EvolutionScopeId` from `@deepseek-ai/dsh-evolution-memory`.)

- [ ] **Step 7: Run tests + coverage for the package**

Same vitest + JSON coverage recipe with `--coverage.include='packages/context/active-memory-context/src/**'`. Expected: all PASS, zero uncovered statements/branches.

- [ ] **Step 8: Commit**

```bash
git add packages/context/active-memory-context/src/index.ts packages/context/active-memory-context/src/render.ts packages/context/active-memory-context/tests/index.spec.ts
git commit -m "feat(active-memory-context): graph-neighbor leg fused into pre-step briefs"
```

### Task 3: Docs, gates, boot proof

**Files:**
- Modify: `packages/evolution/evolution-graph/README.md` + `.zh.md` (producer section + `intervalHours`/`profile` rows), `packages/context/active-memory-context/README.md` + `.zh.md` (graph leg + `profile`/`graphDepth`/`graphLimit` rows) — mirror the table style already in `packages/llm/embeddings-http/README.md:39-46`.
- Modify: `docs/config-catalog.md` + `.zh.md` via `pnpm run gen-config-catalog` + manual ZH hunk mirror (code blocks copied verbatim, as done before).
- Create: `.agents/notes/implemented/architecture/2026-09-1X-graph-vector-fusion.md` + `.zh.md` (problem/decision/alternatives/consequences; alternatives must record edge-provenance and side-index rejection + watermark→buffer deviation).

**Interfaces:** none (docs only).

- [ ] **Step 1: README tables + catalog regen**

Edit the four README tables, run `pnpm run gen-config-catalog`, `git diff -- docs/config-catalog.md` to confirm only the new fields appear, mirror those hunks into `.zh.md`.

- [ ] **Step 2: Agent Note + pairing**

Write both note files, run `pnpm exec tsx scripts/verify-translation-pairing.ts --write <all six touched pairs, named explicitly>` then `pnpm exec tsx scripts/verify-translation-pairing.ts` and confirm zero issues in touched files (pre-existing unrelated issues stay).

- [ ] **Step 3: Full verification**

Run in order: `pnpm exec tsc -b packages/evolution/evolution-graph packages/context/active-memory-context --force`, `pnpm exec tsx scripts/run-oxlint.ts packages/evolution/evolution-graph packages/context/active-memory-context` (expect 0 warnings 0 errors), both package suites once more, then `for g in verify-cordis-config verify-config-catalog verify-cordis-catalog verify-doc-graphs verify-subsystem-pages verify-tsconfig-paths`.

- [ ] **Step 4: Rebuild + boot lane**

Run: `pnpm run build:lib:host`, then `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/shipped-composition.e2e.ts --reporter=dot`. Expected: same 2 pre-existing failures (`skill_manage` global, approval-outside-turn) and nothing new — the composition must boot with the graph `llm` inject addition. If either previously-failing assertion now passes or a new one fails, stop and report rather than updating expectations.

- [ ] **Step 5: Commit + push**

```bash
git add <docs + catalogs + notes + i18n yamls>
git commit -m "docs: graph-vector fusion READMEs, catalog, agent note"
git push origin main
```

## Self-review

- Spec coverage: producer (§1: heartbeat task, watermark→buffer deviation noted above, llm inject fix) → Task 1; consumer (§2: find/expand/FTS/RRF, fail-soft, Config) → Task 2; errors (§3) → Task 1 Step 6 + Task 2 Step 6; tests (§4) → Task 1 Steps 5/7 + Task 2 Steps 5/7. No gaps.
- Placeholders: every step names exact files, symbols, line-anchored patterns to mirror, and exact commands with expected outcomes. The Task 2 Step 5 harness references existing helpers (`fakeEmbeddings`, `persist`, `messageEvents`, `briefsOf`, `preStep`) by their actual names in `tests/index.spec.ts`.
- Type consistency: `SessionSearchHit`/`SemanticSessionSearchHit`/`GraphNode`/`GraphReach`/`EvolutionScopeId` used identically across Tasks 1–2; renderer union type matches what `fuseSessionRankings` returns.
