---
description: "Model-facing skill_manage tool that creates, patches, edits, writes, removes, and deletes agent skills as files (ctx.tools), for hosts curating skills during use."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-skill-manage

English | [中文](README.zh.md)

## Summary

`dsh-evolution-skill-manage` publishes the model-facing `skill_manage` tool: `create` starts one in `createDir`; `derive` synthesizes one from two or more primitives; `patch` replaces one uniquely-occurring substring; `edit` rewrites a body behind kept frontmatter; `write_file`/`remove_file` maintain supporting files; `delete` removes a whole skill. Catalog-found skills mutate in place; bundled and hub skills are read-only; a pin blocks deletion, never a patch. Every `create` and `derive` carries model authorship (`createdBy: 'agent'`), later vouched with `/curator adopt <name>`; `create`, `derive`, `patch`, `edit` record a hashed body revision. Choose it when the model should curate durable skills as files, not a frozen set.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin when the model should create or revise skills. Skill names are lowercase kebab-case. `create` needs a routing `description` and an instruction `content`, and refuses an existing name. `patch` needs an `old_text` substring occurring exactly once plus its `new_text`; unknown, ambiguous, and empty substrings reject loudly. `edit` needs a complete replacement `content` and keeps the stored frontmatter name and description. Every `create` records model authorship through telemetry `markAgentCreated`, later vouched for with `/curator adopt <name>`; `create`, `patch`, and `edit` also record a revision of the exact body written, hashed by the store rather than re-read from disk. `write_file` and `remove_file` take a skill-relative `path`: absolute paths, traversals escaping the skill directory, and empty paths reject, and `SKILL.md` stays reserved for the content operations. `derive` synthesizes a new skill from at least two existing ones: it takes the complete `content` of the new SKILL.md plus a `sources` list, refuses a source set that is short, duplicative, self-naming, unknown, or excluded by a source's `composable_with` allowlist, and replaces whatever lineage the supplied head declared with the sources actually composed. `delete` removes the skill directory unless telemetry reports the skill pinned. Bundled and hub skills reject every mutation; skills without a local directory are unknown for management purposes.

### Configuration

`createDir` is the only deployment choice: where `create` puts new skills. It supports `~` and `${VAR}`/`$VAR`; an omitted value resolves to the profile skills directory. Every other behaviour is fixed protocol, not configuration.

```yaml
- name: '@deepseek-ai/dsh-evolution-skill-manage'
  config:
    createDir: '~/skills'
```

| Field | Default | Meaning |
|---|---|---|
| `createDir` | `$DSH_HOME/skills` | Directory for newly created skills; `~` and `${VAR}`/`$VAR` expand, a missing variable fails loudly |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-skill-manage) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The tool enforces its operation set in the executor, not the schema: `op` is a plain string and unknown values reject with `unknown skill_manage op`, so no caller bypasses the decision through direct execution. Presenters stay replay-safe and fall back to generic rendering for obsolete logged arguments instead of throwing. File mechanics live in `src/files.ts` as pure helpers plus thin `node:fs` operations; frontmatter splits on the `---` fences, and skill files rebuild through YAML serialization so tricky descriptions stay parseable. `edit` and `derive` share one head invariant (`splitSkillFile`): a rewritten body and a synthesized file are validated by the same code, and a derivation replaces the caller's declared lineage with the sources it actually composed.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `skill_manage` tool, operation enforcement, presenters, and telemetry wiring |
| [`src/files.ts`](src/files.ts) | Directory expansion, registry resolution, the shared skill-file head invariant, and unique-substring surgery |

### Failure and recovery

A rejected mutation never touches the filesystem. Catalog skills resolve through `resolveSkillDir`, which refuses bundled and hub sources, file-less entries, and unwritable targets before any read. Mutations report through `ctx.get('evolutionSkillTelemetry')`, so the tool works with telemetry unmounted; the revision the store records is the exact file text the operation wrote, hashed by the store rather than re-read from disk. The `EEXIST` collision on create and derive reports the existing path; other I/O failures propagate.

`derive` resolves its source set before writing anything: a source list shorter than two distinct names, a source naming the new skill, a source the catalog does not carry, and a source set its own `composable_with` allowlists exclude all reject with a named reason, through the same pair rule the loader applies to a load set. The composability check reads the catalog summaries the host already resolved, so it introduces no extra model call and no new store.

No invariant companion is published because each operation resolves, checks, and writes one filesystem location in a single pass, so there are no two independent observations that could diverge.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md) — the behaviour contract this package implements.
- [Skill package map](../README.md) — the group's packages and their repository position.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-skill-manage) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

The `skill_manage` tool with one `op` (`create`, `derive`, `patch`, `edit`, `write_file`, `remove_file`, or `delete`), the kebab-case `name`, and the op's required arguments. Each call resolves to one short text line naming the op, the skill, and the written path.

##### Verbatim text for this field, when needed

```markdown
skill_manage patch polish: /skills/polish/SKILL.md
```

#### Token effect

Linear in the call: one tool call per mutation, with arguments bounded by the edited content. No auxiliary model calls; the tool performs filesystem writes only.

#### KV Cache effect

One short result line per call enters the transcript; the tool changes no prompt prefix, so it cannot invalidate provider cache reuse beyond the result text itself.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the tool is a poor fit. They are current package constraints.

- **Machine-local only** — skills live under managed directories or catalog paths on this machine, never as shared records.
- **Writes land immediately** — a mutation is on disk at once; the SKILL.md body carries a store-hashed revision chain, curator patches keep a preimage blob, and `/curator rollback --id` restores patched bodies.
- **Bundled and hub skills are read-only here** — the tool refuses them; their owners curate them elsewhere.
- **Creates never land in place** — new skills go to `createDir` even when a same-named catalog skill exists elsewhere; only `create` uses the configured directory.
- **Derivation composes text, not behavior** — `derive` writes the body the model supplied and records the sources it named; nothing replays the parents, measures the child, or checks that the synthesized body actually does what its sources do.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
