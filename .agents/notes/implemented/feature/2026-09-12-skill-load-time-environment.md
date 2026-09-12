# Agent Note: Skill load-time environment and skill-creation evidence

Status: implemented

English | [中文](2026-09-12-skill-load-time-environment.zh.md)

## Problem

A skill could declare what it needs and nothing read it. `required_env` and `config` were parsed onto `ParsedSkill` (see [the frontmatter allowlist](2026-09-12-skill-frontmatter-allowlist.md)) and projected onto the loaded definition, but the loader rendered the body as written: a skill whose declared environment variable was unset still loaded, and a deployment had no way to give a skill a value its body needed. `${...}` sequences other than the two reserved variables stayed verbatim, so a skill that wanted a host fact at load time could not get one.

Two further Phase 3 surfaces had no owner: the counted trigger for proposing a skill (repeat evidence instead of a vendor-quoted repetition number), and the cost row a consolidation-scale run must record before it fans out.

## Decision

Both loader paths — the `skill` tool and the user-explicit `/name` injection — run one resolution and rendering step in `packages/skill/tool-skill/src/load.ts` before `renderSkillContent` frames the body.

**`required_env` passthrough.** Every declared name must be set and non-empty in the host environment; the values become the `env` of the skill's execution commands (the inline shell below). An unset name fails the load with `skill "<name>" requires environment variable "<NAME>", which the host environment does not set`. The tool throws that error; the injection path warns `skill "<name>" skipped: …` and omits the injection for that step.

**`skills.config` injection.** Declared keys are the union of the deployment's `skills.config.<skill>` map and the skill's own frontmatter `config` map. A deployed value wins over the skill's own default, a blank value counts as absent, and a declared key with no value in either source fails the load, naming every missing key. Resolved values substitute `${<key>}` in the body before any shell expansion, so a declared key always wins over a command of the same name, and they also join the execution environment.

**Inline shell, opt-in.** Only a skill with `metadata.shell: true` lets an undeclared `${...}` sequence run as a command, through the mounted `ctx.shell` executor (absent executor renders empty and warns). Each distinct command runs once, from the skill's own directory, with the resolved environment, under `metadata.shellTimeoutMs` (default `10000`, positive) and `stdoutMaxBytes` derived from the 4000-character cap. A failing, timed-out, aborted, or rejected command contributes nothing and warns on the host log. A malformed `metadata.shell` (non-boolean) or `metadata.shellTimeoutMs` (non-positive-integer) fails the load rather than silently disabling the feature.

