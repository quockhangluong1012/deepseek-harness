# Agent Note: Evolution Skill Telemetry and Skill Management Tool

Status: implemented

English | [中文](2026-09-11-evolution-skill-curation.zh.md)

## Problem

The skill capability could discover and load instructions but could neither remember their use nor change them: curation (staleness, consolidation, deletion) had no durable evidence, and the model had no file-level mutation path for skills. The memory-context nudge already advertises a `skill_manage` tool beside a visible skill catalog, so the tool had a promised surface with no implementation behind it.

## Decision

Ship two packages in the `skill/` group. `@deepseek-ai/dsh-evolution-skill-telemetry` owns the durable per-skill record behind curation in storage domain `evolution_skill_usage` (version `1`, table `records`, keyed by skill name): use/view/patch counters with instants, a creation record, pin, lifecycle state, absorption target, and archive stamp. `@deepseek-ai/dsh-evolution-skill-manage` publishes the model-facing `skill_manage` tool with six file operations: `create` starts a skill under the configured directory, `patch` replaces one uniquely-occurring substring, `edit` rewrites a body behind kept frontmatter, `write_file` and `remove_file` maintain supporting files, and `delete` removes the skill directory. Existing skills mutate in place where the catalog found them; bundled and `hub*` skills reject every mutation through the shared `isExcludedSkillSource` write-time decision. Pins block managed deletion but never patches. Telemetry is wired through `ctx.get`, so the tool works with the store unmounted; foreground creates never call `markAgentCreated`, so their creation record stays user-directed.

## Alternatives considered

- **An `op` enum in the tool schema.** Rejected: the framework validates arguments before the executor runs, which would leave the operation's own enforcement branch unreachable under the per-file coverage gate. `op` ships as a plain string and the executor enforces the six-op set where the mutation runs.
- **Throwing presenters for unknown operations.** Rejected: `defineTool` wraps presenters softly for replay of obsolete logged arguments, and presenters must never throw. Unknown operations return `undefined` and fall back to generic rendering.
- **Required telemetry injection.** Rejected: management must work standalone. The tool resolves the store with `ctx.get` at each mutation site, and the without-telemetry composition test pins every operation.
- **Covering every host I/O fault.** Rejected for creation collisions: non-`EEXIST` creation failures need a platform permission or disk fault, so the rethrow carries a `v8 ignore` following the repository's platform-fault precedent. The removal path covers its fault branch for real through a non-empty directory.
- **Schema-filled `op` defaults or silent source fallbacks.** Rejected during testing for the same dead-branch reason as the earlier rounds: explicit marks, explicit arguments, and loud refusals keep every branch reachable.

## Consequences

Curation now rests on observed use: loads count through the passive `tools/post-execute` observer (which delegates first, so telemetry never changes a load outcome), views and patches count through explicit marks, and pins protect curated skills from managed deletion. Model mutations land as files immediately with one short result line per call; rollback is the caller's version control. The lessons-to-skills nudge written in the memory-context round now resolves against a real tool.

## Testing

Thirty-three specs pin mark counting with bundled/hub exclusion, the creation record, pinning, lifecycle transitions with archive stamping, the observer through the real tool pipeline with stub tools, and every `skill_manage` operation with its rejections: duplicates, unknown/ambiguous/empty substrings, malformed and mismatched frontmatter, outside and reserved paths, missing files, pinned and bundled deletions, unknown ops, and presenter output including replay fallbacks. The observer specs were rewritten from manual event emission to the production `ctx.tools.execute` path. Per-file 100% holds on statements, branches, functions, and lines.
