# Agent Note: Skill gating and project-skill security scan

Status: implemented

English | [中文](2026-09-12-skill-gating-and-project-scan.zh.md)

## Problem

Phase 3 of `specs/improvement.spec.md` names four missing halves of the local skill provider, and they share one seam — what discovery does with a parsed skill before it becomes a candidate:

- The allowlist in [the frontmatter allowlist note](2026-09-12-skill-frontmatter-allowlist.md) ended at `required_env` and `config`, so `platforms`, `requires_tools`, `requires_toolsets`, `fallback_for_tools`, `fallback_for_toolsets`, and `blueprint` warned as unknown keys and could not be declared at all.
- Nothing consumed a platform or tool requirement, so a skill written for another operating system, or for a tool the composition never mounted, still reached the model catalog.
- Project skills were indexed uninspected. Trust already gates *which* project root indexes ([the project trust note](2026-09-11-skill-project-trust.md)), but inside a trusted repository a skill shipping an install-through-shell command was treated exactly like an authored one.
- The registry had no way to learn that discovery had dropped a skill for a security reason, so a quarantine could only ever be a private warning inside the provider.

## Decision

### Frontmatter fields

`parseSkillText` parses the frozen Phase 3 set beside the existing keys: `platforms`, `requires_tools`, `requires_toolsets`, `fallback_for_tools`, and `fallback_for_toolsets` are non-empty arrays of non-empty strings; `blueprint` is a mapping with a non-empty string `schedule`, a `deliver` of `session` or `file`, and a non-empty string `prompt`. All six are allowlisted, so they are recognized keys rather than unknown ones; a malformed value still drops that key with one warning and the skill keeps loading, matching the existing recognized-key contract. Non-empty string-array keys are parsed through one `STRING_LIST_FRONTMATTER_FIELDS` table that both the parser and the allowlist read, so a new list-valued key cannot be recognized in one place and rejected in the other.

`blueprint` has no consumer yet: the frozen shape is parsed for the planned `/suggestions` install path, and nothing schedules itself. `requiredEnv` and `config` ride the loaded definition (`FileSystemSkillProvider.get`), which is the seam `tool-skill` consumes.

### Gating

Gating runs in `discoverRoot` between a successful parse and the candidate push, over `ctx.get('tools')` when a composition mounts a tool registry:

- `platforms` must name the running platform, compared case-insensitively against `process.platform` and its agentskills.io alias (`darwin`/`macos`, `win32`/`windows`).
- Every `requires_tools` name must resolve in the registry, and every `requires_toolsets` name must have a mounted tool whose name carries that toolset's prefix (`web` ← `web_search`). DSH has no toolset registry, so the prefix convention is the whole definition.
- A `fallback_for_tools` or `fallback_for_toolsets` entry hides the skill while the tool or toolset it substitutes for is **mounted**. The pair is how a skill set swaps: the primary `requires_*` skill appears when the tool arrives and the fallback disappears, and the two trade places when it goes away.

A gated-out skill is skipped silently — no host warning, because nothing is wrong — and never reaches any catalog, so it is not loadable by name either.

### Project-skill scan

`discoverRoot` scans the raw text of every skill under a **project-owned** root (the roots carrying a `projectRoot`) before pushing the candidate. Harness-owned roots — `custom`, user, and bundled — index unscanned: they are written by the harness or explicitly configured, while a project root arrives with a repository.

Four lexical rules quarantine a file: `pipe-to-shell` (`curl`/`wget` piped into a shell), `encoded-shell` (`base64` decode piped into a shell), `root-delete` (`rm` with recursive and force flags aimed at `/`, `~`, or `$HOME`), and `credential-exfiltration` (a credential store read alongside a network request). Each rule needs all of its patterns to match, so a skill that merely mentions `curl` is not quarantined.

Quarantine skips the skill, logs the matched rules on the host, counts it for the current discovery, and returns it through `SkillProviderObservation.quarantinedCount`; the registry sums provider counts and reports the total on the `skills/change` payload. The count is a host-side fact and never reaches the model catalog. `FileSystemSkillProvider.get` applies the same scan, so an explicitly addressed project skill cannot load its body either — the caller sees the ordinary "unknown or no longer available" outcome.

