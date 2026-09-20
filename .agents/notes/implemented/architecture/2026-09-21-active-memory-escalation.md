# Agent Note: Active-memory escalation lane (graph-first)

Status: implemented

English | [中文](2026-09-21-active-memory-escalation.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` P1 item 18 requires Active Memory to grow an escalation lane instead of running its full retrieval every turn. `dsh-active-memory-context` ran both legs — the vector leg (one query embedding call per eligible turn) and the graph leg (local lookups plus text searches, no embedding call) — on every eligible turn, and its README documented exactly that cost with no way to avoid it: "One embedding call per eligible turn". The graph leg was already the cheap lane, but nothing could run first while the expensive lane waited.

## Decision

One opt-in `Config` mode, `escalation: 'both' | 'graph-first'`, defaulting to `'both'` so historical behavior is unchanged unless a deployment asks for escalation. Under `'graph-first'` the pre-step handler runs the graph leg first and spends the vector leg's embedding call only when the graph leg returns nothing. A missing, inapplicable, or empty graph leg degrades to the vector leg exactly as before, so escalation never loses the vector-only fallback: it only skips the vector call on turns the graph already answered. The trigger is deliberately hit-count, not a similarity threshold — the graph leg's hits are unscored connections, so "at least one connection" is the only honest gate, and it introduces no tunable the deployment must calibrate.

## Alternatives considered

- **Reversing the default to `graph-first`** — rejected: skipping the vector leg changes recall shape (a session only similarity would find stays buried), and a silent recall change in a shipped default is a product behavior change beyond this slice.
- **A similarity-style threshold on the graph leg** — rejected: graph hits carry no scores by design, so any threshold would be invented precision; hit-count is what the leg can honestly report.
- **Cross-turn result caching** — rejected: the query differs every turn by design, so a cache would almost never hit; the README already documents this, and escalation attacks the per-turn embedding call instead.
- **Running the vector leg first and skipping the graph leg on vector hits** — rejected: that saves only the cheap leg's text searches while always spending the embedding call, which inverts the economics.

## Consequences

- Deployments that mount the graph can trade similarity-only recall for one fewer embedding call per graph-answered turn, with the tradeoff stated in the README rather than hidden.
- `both` keeps every existing composition's behavior byte-identical; the mode is validated Config changeable from cordis.yml, following the no-hardcoded-tunables rule.
- The config catalog carries the new field in both languages via `gen-config-catalog`.

## Deviations from the plan

- None: the slice is the §53 upgrade row scoped to one package, one Config field, and one pre-step branch.

## Testing

- Four new `index.spec.ts` cases: vector skipped (zero embedding batches) with graph-only brief when the graph connects; escalation to the vector leg when the graph finds nothing; vector fallback with no graph mounted; default `both` still spending the embedding call beside graph hits. Both `resolveConfig` cases extended for the new field.
- 100% statements/branches/functions on `src/index.ts` and `src/render.ts`, confirmed from the JSON coverage report for the affected-package run (50 tests, 2 files, all passing).
- `gen-config-catalog` regenerated (EN+ZH); translation pairing re-recorded and consistent.

## Left alone

- P1 items 14, 15, 17, 19, 20 and the P2/P3 families remain future slices; the audit driving this order lives in the session record.
- No cross-turn cache, no learned routing of lanes: the lane decision stays a static Config choice until measured retrieval misses justify more.
