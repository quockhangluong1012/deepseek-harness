# Agent Note: Search results get a bounded, generation-keyed TTL cache

Status: implemented

English | [中文](2026-09-13-search-result-cache.zh.md)

## What changed

`@deepseek-ai/dsh-session-query-sqlite` gained a bounded, TTL'd cache of
`searchSessions`/`searchEvents` pages (`src/result-cache.ts`,
`SessionResultCache`). A repeat request with the same normalized query, page,
and corpus generation answers from memory instead of re-running SQLite.
Two new `Config` fields, `resultCacheEntries` (default 1000) and
`resultCacheTtlMs` (default 3,600,000 — one hour), bound the cache the same
way every other tunable in this package is bounded: a validated `Config`
field, never a hardcoded constant.

## Why only half of the spec's mechanism was missing

Spec §16.2 describes two things bundled into one Python class: a persisted
index reused instead of rebuilt on every search, and a bounded TTL cache of
search results, gated behind an `index_health` state machine
(`healthy`/`dirty`/`rebuilding`) that decides whether to search the current
index, trigger a background rebuild, or block on one.

The first half was already this package's design before this change. The
derived SQLite index is persisted across restarts and reconciled
incrementally: `_reconcile` compares per-session persistence revisions
against the indexed rows and only re-reads what changed, inside one
serialized transaction, every search. It is never rebuilt from scratch, so
there is no equivalent of `index_health` to track — the index is always
current by construction, not eventually current after a lazy rebuild. Adding
a health state machine here would be solving a staleness problem this
package does not have.

The second half — caching repeated identical searches — was genuinely
missing, and is what this change adds.

## Why the cache key carries the corpus generation

The engine already tracks a monotonic generation per corpus (`_globalGeneration`
for the whole-corpus `searchSessions` scope, `target.generation` for one
session's `searchEvents` scope) so that pagination cursors can detect a
corpus change and fail with `SESSION_QUERY_STALE_CURSOR` rather than silently
returning an offset into a different corpus.

The result cache reuses the same generation as part of its key:
`` `sessions|${fingerprint}|${generation}|${offset}|${limit}` `` and
`` `events|${fingerprint}|${target.generation}|${offset}|${limit}` ``. A
corpus change increments the generation, which changes every affected key, so
a stale page is structurally impossible to serve — there is no invalidation
step that could be forgotten or race against a concurrent write. The
alternative (cache by request only, then explicitly clear entries on every
write) would require the cache to know about every code path that mutates the
corpus and get every one of them right; keying by generation makes that
whole class of bug unrepresentable.

## Bounds

- `maxEntries` (LRU): oldest-touched entry evicted once the map exceeds the
  bound. Default 1000, matching the spec's reference `TTLCache(maxsize=1000)`.
- `ttlMs`: an entry answers only within this many milliseconds of being
  written, regardless of whether the generation changed. Default 3,600,000
  (one hour), matching the spec's reference `ttl=3600`.
- The cache is cleared on `close()`, alongside the SQLite handle it now
  shadows.

## Verification

- `tests/result-cache.spec.ts`: pure unit tests for `SessionResultCache`
  (miss, TTL expiry, LRU eviction, overwrite, clear); engine-level tests
  proving a repeated identical search does not re-run the underlying SQLite
  query (`vi.spyOn` on the private `_querySessions`/`_queryEvents` methods —
  TypeScript's `private` is compile-time only, so this is a legitimate way to
  observe internal call counts without a production test hook) and that a
  corpus change is reflected immediately rather than serving a page that
  predates it.
- `tests/sqlite.spec.ts`: extended the existing Cordis `Config` validation
  test with the two new fields' defaults, configured values, and bounds.
- 100% statement/branch/function/line coverage on the whole package.
