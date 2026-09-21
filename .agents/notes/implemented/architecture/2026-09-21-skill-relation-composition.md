# Agent Note: Skill relations — capability-satisfied prerequisites, declared conflicts, composition at load

Status: implemented

English | [中文](2026-09-21-skill-relation-composition.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §11 (P1 item 15) wants a library that composes — "retrieve and compose skill A + skill C + skill F" — and the previous slice landed only the first relation: `requires` was parsed, carried on summaries and definitions, and enforced by zeroing a candidate in `rankSkills` when a prerequisite was absent from the candidate set. Three things were missing. `capabilities` was parsed and carried but read by nothing, so a prerequisite could only ever name another skill. No skill could declare what it must not be loaded with. And no live path assembled a composition at all: the per-turn catalog carries name and description only, and the `skill` tool returned exactly the one skill asked for, so a skill whose frontmatter declared prerequisites still reached the model alone. The ranker's gate had no production caller beyond the offline behavior-routing gate, which made the whole relation surface inert in a running session.

## Decision

1. **`conflicts_with` (frontmatter) → `conflictsWith`** joins the same pipeline `requires` uses: one `STRING_LIST_FRONTMATTER_FIELDS` row drives parsing, the recognized-key allowlist, and the malformed-value warning, and the field is carried through candidates, summaries, definitions, and the three `validateStringArray` sites. The relation is symmetric: one side declaring it excludes the pair.
2. **`capabilities` becomes load-bearing.** A `requires` entry is satisfied by a candidate carrying that name or by a candidate that provides it as a capability — the union over the candidate set, matching how a capability name is not itself a skill.
3. **`rankSkills` gains `capabilities` and `conflicts`.** Unmet prerequisites still score zero; of two conflicting candidates the better ranked keeps its score and the other scores zero, decided in ranked order (score, then name — the only total order the selector has), and a candidate that is unroutable never excludes a sibling, because excluding on its behalf would delete a usable skill for a candidate that cannot be selected anyway.
4. **The loader composes.** `skill({ name })` resolves the requested skill's declared prerequisites to catalog skills (by name, else by capability, declaration order, deduplicated) and returns them in the result's new `composed` array; each rides its own `<skill_content>` block, the requested skill first. The whole set resolves or the load refuses — `skill "A" requires "B", which is not available in this session`, or `skill "A" cannot load: "B" and "A" declare a conflict` — because half a declared composition is a misconfiguration, not a partial load. The `/name` user gesture injects the same set, one injection per member.
5. **The behavior routing gate forwards both maps** from its caller-supplied catalog (`capabilities`, `conflictsWith`), so the offline selector proves the same rules.
6. **`snapshots/session/skill-compose`** records the composition end to end: the model loads a skill declaring `requires: [base-skill]` and the recorded tool result carries both frames.

## Alternatives considered

- **Exclude both sides of a conflict** — rejected: one stale declaration would make two skills unusable at once, and the selector has no evidence to prefer either. Ranked order is the deterministic tie-break the query itself provides.
- **Let the declaring side win** — rejected: direction carries no operational meaning; it would only perturb the outcome of a scored tie, which name order already settles deterministically.
- **Refuse a conflicting pair anywhere** — rejected as unimplementable at the parse and discovery boundaries (a provider cannot know which siblings a call will select) and unnecessary where the model loads skills in separate calls, which is the documented limitation rather than a silent hole.
- **Have the model load prerequisites itself** — rejected: the catalog instructs the model to load applicable skills, which is a weaker guarantee than the frontmatter declaration; the loader is the one place the harness can deliver the declared set.
- **Put relation metadata in the model catalog** — rejected: the catalog is pinned to `name` + `description` by existing tests, and relations decide selection and loading rather than needing model prose.
- **Compose partially when a prerequisite fails to load** — rejected: the author declared the composition; a partial load would silently hand the model a skill whose stated dependency is missing.

## Consequences

- A skill declaring prerequisites now arrives complete in one call, composed in declaration order.
- A prerequisite may be a capability: `requires: [code-review-rules]` is satisfied by any catalogued skill whose `capabilities` includes it.
- Conflicts are enforced where a set is actually assembled — the selector and the load set — and refuse loudly with both sides named.
- Unenforced boundary: two conflicting skills loaded in separate tool calls are not refused; there is no loaded-set registry to consult, and the limitation is recorded in the skill README.
- `composed` is part of the `skill` tool's result schema (persisted metadata); the call card is unchanged and renders the composed content.

## Deviations from the plan

- None in scope: the change is the relation vocabulary, the selector's policy, the loader's composition, the routing gate's plumbing, the recorded scenario, and the docs.
- §11's last mechanism — synthesizing new skills from primitives — stays unimplemented; it generates artifacts rather than relating existing ones, and the curator/optimizer own candidate generation.

## Testing

- `skill-filesystem`: `conflicts_with` parses without warning and survives `get()`/`list()`; a malformed scalar warns once per parse and drops the field while the skill still loads.
- `skill`: `conflictsWith` is carried on candidates, listed summaries, and loaded definitions, and every `validateStringArray` site rejects a malformed value with `conflictsWith must be an array of strings`.
- `rank`: a prerequisite met only by a provided capability scores above zero and zero when the provider is absent; of a conflicting pair the better ranked keeps its score while the other scores zero with its rough score intact, whichever side declares it; an unroutable rival never excludes a sibling; no declaration leaves scores byte-identical.
- `evolution-scorer`: a capability-satisfied prerequisite routes through `checkBehaviorRouting` and fails when the provider leaves the catalog; a candidate conflicting with a better ranked entry fails every positive.
- `tool-skill`: the declared composition is one result with the prerequisite's frame after the requested frame; a capability provider satisfies a prerequisite; an unavailable prerequisite and a declared conflict each refuse the load naming both sides; the `/name` gesture injects the requested skill then its prerequisite.
- `snapshots/session/skill-compose`: replay of the authored fixture through `dsh --profile headless`, whose recorded tool result carries `<skill_content name="composed-skill">` followed by `<skill_content name="base-skill">` (produced by a real refresh run).
- `packages/skill/skill/tests/rank.spec.ts` (16 cases), `tool-skill` (81), `evolution-scorer` (49), `skill` + `skill-filesystem` (114, three skipped on this host by existing platform guards) pass; `tsc -b` clean for every touched package; translation pairing, export JSDoc, and doc budgets pass; `verify-md-links` reports only the pre-existing missing-spec link.

## Left alone

- Synthesis of new skills from primitives (§11's final mechanism).
- No in-repo caller fills a behavior routing catalog from skill frontmatter, so the routing gate's relation proof stays offline until a corpus-backed caller exists (recorded by the scorer's own README).
- The `/curator` and `/skills` surfaces do not list relations; nothing consumes them for display yet.
