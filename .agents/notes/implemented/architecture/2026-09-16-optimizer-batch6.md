# Agent Note: Batch 6 optimizer (mutation + Pareto + staged deploy)

Status: implemented

English | [中文](2026-09-16-optimizer-batch6.zh.md)

## Problem

Review-v6 §4.4 steps 4-5 asked for the minimal optimizer: a mutation loop reusing the curator's LLM pattern, Pareto over the scorer's triple, and staged (never automatic) deploy. Two of the review's literal instructions could not be followed: the corpus cannot be mined from the trajectory export (Batch 5 note), and the curator's two-tool verdict loop fits multi-skill consolidation, not single-skill mutation. The design presented for this batch resolved both before building.

## Decision

**New package `dsh-evolution-optimizer`, service `ctx.evolutionOptimizer`.** `optimize({skill, scenarios, scopeId, originSessionId, agent?, run?, evidence?, signal?})` runs: trigger gate (the scorer's `shouldOptimize`, not a copy) → read body via `ctx.skills.get` → one `ctx.llm` generate framed like the curator's input (fixed instruction, byte budget that halves evidence never the body) → re-score the baseline and every variant under the same harness → Pareto pick → one `stageWrite` with `kind: 'skill'`, `op: 'patch'`.

**Variant isolation is structural.** Each body scores inside a fresh `DSH_HOME` overlay (`skills/<name>/SKILL.md`) layered into the runner environment; the user's live skills are never touched and the overlay is removed in a `finally`. The baseline is re-scored under the same overlay harness rather than reusing an old number, so the comparison is fair by construction.

**Pareto is pure and strict.** Dominance on (pass, tokens, wallTimeMs); the winner must dominate the baseline, tie-broken by tokens then wall time then mutation order. Anything else — empty mutation answer, unbeaten baseline, corpus skip — reports `no-improvement` or `skipped` with a reason and stages nothing.

**Deploy follows the existing skill protocol.** The staged payload carries `{skill, body, baseline, winner}` slim triples as approval evidence; the human writes the skill with skill_manage and `/skills approve` drops the entry. The optimizer ships unmounted (like the scorer): no profile mounts it until a deployment names the agent paths and the provider/model route, and `/curator optimize <skill> <scenario...>` reports `not mounted` honestly until then.

## Alternatives considered

- Mine the candidate corpus from the trajectory export, as the review instructed — rejected: Batch 5 established the corpus cannot be mined there, so the caller supplies `scenarios`.
- Reuse the curator's two-tool verdict loop for mutation — rejected: that loop fits multi-skill consolidation, not single-skill mutation.
- Deploy the winning variant automatically — rejected: the optimizer stages one `stageWrite` and the human still writes the body with skill_manage and drops the entry with `/skills approve`.
- Reuse the baseline's old score instead of re-scoring it — rejected: the baseline runs under the same overlay harness as every variant, so the comparison is fair by construction.
- Give the optimizer its own trigger gate — rejected: the scorer's `shouldOptimize` is called, not copied, so the rule keeps one implementation.
- Mount the optimizer in a profile now — rejected: like the scorer it ships unmounted, and `/curator optimize <skill> <scenario...>` reports `not mounted` until a deployment names the agent paths and the provider/model route.

## Consequences

- A mutation reaches a human only when it strictly dominates the baseline on the scorer's (pass, tokens, wallTimeMs) triple; every other outcome is a reasoned `no-improvement` or `skipped` that stages nothing, so a bad mutation cannot reach a skill.
- Scoring never touches the user's live skills: baseline and variants score inside a fresh `DSH_HOME` overlay that a `finally` removes.
- The deploy path is unchanged for the reviewer — one staged `kind: 'skill'`, `op: 'patch'` payload whose slim triples are the approval evidence — and unreachable until some deployment mounts the optimizer.
- The trigger rule now has a second consumer, so the scorer carries the `Context` augmentation it never declared.
- Ceilings are documented rather than hidden: the overlay serves only `SKILL.md`, so a sibling-dependent variant can mis-score, and prompt-only variants tie under replay (README).
- `'evolution-optimize'` is a third copy of the `purpose` attribution union, and the Config agent carries only the three required paths because schemastery rejects bare optional members inside a nested `z.object` under `exactOptionalPropertyTypes`.

## Testing

29 optimizer tests (pure pareto/mutate plus service orchestration over faked seams: every skip, both throws, empty mutation, baseline/variant skip propagation, the win path asserting the staged `kind`/`op`), 5 CLI tests (usage, unmounted, outside scope, outcome texts, error passthrough). 100% statements/branches/functions/lines on the package; 106 CLI tests pass.

## Fixes found while building

- The scorer never declared its `Context` augmentation, so `ctx.get('evolutionScorer')` typed as `any` and tripped `no-unsafe-assignment` in the new consumer. Added the three-line `declare module` to the scorer (every other seam already has one).
- The `purpose` attribution union is copied in three places (`dsh-llm` options, the DeepSeek extension request, and the replay adapter's call-through). The new `'evolution-optimize'` value went into all three; unifying them is left alone as a wider refactor.
- Schemastery rejects bare optional members inside a nested `z.object` under `exactOptionalPropertyTypes`, so the Config agent carries only the three required paths; per-request overrides still accept the full `AgentUnderTest`.

## Deferred

Corpus mining (unchanged from Batch 5); sibling-aware overlays (the overlay serves only SKILL.md — a variant depending on rewritten siblings can mis-score, documented in the README); prompt-only variants score identically under replay (harness truth, documented).
