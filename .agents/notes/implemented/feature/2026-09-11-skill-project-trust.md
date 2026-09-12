# Agent Note: Project Skill Trust Gating and the Hermes Root

Status: implemented

English | [中文](2026-09-11-skill-project-trust.zh.md)

## Problem

Project skills indexed unconditionally: any checkout's `.dsh/skills` and `.agents/skills` entered the model catalog for whoever opened the directory, with no operator consent and no off switch short of disabling all default roots. The specification gates project skills on trust, adds the `.hermes/skills` root beside them, and keeps non-interactive surfaces prompt-free — but no trust state, no scanner, and no trust commands exist yet.

## Decision

Gate project discovery on explicit configuration in `dsh-skill-filesystem`, without touching the registry contract beyond one source literal. `trustedProjectDirs` lists absolute project roots (relative entries fail loudly at load); `projectDiscovery: false` disables project roots entirely. Untrusted roots contribute nothing and warn once per root per provider; trust is configuration, so non-interactive surfaces inherit it and never prompt. The `.hermes/skills` root joins at rank 150 as `project-hermes`, inside the project precedence band and behind explicit trust like its siblings. Comparison runs on resolved absolute paths, case-insensitively on Windows. Watchers follow discovery, so untrusted roots are never watched. Pre-index scanning with quarantine and `trust`/`untrust` commands stay deferred with README entries.

## Alternatives considered

- **Trust-on-first-use prompting.** Rejected: discovery runs headless in non-interactive surfaces that cannot prompt, and a prompt inside the model loop would be answerable by the model under review. Trust arrives through configuration only.
- **Sharing rank 100 with `.dsh/skills`.** Rejected: same-rank ties fall through to provider order and local order, giving `.dsh` a silent, order-dependent win. Rank 150 keeps every project root deterministically ordered with no tiebreak ambiguity.
- **Resolving trust through symlinks.** Rejected for v1: symlinked aliases match only when listed as resolved, documented on the comparison helper. Chasing links at comparison time would trade a predictable rule for filesystem-dependent surprises.
- **Blocking untrusted roots loudly.** Rejected: an untrusted checkout is policy, not misconfiguration. One warning names the root and the fix; repeats stay silent per provider instance.
- **Bundling the scanner into this slice.** Rejected: dangerous-skill rules need dedicated security design. Trusted project skills index uninspected for now, stated plainly in the limitations.

## Consequences

Opening an untrusted checkout no longer feeds its skills to the model: deployments opt project directories in through configuration, and flipping `projectDiscovery` off restores user-and-custom-only catalogs. Existing compositions without `trustedProjectDirs` lose project skills until they opt in — a deliberate behavior change covered by updated specs. The `.hermes/skills` root is available the day authors use it, already behind the same gate.

## Testing

Trust matrix specs pin trusted discovery with the `.hermes` rank slot, untrusted skipping with warn-once semantics (via a direct provider, since the registry caches discovery), full project-discovery disablement, loud rejection of relative trust entries, and case semantics on both platforms via mocked `process.platform`. Per-file 100% holds for every line and branch this slice adds (verified against the coverage map); three symlink specs fail with sandbox `EPERM` on this host and fail identically without the change.
