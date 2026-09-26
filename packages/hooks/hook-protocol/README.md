---
description: "The shared hook rules behind the Claude Code and Codex bridges — what a hook can do and what happens when it runs — for users and maintainers of the hooks subsystem."
kind: "package-library"
---

# @deepseek-ai/dsh-hook-protocol

English | [中文](README.zh.md)

## Summary

`dsh-hook-protocol` makes both bridges handle your hooks identically: it defines what a hook can do and what happens when it runs. You never install or configure it yourself — choose `dsh-hooks-claude-code` or `dsh-hooks-codex`, point it at your existing `hooks.json`, and these rules apply to your hooks. Through either bridge, a hook can block a prompt or tool call with a message the model sees, attach extra context to the conversation, or halt the run. Command and HTTP hooks run; `mcp_tool`, `prompt`, and `agent` handlers are skipped with a warning.

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

You don't install or configure this package directly — mounting `dsh-hooks-claude-code` or `dsh-hooks-codex` applies these rules to your existing `hooks.json` hooks. Use this page to learn what a hook can do and what happens when it runs; the two bridge pages list which events each dialect supports.

### When to choose it

Choose `dsh-hooks-claude-code` or `dsh-hooks-codex` when you have existing Claude Code or Codex hooks and want them to keep working during agent runs. You never choose this package directly. Avoid the whole group for bespoke behavior with no reference-tool equivalent: a native Cordis plugin has the full harness API with no hook protocol in between.

### What a hook can do

- **Block an action with a message** — a hook that exits with code 2 stops the prompt or tool call, and its error output is shown as the reason.
- **Ask before a tool runs** — a Claude Code hook can request confirmation instead of blocking outright; the Codex bridge does not surface this option.
- **Attach context** — a hook can return extra text that the model sees in the next request.
- **Run on chosen moments** — a hook config selects which events it fires on by name or pattern; an absent, empty, or `'*'` pattern means every event of that kind.
- **Fail without stopping the run** — any exit code other than 2 is a non-blocking failure: the action proceeds and the failure is logged, and a hook that cannot be started at all is treated the same way.
- **Ask the run to stop** — a hook can request that the run halt (`{"continue": false}`): the bridge cancels the run, which then closes its turn as an abort carrying the hook's `stopReason`; the request is also recorded in the `hook/result` event. A point that runs before a run is live, or after one is gone, records the request and warns instead.
- **Reach an HTTP endpoint** — a Claude Code `{ "type": "http", "url": … }` hook POSTs the same JSON payload to its URL and its response body is decoded exactly like a command hook's clean-exit stdout.

### What you see when hooks run

- When a hook blocks, the action does not happen and the hook's message is shown.
- When a hook attaches context, the model sees that text in its next request.
- When a hook halts the run, the turn ends as an abort whose reason is the hook's `stopReason` (or the hook point when it gave none).
- A hook that fails — a bad command, a crash, or any exit other than 2 — is logged and does not stop the agent.
- A failed HTTP hook transport is the one exception: it fails closed, denying the action with the failure as the reason and recording the decision as `transport-error`.
- If a config layer cannot be read or parsed, the bridge logs a warning and skips that layer; the other layers and the agent still start.
- Configs that mix hook types still work: `mcp_tool`, `prompt`, and `agent` handlers are skipped with a warning, and their command and HTTP hooks run.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the library and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Processing pipeline

