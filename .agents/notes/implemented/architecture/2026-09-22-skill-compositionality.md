# Agent Note: Skill compositionality, utility, and synthesis

Status: implemented

English | [中文](2026-09-22-skill-compositionality.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §11 asks for a skill library that composes rather than retrieves one skill at a time, §40 judges a skill by downstream value, and §41 turns the library into a graph. Three of those mechanisms had no implementation, and one had a declaration that told the truth about it:

- **§40 had no record.** `SkillUsageRecord` counted loads, views, and patches and carried trust, but nothing paired a skill with how its tasks turned out. `evolution-metrics` declared `skill-incremental-utility` structurally unmeasurable, with the reason spelled out: "no store pairs a skill-using run with a run that used no skill".
- **§11's frontmatter was missing four keys.** The provider parsed `requires`, `conflicts_with`, and `capabilities`, and the loader refused a load set with a declared conflict — but `inputs`, `outputs`, `compatible_with`, and `composable_with` were not in the key map at all, so the only composition the library could express was "prerequisite" and "rival".
- **Nothing synthesized a skill.** §11's last sentence — "the evolution engine should be able to synthesize new skills from existing primitives" — had no operation. `skill_manage` could create, patch, edit, write, remove, and delete; a skill derived from two others could only be created by hand, with no lineage recorded.

The composition rule already existed in exactly one place: `tool-skill`'s `compositionConflict`, enforced on a load set. The risk in extending it was a second convention beside it.

## Decision

Extend the existing seams; add no package, no store, and no domain.

1. **One composition implementation, in the package that owns the vocabulary.** `packages/skill/skill/src/composition.ts` holds `compositionRefusal` (a load set: conflicts, then a `compatibleWith` allowlist) and `composabilityRefusal` (a synthesis source set: the same allowlist over `composableWith`), both over one `CompositionMember` shape. `tool-skill`'s `compositionConflict` is gone; `composePrerequisites` calls `compositionRefusal` directly, so the loader's conflict branch and its new incompatibility branch are one code path with the synthesis check beside it. The failure text for a conflict is byte-identical to the text the loader already shipped.
2. **The four keys are declarations, not gates — except at the two points that assemble a set.** `inputs` and `outputs` are carried like `capabilities`: validated, projected onto the summary, and changing nothing on their own. `compatible_with` and `composable_with` are allowlists: a non-empty list on any member refuses a set containing a name it does not list. An absent or empty list constrains nobody — an empty allowlist is not a skill that refuses every sibling — and a declaration naming a skill outside the set in front of it is ignored, because neither the loader nor the derivation owns skills it was not asked about.
3. **Utility is derived, and named for exactly what it measures.** The record gains `sessionOutcomes`: one graded outcome per loading session, written by the same `recordTrustObservation` calls the curator's trust pass already makes, newest first, deduplicated by session, capped by `maxSessionIds`, and cleared when the body changes like trust. `utility(name)` reads the §40 shape from those counters — `uses`, `assistedTasks`, `successfulTasks`, `incrementalGain`, `costOverhead` — in a pure module (`src/utility.ts`), so the derivation is a unit test rather than a host fixture.
4. **The honest proxy is the library-relative success excess.** This harness records no skill-free run, so a true `incremental_gain` has no control arm. `incrementalGain` is the skill's clean-outcome share minus the pooled clean-outcome share of the other tracked skills: it answers "is this skill better than the library's other skills", never "is it better than doing without one". It is `null` rather than zero when either share is missing. Both the JSDoc and the README say this in those words and record the missing arm as a limitation.
5. **`costOverhead` is recorded work, not a guess**: `uses / successfulTasks` — the loads the store counted per success it graded, `null` when no assisted task succeeded because a success is the denominator.
6. **Synthesis is one new op on the writer that already exists.** `skill_manage derive` takes the new skill's complete file text plus at least two source names, refuses a source set that is short, duplicative, self-naming, or unknown, applies `composabilityRefusal`, and writes through `buildDerivedSkillFile`, which replaces whatever `derived_from` the caller's head declared with the sources actually composed. It reaches production through the tool the product profile already mounts, and it is gated by the same head invariant `edit` enforces: `splitSkillFile` runs the split and `validateSkillHead` together, and both operations call it. One implementation of the invariant, not two.

## Alternatives considered

- **A second composition function inside `tool-skill`.** Rejected: `skill_manage` needs the same pair rule for a source set, and two implementations of one relation is exactly the drift the package's other one-table designs exist to prevent.
- **Making `inputs`/`outputs` satisfy a `requires` entry the way `capabilities` does.** Rejected: it would change what the offline ranker considers routable and what the loader resolves, and §11 lists the keys as declarations beside `capabilities`. The ranker and the loader keep the rule they shipped.
- **Treating an empty `compatible_with` as "compatible with nothing".** Rejected: a malformed or emptied list would then silently refuse every composition, and the shipped malformed-value contract for every other list key is to drop the declaration, not to invert it.
- **A `derive` that reads the sources' bodies and concatenates them.** Rejected: it would make the child's content a function of file reads the tool does not otherwise perform, and it would put synthesis text in the tool rather than in the model's hands. The op writes the body the model authored and records only the lineage.
- **Recording outcomes inside a new store or a new domain table.** Rejected: the outcome belongs to the session that loaded the skill, which is already the key the record's `sessionIds` correlation uses; a second store would need the same lookup and could disagree with it.
- **Writing a second store event when a utility reading is produced.** Rejected: nothing in this change reaches a model prompt — `utility()` is a synchronous read for a host caller — so there is no model-visible fact that would require a session event.
- **Storing a numeric gain per skill as a passed-in field.** Rejected: a caller-supplied gain would be unaccountable, and §40's value comes precisely from deriving it from recorded evidence.
- **Clearing `sessionOutcomes` inside `resetTrust`.** Rejected after the first draft: `resetTrust` is also called on a trust demotion, where the session's outcome is the fact being recorded, so clearing there would erase the observation that caused the reset. The body-changing operations (`markPatched`, `markRevised`) clear it explicitly instead.

## Consequences

- `evolution_skill_usage` moves to domain version 2 with `compatibleVersions: [1]`; records written under version 1 open unchanged because `sessionOutcomes` is defaulted.
- `SkillSummary`, `SkillCandidate`, `SkillDefinition`, and `SkillRegistration` all carry the new declarations, and the registry validates them through one `CARRIED_STRING_LISTS` table shared by the projection and the validation, so the two can never disagree about which declarations exist.
- Every frontmatter key map entry is derived from `STRING_LIST_FRONTMATTER_FIELDS`, so `inputs`, `outputs`, `compatible_with`, `composable_with`, and `derived_from` are recognized by the same table that parses them and no longer warn as unknown keys.
- A load set can now be refused for a reason it could not be before, and the tool result names the pair. The product profile's model-visible behavior is otherwise unchanged: the refusal reason is new text, not a new tool, argument, or catalog field.
- `evolution-metrics`' declaration that `skill-incremental-utility` is unmeasurable is now one step closer to false — the recorded outcomes it said were missing now exist — but it stays accurate as written, because the reason it names is the absent no-skill control, and this change does not add one.

## Deviations from the plan

The task named four packages as owned and required extending `composePrerequisites`/`compositionConflict`, which lives in `packages/skill/tool-skill`. Ownership was confirmed with the parent before editing, and `tool-skill` is included here for that reason: one function deleted, one import added, one call site swapped, one README triple updated. No other package was touched.

§11's `composable_with` is enforced on synthesis and `compatible_with` on loads; the offline ranker and the behavior routing gate still read only `requires`, `capabilities`, and `conflicts`, because they judge candidates one at a time and have no set to check an allowlist against. That is recorded as a limitation rather than approximated.

## Fixes found on the way

None. One suspicion was investigated and dismissed: [the relation-composition note](2026-09-21-skill-relation-composition.md) renders the loader's conflict text as `skill "A" cannot load: "B" and "A" declare a conflict` for `A requires B` with `B conflicts_with A`, which reads like the requested skill being named second in the wrong order. It is not — the text names the declaring owner first, and in that example the owner is `B` — so the note, the shipped string, and the tool-skill test all agree.

## Testing

`packages/skill/skill/tests/composition.spec.ts` covers both rules without a context: an undeclared set, a conflict declared from either side, a self-declaration and an out-of-set declaration ignored, an allowlist that refuses and one that admits, an empty allowlist that constrains nobody, and both directions of an incompatible synthesis. The package's `skill.spec.ts` gains the summary/definition/runtime carrying test for all five new declarations and one invalid-shape case per declaration.

`packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` parses all five frontmatter keys, asserts each malformed value warns and drops only that declaration, and asserts a plain skill carries none of them.

`packages/skill/evolution-skill-telemetry/tests/telemetry.spec.ts` covers the utility reading against a real store: uses and graded sessions from recorded outcomes, the gain against peers as the pooled share moves, both `null` cases, the clear-on-rewrite behavior, per-session dedup and bound, and the absent-record read.

`packages/skill/evolution-skill-manage/tests/manage.spec.ts` covers synthesis end to end: a valid derived file whose frontmatter names both parents and whose telemetry row matches the written hash, a caller-declared lineage replaced by the composed sources, every refusal branch, a derived body that breaks the head invariant, and the `EEXIST` collision.

`packages/skill/tool-skill/tests/tool-skill.spec.ts` covers the new refusal through the real `skill` tool, plus the composition the allowlist admits.

## Left alone

The utility reading is recorded, not enforced: nothing routes, ranks, or hides a skill because of its `incrementalGain`, and the curator's staleness and consolidation policy still read the counters it already read. Wiring the reading into a policy would make a derived number drive a destructive transition, which needs the no-skill control the harness does not have. `evolution-metrics`' `skill-incremental-utility` stays declared unmeasurable for the same reason, and the domain's `sessionOutcomes` stays bounded by `maxSessionIds` rather than unbounded, because the list is per-skill durable state and its growth is what the cap exists to bound.
