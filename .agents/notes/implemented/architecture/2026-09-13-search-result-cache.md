# Agent Note: Search results get a bounded, generation-keyed TTL cache

Status: implemented

English | [中文](2026-09-13-search-result-cache.zh.md)

## Problem

Spec §16.2 describes two things bundled into one Python class: a persisted index reused instead of rebuilt on every search, and a bounded TTL cache of search results, gated behind an `index_health` state machine (`healthy`/`dirty`/`rebuilding`) that decides whether to search the current index, trigger a background rebuild, or block on one.

The first half was already this package's design before this change. The derived SQLite index is persisted across restarts and reconciled incrementally: `_reconcile` compares per-session persistence revisions against the indexed rows and only re-reads what changed, inside one serialized transaction, every search. It is never rebuilt from scratch, so there is no equivalent of `index_health` to track — the index is always current by construction, not eventually current after a lazy rebuild. Adding a health state machine here would be solving a staleness problem this package does not have.

The second half — caching repeated identical searches — was genuinely missing.

## Decision

`@deepseek-ai/dsh-session-query-sqlite` gained a bounded, TTL'd cache of `searchSessions`/`searchEvents` pages (`src/result-cache.ts`, `SessionResultCache`). A repeat request with the same normalized query, page, and corpus generation answers from memory instead of re-running SQLite. Two new `Config` fields, `resultCacheEntries` (default 1000) and `resultCacheTtlMs` (default 3,600,000 — one hour), bound the cache the same way every other tunable in this package is bounded: a validated `Config` field, never a hardcoded constant.

### The cache key carries the corpus generation

The engine already tracks a monotonic generation per corpus (`_globalGeneration` for the whole-corpus `searchSessions` scope, `target.generation` for one session's `searchEvents` scope) so that pagination cursors can detect a corpus change and fail with `SESSION_QUERY_STALE_CURSOR` rather than silently returning an offset into a different corpus.

The result cache reuses the same generation as part of its key: `` `sessions|${fingerprint}|${generation}|${offset}|${limit}` `` and `` `events|${fingerprint}|${target.generation}|${offset}|${limit}` ``. A corpus change increments the generation, which changes every affected key, so a stale page is structurally impossible to serve — there is no invalidation step that could be forgotten or race against a concurrent write.

### Bounds

- `maxEntries` (LRU): oldest-touched entry evicted once the map exceeds the bound. Default 1000, matching the spec's reference `TTLCache(maxsize=1000)`.
- `ttlMs`: an entry answers only within this many milliseconds of being written, regardless of whether the generation changed. Default 3,600,000 (one hour), matching the spec's reference `ttl=3600`.
- The cache is cleared on `close()`, alongside the SQLite handle it now shadows.

## Alternatives considered

**Cache by request and clear entries explicitly on every write.** Rejected: that would require the cache to know about every code path that mutates the corpus and get every one of them right, whereas keying by generation makes that whole class of bug unrepresentable.

**A TTL-only cache — the spec's reference shape (`TTLCache(maxsize=1000, ttl=3600)`).** Rejected: nothing in a request-only key changes when the corpus does, so a page cached moments before a write would keep answering until its TTL lapsed, up to an hour. The existing generation changes every affected key on a corpus change, which is what makes a stale page structurally impossible to serve.

**Port the spec's `index_health` state machine.** Rejected: `_reconcile` already makes the index current by construction on every search, so there is no staleness to move through `healthy`/`dirty`/`rebuilding` — the state machine, its background rebuild, and its blocking rebuild path would all be machinery for a problem this package does not have.

**Key by generation alone and drop `ttlMs`.** Rejected on the record's own terms: correctness would be unchanged, since a same-generation key is current by construction, but the spec's reference carries `ttl=3600` as its second bound alongside `maxsize=1000`, and both defaults here mirror it — dropping the TTL would leave entry age bounded only incidentally by LRU eviction.

## Consequences

- A repeated identical request is answered from memory rather than re-running SQLite, and the engine's observable answers are unchanged: a corpus change moves every affected key, so a cached page can only be served while it is still the page the corpus would produce.
- There is no invalidation step to forget or to race a concurrent write — the cache inherits the generation invariant the pagination cursors already depend on, so a mutation that failed to advance the generation would break pagination in the same breath.
- Memory stays bounded by `resultCacheEntries` (LRU, default 1000) and entries expire after `resultCacheTtlMs` (default 3,600,000 ms), both validated `Config` fields rather than hardcoded constants; `close()` clears the cache alongside the SQLite handle it now shadows.
- The index remains always current by construction — `_reconcile` on every search, no `index_health`, no background or blocking rebuild — so this package carries no staleness state for the cache to coordinate with.

## Verification

- `tests/result-cache.spec.ts`: pure unit tests for `SessionResultCache` (miss, TTL expiry, LRU eviction, overwrite, clear); engine-level tests proving a repeated identical search does not re-run the underlying SQLite query (`vi.spyOn` on the private `_querySessions`/`_queryEvents` methods — TypeScript's `private` is compile-time only, so this is a legitimate way to observe internal call counts without a production test hook) and that a corpus change is reflected immediately rather than serving a page that predates it.
- `tests/sqlite.spec.ts`: extended the existing Cordis `Config` validation test with the two new fields' defaults, configured values, and bounds.
- 100% statement/branch/function/line coverage on the whole package.