The library is a chain of single-purpose steps, one function each: validate the matcher pattern, run the handler through its transport (the `dsh-shell` executor for a command, a timed POST for an HTTP endpoint), decode the outcome, read a parsed layer of hook config for the next precedence level, merge every matched hook's outcome into one most-restrictive result, apply a folded halt to the live run, and record the durable `hook/*` event pair. The matcher's `mode` parameter is the single axis the dialects differ on — `claude-code` interprets a pattern as literal alternatives or a regex, `codex` always as an unanchored regex. Every step degrades to a contained outcome instead of throwing, so a hook can never crash the calling turn: an invalid regex is a non-match, an executor rejection becomes a `HookOutput` with no exit code, exit 2 blocks with stderr as the reason, and every other failure stays non-blocking. Merging applies `deny > ask > allow` precedence, keeps the first `continue: false` stop sticky, and accumulates context in hook order. Detached runs are tracked so `fiber.dispose()` reaches quiescence, and the invariant companion rejects `hook/*` records outside an open turn. The steps live in [`src/matcher.ts`](src/matcher.ts), [`src/runner.ts`](src/runner.ts), [`src/codec.ts`](src/codec.ts), [`src/merge.ts`](src/merge.ts), [`src/events.ts`](src/events.ts), [`src/layers.ts`](src/layers.ts), [`src/halt.ts`](src/halt.ts), [`src/detached.ts`](src/detached.ts), and [`src/invariant.ts`](src/invariant.ts).

### Layered config discovery

`readHookConfigLayers` reads the layer paths a bridge names, lowest precedence first, and JSON-parses each one. An absent layer is skipped silently — an unconfigured layer is normal — while a present layer that cannot be read or parsed is skipped with a diagnostic, so one broken file cannot hide the layers around it. A path named by two layers is read once, at its highest-precedence position, so a `configPath` repeating a discovered layer cannot run its hooks twice. `mergeMatcherGroups` then concatenates the parsed layers' per-event groups in that order: the first layer's hooks run first, a later layer appends, and no layer removes another's hooks.

### The run-level halt

`mergeHookOutputs` folds `continue: false` into a sticky `stop` plus the first hook's `stopReason`. `applyRunHalt` turns that folded request into the one durable halt both bridges apply: it cancels the live run with the agent-cancel cause `{ kind: 'hook', reason }`, so the loop's own abort path writes the turn-end reason `{ kind: 'aborted', reason: { kind: 'hook', reason } }` beside the `hook/result` that asked for it, and the halt is reconstructable from the log. A point with no live run — a detached lifecycle point, or session start before the run is live — cannot halt, so `applyRunHalt` reports the request through the bridge's warning sink and only the `hook/result` record remains.

### `hook/*` session events

The `hook/invoked` and `hook/result` events are declaration-merged into `SessionEventMap` as log-only records: like `compaction/*`, they are not surface events and carry no `surfaceOp`. A `hook/result` pairs with its `hook/invoked` by `handlerId`, and `appendHookResult` owns the decision rule. Payloads and per-event JSDoc live in the generated [persistence log event catalog](../../../docs/persistence-catalog.md).

