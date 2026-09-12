# Agent Note: Skill Load-Time Template Variables

Status: implemented

English | [中文](2026-09-11-skill-template-vars.zh.md)

## Problem

Skill bodies could not name their own directory or the loading session: a skill referencing `references/chapter.md` had no portable spelling, so authors hardcoded machine paths that broke everywhere else. The registry already carries each skill's absolute `SKILL.md` path and each load runs inside a known session, but no step substituted either into the body before the model read it.

## Decision

Expand `${DSH_SKILL_DIR}` and `${DSH_SESSION_ID}` in `packages/skill/tool-skill` at both load paths — the `skill` tool result and the `/name` pre-step injection — through a pure `src/template.ts` helper applied before the shared `renderSkillContent` wrapper. The directory derives from the summary or definition `path`; the session id comes from the loading agent's session. Any other `${...}` sequence stays verbatim, as does a variable without a value: virtual skills carry no path, and agent-less tool calls carry no session. `renderSkillContent` is untouched because it belongs to the `dsh-skill` Service Definition seam; expansion is this package's presentation decision. Replay rendering needs no change since stored results already carry expanded text.

## Alternatives considered

- **Expanding inside `renderSkillContent`.** Rejected: that function is the seam's canonical rendering shared by definition, and its `Pick` contract carries neither session nor directory derivation. Changing it would widen the Service Definition for one consumer's need.
- **Rejecting bodies with unresolvable variables.** Rejected: virtual skills legitimately lack paths, and failing their loads would punish the skills that need portability least. Verbatim passthrough keeps every load working while teaching authors the two known names through the resource hint they already read.
- **A general `${ENV}` interpolation.** Rejected as a security surface: unrestricted environment exfiltration into model context needs the `required_env` design (allowlist, sandbox passthrough, gateway redaction), not a silent glob. The two-name set is closed by construction — the replacer matches only those literals.

## Consequences

Portable skills can now reference sibling files relative to `${DSH_SKILL_DIR}` and name the loading session for diagnostics, on both load paths with one canonical behavior. Authors of virtual skills see the literal placeholder and learn the constraint from the README instead of a load failure.

## Testing

Fifteen specs pin verbatim passthrough of unknown placeholders and missing values, per-occurrence replacement, directory derivation with virtual-skill absence, and both load paths end to end (tool result and pre-step injection, filesystem and virtual skills, agent and agent-less calls). Per-file 100% holds for the new module. Two pre-existing scoped-registration specs in the package fail identically with and without this change (verified by stashing the change and re-running), owned elsewhere.
