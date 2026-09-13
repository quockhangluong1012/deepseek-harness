# Agent Note: Evolution Memory Context — Brief Injector and Scope Nudges

Status: implemented

English | [中文](2026-09-11-evolution-memory-context.zh.md)

## Problem

Stored evolution memory never reached the model: scopes had records, lessons, and staged writes, but no brief entered the request and no prompt guidance told the model when that memory applied. Copying the workspace injector verbatim was blocked twice over: its digest scan reads the session surface through `eventAt()`, which new production code may not call, and the evolution brief carries two extra tiers, a usage header, and a capacity variable the workspace frame has no room for.

## Decision

Ship `@deepseek-ai/dsh-evolution-memory-context` in the `context/` group beside its workspace counterpart, following the [reviewer decision](2026-09-11-evolution-reviewer.md). The injector appends one durable `user/message` from `agent/pre-step` with an `evolution-memory` source carrying the scope id and digest, replacing the brief when the digest changes and adding nothing when it does not. Digest comparison runs a three-stage check — an in-memory per-session mark, the claimed batch, then the logged surface through the asynchronous session query seam — so steady-state turns cost no I/O and restarts re-resolve instead of duplicating. The frame follows the specification verbatim (`# Workspace memory`, directory, `Memory usage: used/cap (pct%)`, Instructions, Lessons, User profile, per-item Context), dropping trailing context first, then truncating lessons, then the profile with lessons gone, then instructions last, with one notice line naming every cut. The package also registers three nudge sections: the lessons-to-skills guidance renders only beside a visible `skill_manage` tool, the scope-narrowing guidance names the scope, and the session-search hint always renders. No composition row is added, so every profile behaves byte-identically until the rows land in `web-app`. **Superseded fact:** the scope-narrowing guidance originally interpolated a `{{evolution_memory_usage}}` capacity variable directly into this system-prompt section; [a later review](../bug-fix/2026-09-13-evolution-memory-prefix-cache-and-alert.md) found this invalidated the provider's cached prefix on every memory write and removed it — usage is now reported only in the brief's own header, described above.

## Alternatives considered

- **Mirroring the surface scan for digest comparison.** Rejected: new calls to `eventAt()` are prohibited. The mark-then-claimed-then-query cascade answers the same question with no synchronous history reads and zero I/O in the common case.
- **Reusing the workspace brief frame.** Rejected: the specification fixes the evolution frame, including the usage header and the Lessons and User profile tiers; sharing the renderer would tangle two budgets and two digest shapes in one function.
- **camelCase `{{evolutionMemoryUsage}}` from the specification.** Rejected after the prompt assembler refused it: the framework variable grammar accepts only lowercase names, so the variable ships as `{{evolution_memory_usage}}` and the package README records the deviation.
- **An optional `profile` defaulting to `default`.** Rejected during testing: the composition schema fills defaults before apply, which would leave a dead fallback branch under the per-file coverage gate. The namespace is required, so every scope key names its owner explicitly.
- **Registering the skills nudge only when the skill package lands.** Rejected: a provider returning empty text contributes nothing to the assembly, so the dormant section costs zero tokens today and activates with no injector change the day `skill_manage` exists.

## Consequences

Scopes with the injector mounted show their shared knowledge to every turn at a bounded per-change cost, with file context re-read at injection time and degraded files named inline. Prompt assemblies gain three short sections and one interpolated value; sessions outside any scope resolve the variable to `unknown` instead of failing the assembly. Staged writes and outputs never invalidate the brief because the digest excludes them.

## Testing

Thirteen render specs pin the frame, empty-section omission, close-tag escaping, drop and truncation order with the single notice line, exact byte caps including absurd budgets, multibyte safety, and the unavailable-file line. Waterfall specs pin the inject/skip/replace cycle, claimed and logged digest paths including a failing surface read, rejection and abort handling, membership caching with removal, directory fallback, file materialization through both readers, lookalike handling, tier-by-tier records, disposal, and load-time profile validation. A REAL-composition spec drives the production loop with a scripted adapter and asserts the adapter received the framed brief, the log holds exactly one evolution message, the second turn adds nothing, the system prompt carries the resolved usage variable, a record change appends exactly one replacement brief, and a session outside every scope receives none. Sections specs pin names, copy, the skill-visibility rule, usage formatting, and assembly with and without a registry. Per-file 100% holds on statements, branches, functions, and lines.