Invocation and result records must sit inside an open turn: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` satisfy that relation by construction, while `SessionStart` runs before turn 1 and gets no `hook/*` record — its injected context is delivered instead. The invariant companion registers on `ctx.invariants` and rejects `hook/*` events appended outside an open turn, a result without a matching invoked, an unknown dialect, or a non-finite duration.

### Typed hook contributions

Every matched hook's output is classified as exactly one contribution kind: `observe`, `annotate`, `inject-untrusted-context`, `request-policy-change`, or `veto` (`classifyHookOutput`, and `MergedHookOutcome.contributions` in hook order). The kinds are ranked but none carries a capability: a hook may veto an action, ask the policy owner to decide, or inject context as untrusted data, and only a kernel or policy owner turns such a request into a grant. A hook's `allow` is therefore advisory — both bridges consume just `deny` and `ask`, and nothing outside a policy owner may read a hook's consent as authorization. Every bridge that turns `inject-untrusted-context` output into a model message prefixes it with the shared `UNTRUSTED_HOOK_CONTEXT_NOTICE`, so the content reads as untrusted external data rather than an instruction, wherever it lands.

### Design philosophy

- **One axis of difference collapsed into `mode`.** The dialects differ only in how a matcher pattern is interpreted, so the matcher takes the mode as a parameter instead of duplicating the engine.
- **The executor owns process control.** Commands run through the `dsh-shell` executor rather than a bespoke spawn: the executor already provides the scrubbed-but-overridable environment, process-group cancellation, and timeout the protocol needs.
- **Two transports, one decode rule.** An HTTP hook's response body is decoded by the same routine as a command hook's clean-exit stdout, so both shapes produce one `HookOutput` and only the transport differs. A transport fault is the single fail-closed path, because an endpoint that cannot answer must not silently allow the action.
- **One halt primitive.** Both bridges fold `continue: false` through the same `applyRunHalt`, so the durable evidence (the abort reason beside the `hook/result`) is identical whichever bridge fired the hook.
- **Never throw into the loop.** Every failure mode — malformed JSON, an invalid regex, an executor rejection — degrades to a contained outcome or a non-match, so a hook can never crash the calling turn.
- **Log-only, turn-enclosed events.** The `hook/*` records are durable evidence of what ran and what it decided; they are not surface events, and the invariant companion rejects them outside an open turn.

The [hook-protocol-lib Agent Note](../../../.agents/notes/archived/feature/2026-06-30-hook-protocol-lib.md) records the shared-versus-per-dialect split and the alternatives considered.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Public exports of every primitive and event helper |
| [`src/matcher.ts`](src/matcher.ts) | Match-all sentinels, literal-vs-regex mode, validation and runtime matching |
| [`src/runner.ts`](src/runner.ts) | `runHook` execution through `ctx.shell` and `DEFAULT_HOOK_TIMEOUT_MS` |
| [`src/codec.ts`](src/codec.ts) | Exit-code and structured-stdout decoding into `HookOutput` |
| [`src/merge.ts`](src/merge.ts) | Most-restrictive merge and the `MergedHookOutcome` type |
| [`src/contribution.ts`](src/contribution.ts) | `classifyHookOutput` and the five `HookContributionKind`s |
| [`src/events.ts`](src/events.ts) | `hook/*` event declaration, append helpers, stderr summary |
| [`src/detached.ts`](src/detached.ts) | Detached-run quiescence tracking |
| [`src/types.ts`](src/types.ts) | `HookOutput`, `MatcherGroup`, `CommandHook`, and the `hook/*` payload types |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: pairing, turn enclosure, dialect, and duration checks |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared rules to the bridges that apply them and the extension points they program against.

- [Hooks group map](../README.md) — the sibling group page and its package table.
- [Hook protocol library Agent Note](../../../.agents/notes/archived/feature/2026-06-30-hook-protocol-lib.md) — why the protocol core is shared and what each bridge owns.
- [Hook bridges Agent Note](../../../.agents/notes/archived/feature/2026-06-30-hook-bridges.md) — how the two bridges use these primitives.
- [Interception extension-points Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md) — the typed-Decision surface the bridges map onto.
- [Generated persistence log event catalog](../../../docs/persistence-catalog.md) — the `hook/*` event payloads and per-event JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-hooks-claude-code` and `dsh-hooks-codex`, which are the only consumers that render decoded hook output into model context.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what hooks cannot do through the shared engine yet. They are current package constraints, not a task backlog.

- **`HookOutput.updatedInput` is parsed but not honored** — input rewrite is a deferred consistency-design problem ([the pre-tool-input-rewrite Agent Note](../../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md)); a bridge logs and warns when a hook sets it.
- **A halt is reported but cannot act where no run is live** — `mergeHookOutputs` folds `continue: false` into a sticky `stop` and a bridge cancels the run through `applyRunHalt`; at a detached lifecycle point, or at session start before the run is live, there is no run to cancel, so the bridge warns and only the `hook/result` record remains.
- **Only command and HTTP handlers run** — the protocol executes `{ type: 'command', command, timeout? }` through `dsh-shell` and `{ type: 'http', url, headers?, timeout? }` as a timed POST; a bridge parses-and-skips the other shapes its dialect defines (`mcp_tool`, `prompt`, `agent`).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

None.

</details>