**Counted skill-creation trigger.** `skillCreationEvidence(paths)` in `packages/skill/evolution-skill-telemetry` groups produced outputs by normalized path — case-folded, `/` and `\` alike, trailing separators ignored — and reports every path produced at least `SKILL_CREATION_OUTPUT_THRESHOLD` (3) times, plus whether any reached it. It counts paths only; file content is never read or quoted, and no vendor-reported repetition number feeds it. The count is the trigger: two similar outputs do not fire, three do.

**Consolidation cost row.** `ctx.evolutionSkillTelemetry.recordConsolidationCost(row)` stores the frozen `{ inputBytes, maxOutputTokens, provider, model, truncated }` row before a consolidation-scale fan-out begins, and `readConsolidationCost()` returns a detached copy of the latest row.

The registry carries the declared values without owning them: `SkillDefinition` gains `requiredEnv`, `config`, and `blueprint`, `validateDefinition` checks the first two at the provider boundary, and summaries stay invocation-neutral so none of them reaches a catalog. The `skill-filesystem` provider projects the parsed values onto its loaded definition (see [the gating and project-scan note](2026-09-12-skill-gating-and-project-scan.md)); that projection is the only cross-package dependency this feature added.

### Install blueprint

`SkillDefinition.blueprint` (`{ schedule, deliver, prompt }`) exposes the install-time suggestion the provider already parsed, so an installer surface can read it from the definition it loads. It stays off `SkillSummary` and `SkillCandidate` deliberately: the catalog is the model-facing routing list, a blueprint is not routing material, and putting it on a summary would spend catalog-shaped surface on every discovery for a field only an installer consumes. The command that suggests automations loads the definition by name instead; the per-skill load cost is the price of keeping the catalog clean.

An unusable blueprint is dropped, not fatal. `get()` passes every loaded definition through `usableSkill`, which returns the definition unchanged when the blueprint is absent or well-shaped and otherwise copies it without the field. A provider that emits frontmatter-derived values in the wrong shape loses one optional suggestion instead of failing a load every consumer shares — the parse in `skill-filesystem` already drops malformed `blueprint` frontmatter with one warning, so this is defence at the provider boundary, not a second parse.

## Alternatives considered

**Environment injection only, without body substitution.** Rejected: the deployment's value would be invisible to the model, and a skill body that names its own configuration (`${region}`) could not use it.

**A rendered config block appended to the body.** Rejected: it spends tokens on every load and adds a model-visible frame even for skills that never read the value, where substitution costs nothing and is opt-in by construction.

**A general `${ENV}` interpolation.** Rejected: unrestricted environment exfiltration into model context is the security surface `required_env` exists to avoid; names must be declared, and declared names are checked at load.

**Putting `skills.config` on the `dsh-skill` registry instead of the loader.** Rejected: the registry owns discovery and merging, not load-time rendering, and splitting one resolution step across two packages would make the deployment config reachable only through the registry's constructor.

**Counting similar outputs by content hash or basename.** Rejected: content is exactly what this surface must not quote, and basename grouping would fire the trigger on unrelated files that share a name.

**A durable domain for the cost row.** Rejected: the curator records the row in its own ledger, so a second durable copy would duplicate authority for one run's planned spend; the in-process row is a read surface, not a record.

**Putting the install blueprint on the catalog summary.** Rejected: the catalog is the model-facing routing list, and a blueprint affects nothing the model routes on — every discovery would pay for a field only an installer surface reads, and it would widen the model-visible summary shape for no request-time benefit. The definition load is the seam.

## Consequences

Misconfiguration is loud: a skill whose declarations cannot be satisfied fails at load instead of running on a partially resolved environment, and its declared values reach the execution environment only when the host actually set them. Inline shell makes a skill body executable at load time in the mounted executor's environment — bounded, but trusted by authorship, so only trusted discovery roots belong in a deployment.

The catalog is unchanged: a skill whose declarations cannot resolve stays listed and fails only when loaded, and neither `requiredEnv`, `config`, nor `blueprint` reaches a summary — an installer surface pays one definition load per skill it considers. The cost row is process-local and holds the latest run, which is all the curator consumes; a deployment that never consolidates never records one. The counted trigger ships with no caller wired to it yet — the curator and the command surfaces consume `skillCreationEvidence`, and wiring a proposal path to it is their change.

## Verification

`packages/skill/tool-skill/tests/load.spec.ts` covers resolution and rendering directly: passthrough of declared names, the unset and blank cases, deployed-over-default resolution with the blank-deployment fallback, missing keys, the shell opt-in and timeout defaults, malformed `metadata`, config-over-command precedence, once-per-distinct-command execution with the skill environment and working directory, the character cap including a trailing surrogate pair, and each failure mode rendering empty and warning. `tests/tool-skill.spec.ts` adds the end-to-end paths over a mounted fake executor: deployment `skills.config` reaching a loaded body, the tool error and the warn-and-skip injection for an unset declared variable, and a failed command warning through the tool. `packages/skill/evolution-skill-telemetry/tests/telemetry.spec.ts` covers the evidence threshold, normalization, ordering, and the cost-row store and read. `packages/skill/skill/tests/skill.spec.ts` pins the loaded-definition passthrough for `requiredEnv`, `config`, and a well-shaped `blueprint`, the invocation-neutral summary (no `blueprint` key), the rejected `requiredEnv`/`config` shapes, the dropped malformed blueprint shapes, and the quarantined count reported on `skills/change`. `packages/skill/tool-skill/tests/tool-skill.spec.ts` also loads a blueprint skill through the filesystem provider and asserts the definition carries it while every summary stays without it.

Per-file 100% coverage holds for the three packages' `src` trees on the local Windows run: tool-skill 230 statements / 168 branches / 37 functions, skill 313 / 199 / 65, evolution-skill-telemetry 92 / 53 / 33. (`skill-filesystem` keeps its documented Windows-local gap in the POSIX symlink branches; the blueprint projection line itself is covered.)
