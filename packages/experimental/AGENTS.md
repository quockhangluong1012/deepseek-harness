# AGENTS.md — Experimental packages

These rules supplement the [package rules](../AGENTS.md); the [experimental Agent Teams package decision](../../.agents/notes/implemented/architecture/2026-08-18-experimental-agent-teams-packages.md) owns the rationale.

- A package belongs here only when its complete public contract is experimental or internal-only; an experimental option in a release package stays with its product role.
- Every package here uses the `@deepseek-ai/dsh-experimental-*` prefix. Packages are private by default, omitting `publishConfig`; the five Agent Teams packages are explicit public exceptions that keep their experimental names, set `publishConfig.access: public`, and join the dsh release family.
- Release packages and apps outside this group must not name experimental packages in `dependencies`, `optionalDependencies`, or `peerDependencies`; experimental packages may depend on release packages and each other. Tests may use them via `devDependencies`; examples load explicitly.
- Experimental status relaxes no engineering, security, documentation, lifecycle, testing, invariant, or snapshot requirement.
- An explicit exception promotes nothing and adds no stability promise. Promotion moves a package to its product-role group and drops `experimental-` from its npm name; update every import and configuration row atomically, then review its public contract, limitations, test evidence, release payload, dependents, and stable owner.
