# Context compiler

English | [中文](agent-context.zh.md)

The context compiler owned by [`@deepseek-ai/dsh-agent-context`](../../packages/runtime/agent-context/README.md). It observes the assembly [`core/system-prompt`](../../packages/core/system-prompt/README.md) produces, wraps each contribution and each durable task fact in a source envelope, orders and prices them, cuts the placement at a configured token ceiling, and records one `context/compiled` event per assembly. It owns no prompt contribution and no model request: `system-prompt` keeps every section and runtime context, [`agent-kernel`](agent-kernel.md) keeps the task contract it reads, and `core/agent-loop` renders the request from the assembly the compiler returns. Declarations live in [`packages/runtime/agent-context/src/types.ts`](../../packages/runtime/agent-context/src/types.ts); the package README defines the configuration and the mount contract.

## Source envelope

`ContextSourceKind` is the closed union `policy | task | plan | memory | evidence | artifact | history | tool`. `RetentionClass` is `required | compressible`, and `OmissionReason` is `budget | duplicate`.

`ContextSource` is one contribution the compiler may place: the `id` unique within one compile, the `kind`, the exact `content` the source contributes, the `TrustLabel` and `Provenance` from [`agent-kernel`](agent-kernel.md), the `retention` class, and an optional `subject` naming the claim the source makes. A source the compiler reads from the assembly keeps its registered name as `id`; a durable fact uses a derived key.

An assembled contribution's kind, trust, and attribution come from the prefix table in [`src/classify.ts`](../../packages/runtime/agent-context/src/classify.ts), and an unlisted prefix resolves to untrusted repository content. A fact read from `KernelView` is always `trusted` and always `required`: the objective, one source per acceptance criterion, one per constraint, the latest plan revision, one per unsettled action, and one per unresolved failure. Retention follows the kind, so `policy`, `task`, `plan`, and `evidence` sources are placed even when they alone exceed the ceiling.

## Placement

`CompiledSource` is a placed envelope with its lexical `relevance` to the task objective in [0,1] and its fixed-heuristic `tokens` price from `dsh-token-meter`.

`ContextCompiler.compile()` takes one `ContextCompileInput` — the assembly, additional durable sources, the objective relevance is scored against, and an optional ceiling — and returns a `CompiledContext`: the `included` sources in placement order, the `omitted` ones with their reasons, the retained `conflicts`, the placement's `tokenEstimate`, its `digest`, and the `compilerVersion` that produced it. The default compiler is pure, deterministic, and free of I/O.

Ordering is total, so a replay reproduces a placement from the same sources: trust (`trusted`, `unknown`, `untrusted`), then kind (`policy`, `task`, `plan`, `evidence`, `memory`, `artifact`, `history`, `tool`), then relevance descending, then `id` by code unit. The ceiling cuts a prefix of that order, so once one compressible source does not fit, every later compressible source is omitted as `budget`. A compressible source whose content an already-placed source carries is omitted as `duplicate`; a `required` source is dropped by neither rule.

`ContextConflict` names one claim two placed `required` sources disagree about: the `subject` and the disagreeing source ids in placement order. The compiler reports a disagreement and never resolves one, and it records nothing for a `subject` only one source declares.

The `digest` is the identity a replay must reproduce: a SHA-256 over the compiler version, the ceiling, and, per placed source, its id, kind, trust, retention, price, relevance, and content hash, plus every omission and every conflict. It covers no clock and no generated identity.

## Durable record

`ContextCompilationEntry` is one placed source as the log keeps it, without its model-facing content; `ContextCompilationRecord` is the whole `context/compiled` payload: the digest, the compiler version, the ceiling, the token estimate, the entries, the omissions, and the conflicts.

The record is written once per assembly that names an agent, and the prompt text itself stays on the `system/message` surface, so the log carries the placement's identity rather than a second copy of the prompt. The event is log-only and never enters model context; the [Session page](session.md) owns the event-map contract it extends.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentcontext--agentcontextservice"></a>

### `ctx.agentContext` — `AgentContextService`

The compiler service (`ctx.agentContext`). It attaches to the prompt assembly waterfall in its constructor, so unloading the plugin unloads the listener with it.

```ts cordis-catalog
/**
 * Compile one assembly for a live agent and record the placement.
 * @param agent - the agent the assembly is for.
 * @param assembly - the assembled prompt contributions.
 * @returns the placement, already appended as `context/compiled`.
 */
async compile(agent: Agent, assembly: PromptAssembly): Promise<CompiledContext>
```

Types: [Agent](core.md)

Source: [`packages/runtime/agent-context/src/index.ts`](../../packages/runtime/agent-context/src/index.ts)
<!-- END GENERATED cordis-surface -->
