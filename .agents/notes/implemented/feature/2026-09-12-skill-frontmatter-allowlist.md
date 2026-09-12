# Agent Note: Skill frontmatter allowlist

Status: implemented

English | [中文](2026-09-12-skill-frontmatter-allowlist.zh.md)

## Problem

`skill-filesystem` parsed `name`, `description`, `whenToUse`, `metadata`, and the invocation booleans, and ignored every other top-level frontmatter key silently. A skill author who misspelled `when_to_use`, or who wrote `required_env` on a provider that never read it, saw a skill that loaded and behaved as if the key were absent — with nothing in the log to explain why.

`specs/improvement.spec.md` Phase 3 names the fix: an allowlist on `ParsedSkill` and the parse path that recognizes `required_env` and `config` beside the existing keys, and warns on anything else.

## Decision

`parseSkillText` recognizes two further keys. `required_env` is a non-empty array of non-empty strings and lands on `ParsedSkill.requiredEnv`; `config` is a mapping whose scalar values are stored as their string forms and lands on `ParsedSkill.config`. Every other top-level key produces one warning naming the file and the key.

Malformed values for a recognized key warn once and drop that key, and the skill still loads. The alternative — rejecting the skill — would turn a typo in an optional field into a missing capability, and the provider's existing contract already treats unparsable frontmatter as "warn and skip the file"; a recognized-but-malformed key is weaker evidence than that.

The recognized set is derived, not duplicated: `RECOGNIZED_FRONTMATTER_KEYS` spreads `invocationFrontmatterKeys()`, built from the same `INVOCATION_FRONTMATTER_KEYS` table `parseInvocationPolicy` iterates to reject legacy spellings, and spreads the list-valued keys from `STRING_LIST_FRONTMATTER_FIELDS`, the table the parser itself reads. Adding an invocation key or a further list-valued key cannot leave the allowlist behind, and the warning path cannot fire for a key the parser consumes.

[The gating and project-scan note](2026-09-12-skill-gating-and-project-scan.md) extends that table with `platforms`, `requires_tools`, `requires_toolsets`, `fallback_for_tools`, and `fallback_for_toolsets`, and adds `blueprint`.

## Consequences

A misspelled or unsupported key is now visible in the host log instead of silently inert. Skills that declare `required_env` or `config` load exactly as before: no catalog entry, summary, schema, or loaded-content change accompanies the parse, so nothing in the model conversation moves.

`required_env` and `config` ride the loaded definition (`FileSystemSkillProvider.get`) and have no value source of their own: the specification's remaining half — a `skills.config` map injected on load, and the environment passthrough for `required_env` — needs a deployment-side source it leaves undefined, so it is deliberately unimplemented rather than guessed at. Until it lands, parsing and projection are the observable contract.

## Verification

`tests/skill-filesystem.spec.ts` follows the file's logger-capture pattern: a valid `required_env` + `config` skill loads with no warning and its loaded definition carries both values; malformed shapes (empty array, non-string entry, empty-string entry, scalar instead of array; string, null, list, nested mapping instead of a scalar mapping) each warn exactly once naming the file and the key while the skill still reaches the catalog; an unknown top-level key warns once per key; and the recognized invocation keys do not warn. Per-file 100% holds on the Linux coverage lane, where the three symlink specs run; those specs skip on a host that forbids symlinks (`EPERM`), which is the only place this package's coverage falls short locally.

## Alternatives considered

**Rejecting a skill whose recognized key is malformed.** Rejected: it converts an optional-field typo into a missing skill, and no other parse failure in this provider escalates that far.

**Surfacing the values in the catalog or the loaded content.** Rejected for now: it would change a model-visible payload (and its snapshots) for a field nothing consumes, and the injection contract is undefined.

**A second literal list of recognized keys.** Rejected: the invocation keys already have one table, and two lists drift the moment a third invocation key appears.
