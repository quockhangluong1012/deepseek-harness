---
description: "Record task-local research evidence and claims in the session log, with source references, trust labels, and evidence-linked status."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-evidence

English | [中文](README.zh.md)

## Summary

Record research observations and claims through the task's durable session log. `record_evidence` stores a source reference and optional digest; `record_claim` cites evidence recorded in the same session. Both tools require an active kernel task, and `maxTextChars` bounds recorded text.

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

Mount the plugin beside `tools`; it registers two model-visible tools and writes through `agentKernel` when a call runs.

### When to choose it

Choose it when a research task needs durable, source-linked observations and claims rather than transcript-only conclusions. Avoid it when the task has no kernel-owned task contract to receive the records.

### Minimal configuration

Mount the plugin in a `cordis.yml` composition:

```yaml
- name: '@deepseek-ai/dsh-tool-evidence'
  config:
    maxTextChars: 2000
```

| Field | Default | Meaning |
|---|---|---|
| `maxTextChars` | `2000` | Maximum UTF-16 characters recorded for a content reference, digest, or claim statement |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-evidence) lists every accepted field. Without an `agentKernel` or a task for the calling agent, each tool call fails rather than dropping the record.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tools validate their model-supplied arguments at the tool boundary, bound recorded text, and call the kernel's task-scoped recording methods. The kernel rejects claims citing evidence absent from the same session and appends `evidence/recorded` or `claim/updated`; evidence stores a reference and optional digest, not the observed content.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin configuration, tool schemas, and calls into the kernel |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent kernel](../agent-kernel/README.md) — task-local evidence and claim records, trust labels, and the durable event ledger.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-evidence) — the exact model-facing schemas and descriptions.

-----

<a id="model-experience"></a>
## Model Experience

### Evidence and claim tools

#### What the model sees

The model sees the generated `record_evidence` and `record_claim` schemas in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-evidence). Evidence records a source kind and `contentRef`, with optional `digest` and `trust`; claims record a statement and confidence, with optional `evidenceIds` and status. The descriptions say when to record each and that a claim without evidence remains a proposal.

#### Token effect

Both schemas are present whenever the tools are visible. A call returns its recorded id and bounded reference or statement; the plugin adds no prompt text.

#### KV Cache effect

The tool schemas remain prefix-stable while their definitions and visibility stay unchanged. Plugin lifecycle or tool restrictions can change that schema set.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **References do not preserve content.** The log records a locator and optional digest; the referenced file, result, or URL must remain available for later review.
- **Trust is metadata, not authority.** A model-supplied trust label or digest does not establish that content is true or grant a capability.
- **Claims are session-local.** A claim can cite only evidence this task's session recorded; cross-session promotion belongs to a separate admission path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
