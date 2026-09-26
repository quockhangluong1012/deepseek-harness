---
description: "Review findings panel: one Chat node per recorded review report, showing the independent reviewer's summary and every finding grouped by severity."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-review

English | [中文](README.zh.md)

## Summary

Show an independent reviewer's report as one Chat node instead of plain command text. The node renders the durable record a `/review` or `/security-review` run wrote: which review ran, what it reviewed, the reviewer's own summary, and every finding with its file, line or range, severity, and message, grouped high, medium, low. Mount it where the profile also mounts the review commands; without them no node ever appears. The commands and the session log stay the owners of every fact it shows.

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

The Web app mounts it as one client row (`ui-review`); nothing else is required. A node appears for each review the profile's review commands recorded — `/review` and `/security-review` by default — and it stays absent, not empty, when a composition omits this row.

The panel shows the review kind and target in its header, the reviewer's own summary, and each finding as severity, location (`file`, or `file:line`), and message. Findings are grouped high, then medium, then low, whatever order the reviewer sent them in; a clean review keeps its summary and says there is nothing to report.

A review the command never recorded — the reviewer did not finish, or finished without a valid report — renders no node. The command reports that failure itself, as command text.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Role |
|---|---|
| [`src/client/review-definition.ts`](src/client/review-definition.ts) | The Conversation Node Definition: the record it claims, the payload parse, and the renderer data it projects |
| [`src/client/ReviewPanel.tsx`](src/client/ReviewPanel.tsx) | The keyed Chat renderer: kind, target, summary, and the severity-grouped findings |
| [`src/client/locales.ts`](src/client/locales.ts) | The `review` dictionary pair |
| [`src/index.ts`](src/index.ts) | Host half; the feature is entirely browser-side |

The Definition claims each `review/report` record as its start, keyed by the command identity that produced it, so one invocation renders one node; a review is written once and complete, so nothing joins it as an update. The record comes from the Session log, which this client did not write, so it is parsed once against the payload's schema: a malformed record renders no node rather than a broken panel.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Review commands](../../subagent/command-review/README.md) — the two commands that record the report this panel renders.
- [Client group map](../README.md) — every browser package.

-----

<a id="model-experience"></a>
## Model Experience

None, as the panel renders a log-only review record without changing model context.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the panel can show; they are current package constraints.

- **Read-only.** The panel shows what the reviewer reported. Dismissing a finding, accepting one, or re-running a review stays with the commands and the composer.
- **No inline diff annotation.** A finding names a file and an optional line or range; the panel does not fetch the diff or place the finding beside its hunk, because the record carries only what the reviewer wrote.
- **One node per review.** A session that ran several reviews renders one node each, anchored at its own record; the panel has no cross-review list, filter, or export.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
