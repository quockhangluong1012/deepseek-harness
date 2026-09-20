# Agent Note: Skill prerequisites (`requires`) end to end

Status: implemented

English | [中文](2026-09-20-skill-prerequisites.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` P1 item 15 (skill compositionality, §11) needs skills to declare what they build on, and the Harness had no such declaration: frontmatter carried tool requirements (`requires_tools`) but nothing skill-to-skill, so the selector could route to a skill whose prerequisites were absent from the catalog — a candidate that cannot work, ranked on its prose alone. The ranker (`rankSkills`) scored every candidate on lexical fit, vectors, and utility with no notion of routability.

## Decision

Prerequisites ride the exact pipeline tool requirements already use, extended one step further because selectors (not loaders) consume them:

1. **Frontmatter** (`dsh-skill-filesystem`): `requires` joins the `STRING_LIST_FRONTMATTER_FIELDS` table (same spelling both sides, `platforms` precedent), so parsing, the recognized-key allowlist, and the malformed-value warning derive from one row. Malformed values warn and drop; the skill still loads.
2. **Definition and summary** (`dsh-skill`): `SkillDefinition` and `SkillSummary` gain optional `requires`; `validateDefinition`, `validateCandidate`, and runtime registration validate it with the existing `validateStringArray` helper; `toSummary`, filesystem `list()` candidates, and `runtimeCandidate` carry it. It reaches the summary deliberately: unlike `requiredEnv`/`config` (load-time), prerequisites are routing-relevant, and `whenToUse` sets the precedent for routing text in summaries.
3. **Selector gate** (`rankSkills`): a `requires` map by skill name, mirroring the `signals` option shape. A skill with any prerequisite absent from the candidate set scores zero — a routability gate, not a quality demotion. No new tunable: presence in the set is the whole rule.
4. **Evaluation consumer** (scorer `checkBehaviorRouting`): `BehaviorCatalogSkill` carries optional `requires`, forwarded into the same selector call, so a candidate requiring an absent skill fails every positive query — routing to it could never work.

`conflicts_with`/`composable_with` synthesis stays deferred: exclusion needs no new data, but conflict resolution (which of two conflicting skills wins) is a selection policy this slice does not invent.

## Alternatives considered

- **Hiding unmet-requirement skills at discovery, like `requires_tools`** — rejected: the provider cannot know which siblings are routable in a given call; only the selector holding the candidate set can judge. Gating stays with the selector, parsing stays with the provider.
- **Demoting instead of zeroing (a 0.5 compatibility factor)** — rejected: a missing prerequisite is not weak evidence, it is an unworkable routing; a factor would need calibration data nobody has, while zero is the honest reading of "cannot work".
- **A separate compatibility service or registry method** — rejected: one owner per seam; the ranker already owns scoring, and a second scoring path would need the same candidate set passed twice.
- **Putting `requires` through `skill_manage create` args** — deferred: `buildSkillFile` writes name/description only, and frontmatter hand-editing plus `edit` preservation carry the field today; tool support waits for a caller that sets prerequisites at creation time.

## Consequences

- A skill declaring `requires: [base]` routes normally when `base` is catalogued and scores zero everywhere when it is not — including inside the behavior-evaluation routing gate, which now proves prerequisites alongside triggers.
- Malformed `requires` degrades exactly like every other string-list field: one warning per parse, skill still loads.
- The stale-build lesson is recorded below; no source changes were needed for it beyond deleting the stray file.

## Deviations from the plan

- Stray build artifact found during verification: a stale compiled `index.js` sitting beside the skill package's `src/index.ts` (dated 9/15, gitignored) shadowed the TypeScript source for package-root imports, because directory resolution prefers `index.js` over `index.ts`. Every `skill.spec.ts` failure in this slice — including the five scoped-layer cases previously recorded as pre-existing standalone failures — passed once the file was deleted. The lesson: a red test file that imports the package root first suspects a stray emitter before suspecting the code; `verify-no-src-js` exists for exactly this class.
- Only `requires` ships: no `conflicts_with`, no `provides`/`composable_with`, no synthesis of new skills from primitives. Those remain P1-15 remainder with this slice as their data-model precedent.

## Testing

- `skill-filesystem.spec.ts`: `requires` parsed without warning and surfaced on `get()` and `list()` summaries; malformed scalar warns per parse (listing + load) with nothing else warning.
- `skill.spec.ts`: malformed `requires` rejected in definitions; prerequisites carried on runtime summaries; all 41 tests pass — including the scoped-layer cases, which the stray-artifact deletion also fixed.
- `rank.spec.ts`: unmet prerequisite scores zero with rough score intact; met/undeclared prerequisites leave scores byte-identical.
- `behavior.spec.ts`: candidate requiring an absent skill fails every positive at last rank; requiring a present skill routes as before.
- 100% statements/branches/functions on `skill/src/index.ts`, `skill/src/rank.ts`, `scorer/src/behavior.ts`; filesystem gaps are pre-existing POSIX-symlink branches skipped on Windows, untouched by this change.
- `typecheck` passes repo-wide; `lint` clean for all touched files; `verify-translation-pairing`, `verify-export-jsdoc` (no new-symbol findings), `verify-no-hardcoded-tunables`, and agent-note gates pass. `verify-doc-budgets` and `verify-md-links` stay red on pre-existing entries only.

## Left alone

- P1-15 remainder: `conflicts_with`, `composable_with`/`provides`, skill-graph relations, and synthesis from primitives.
- Optimizer catalog builders do not supply `requires` yet (foreign WIP owns that file); the gate waits in `checkBehaviorRouting` for catalogs that carry it.
- P1-17 benchmark corpus writing needs recorded-fixture synthesis and stays a later slice; P1-16/19/20, P2, and P3 families likewise remain queued.