A verdict is cached in the provider instance under the resolved file path and the host modification time: an unchanged file is not rescanned, and a rewritten file is. A path the host cannot stat — a backend path from a remote workspace — is scanned without a cache entry.

## Consequences

A skill declares where it applies, and the catalog reflects the running composition instead of every file on disk. The swap between a primary and a `fallback_for_*` skill is the observable proof that a requirement is read rather than stored: mounting the tool moves the fallback out of the catalog and the primary into it.

Quarantine is a security posture with a deliberately small blast radius. It removes the skill from every catalog and from named loads, but it is lexical and reads only `SKILL.md`: a bundle's `references`, `scripts`, and other resources are not scanned, and an obfuscated payload passes. It is a conservative first filter, not a sandbox.

The verdict cache is process-local, so a fresh process rescans every project skill; the specification permits a list-time-only cache, and a durable one would need its own invalidation and file-format contract. Gating reads the registry at discovery time, which means a composition that mounts no `ctx.tools` hides every `requires_*` skill and offers every `fallback_for_*` skill — the loudest possible degradation for a composition that forgot the registry.

## Verification

`tests/skill-filesystem.spec.ts` covers the shipped behavior: the gating keys parse without warning (including a valid `blueprint`), seven malformed `blueprint` shapes warn once each while the skill loads, `platforms` hides a skill on a foreign platform (with `process.platform` pinned in both directions so the alias branch runs on any host), `requires_tools`/`requires_toolsets` hide a skill with the registry mounted, partially mounted, and absent, the primary and `fallback_for_tools` skills swap as `web_search` appears and disappears, a quarantined project skill is absent from the catalog with a warning naming the rule and `quarantinedCount: 1` on `skills/change`, the load path refuses the same skill, the mtime-keyed cache reuses a verdict for a rewritten body with a restored timestamp and rescans once the timestamp moves, a host-invisible path still scans, harness-owned roots stay unscanned, the four rules flag their patterns and not a bare `curl`, local roots outrank `bundled` on a colliding name, and a trusted project root indexes while an untrusted one does not. The existing `required_env`/`config` spec also asserts the loaded definition carries both values.

## Alternatives considered

**Rank demotion for `fallback_for_*` instead of hiding.** The task phrasing was "ranked below the tool they fall back for", and a rank is the provider's duplicate-name tiebreak in this registry, not a catalog order — the registry sorts summaries by name, so a demotion would be invisible to every consumer. The cited research record is explicit that the fallback skill is hidden while its toolset is present, and the visibility swap is the observable behavior, so gating drops the candidate.

**Gating in the registry or in `tool-skill`.** Rejected: `SkillSummary`/`SkillCandidate` are deliberately invocation-neutral, widening them for provider-specific gate fields would push the fields into every consumer, and a consumer cannot distinguish "not mounted" from "provider had no opinion". The provider owns its discovered facts.

**Blocking a quarantined skill from the catalog only, not from `get`.** Rejected: the catalog exclusion already makes the name unreachable through normal flows, and leaving the load path open would make quarantine advisory — a name known from a previous session could still load the payload.

**A durable scan cache under `<dshHome>/cache`.** Rejected: it needs its own file format, invalidation, corruption handling, and a failure mode where a bad cache entry costs discovery; the specification accepts a list-time cache, and the mtime key gives the same reuse within a process.

**Rejecting a malformed gating value instead of dropping it.** Rejected: it would turn a frontmatter typo into a missing or mis-gated skill, and the provider already warns-and-continues for every other malformed recognized key.

**Richer scan rules (obfuscation, unicode smuggling, PII).** Rejected: every added heuristic raises the false-positive rate on ordinary engineering skills, and a quarantined skill is invisible to the model with only a host log to explain it. The four shipped rules are the ones a reviewer can defend line by line.
