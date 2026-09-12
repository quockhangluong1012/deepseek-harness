# Agent Note: Parallel scope keys

Status: implemented

English | [中文](2026-09-12-parallel-scope-keys.zh.md)

## Problem

The [parallel tool-call decision](2026-07-10-parallel-tool-call-execution.md) gives every call one unary classifier, `isConcurrencySafe(args)`. That answers "may this call overlap with any sibling?" but not "may it overlap with *this* sibling?". A tool that mutates one resource per call cannot use it: two `write` calls to the same path are each safe beside an unrelated read, yet unsafe beside each other. Such tools declare themselves exclusive and forfeit every overlap, which the earlier note records as an accepted limitation of the unary contract.

`specs/improvement.spec.md` Phase 1 names the missing contract: `defineTool.parallelScopeKey(args): string`, consulted by the native scheduler.

## Decision

An author may declare `parallelScopeKey(args)` beside `isConcurrencySafe`, returning an opaque key that names the resource the call occupies. The scheduler compares keys by exact equality and never interprets them. Two calls that return the same non-empty key never overlap; an empty return, an omitted declaration, or a non-string raw return declares no scope. Both classifiers are pure and synchronous, and the scope classifier is consulted only when the overlap classifier returned exactly `true` for the same arguments.

`defineTool` validates arguments before calling the typed classifier and returns no scope for invalid arguments, which are already exclusive. A throw from either classifier makes the call exclusive, so an unclassifiable call never joins a pool.

`ToolExecutionMode` carries the classification: `{ kind: 'parallel'; scopeKey?: string } | { kind: 'exclusive' }`. `ctx.tools.executionMode(exec)` remains the single entry point, so no new registry API and no second resolution path exist.

The scheduler keeps the scope keys of in-flight dispatches. A pending call whose key is already held is withheld until the current pool drains; once its holder settles the call starts when a pool slot frees. Same-key calls therefore run one at a time in model order and remain inside the same group, while distinct keys and unscoped calls keep packing up to `maxParallelToolCalls`. An exclusive call still forms an ordering barrier that no scope key bypasses.

PTC mode is unchanged: one native `run_code` call still dispatches its sub-calls through its own serial queue, so `maxParallelSubCalls` semantics are untouched.

## Declared scopes

Filesystem mutation declares the resource it occupies: `write` and `edit` key on `file_path`, `str_replace_editor` keys every command on `path`, and all three sit behind `isConcurrencySafe: () => true`. The key is the platform `node:path` normalization of the argument, so `./a.txt` and `a.txt` name one scope while `a.txt` and `b.txt` pack together. One key covers all three tools, so a write and an edit of the same path serialize instead of racing into a stale-version failure.

Normalization does not collapse case-insensitive aliases or symlinks, so such a pair can still overlap. For `edit` and the editor's guarded commands the observation guard fails closed with `FS_STALE_VERSION`; `write` replaces the whole file, where the later call's content is the result either way.

## Consequences

Tools whose safety is relational can now declare it without the scheduler comparing calls: the tool states which resource it occupies, and equality does the rest.

Scope keys are process-local strings compared within one step's pool. They never serialize across agents, steps, or processes, and a key is released when its dispatch settles rather than when its results commit, so the ordering guarantee is "no overlap while held", not a lock the caller can observe.

Nothing verifies the claim. An over-broad key silently serializes (lost concurrency, never a correctness gain), and an under-broad key reintroduces exactly the race the tool meant to prevent. This is the same trust relationship `isConcurrencySafe` already carries, and it is why the two declarations live together: a tool that cannot name its resource correctly should stay exclusive.

Model-visible behavior is untouched. The metadata never reaches `schemas()`, a prompt, or the session log, and results still commit in model order.

## Verification

Unit coverage pins the classification contract in `packages/core/tools/tests/execution-mode.spec.ts`: a declared key rides the parallel mode, an empty key reads as no scope, a key is ignored when the overlap classifier rejects the call, throwing and non-string classifiers classify exclusive, invalid arguments never reach the scope classifier, and neither classifier reaches `schemas()`.

Scheduler coverage in `packages/core/agent-loop/tests/tool-calls.spec.ts` pins the observable behavior: three same-key calls start one at a time in model order, while three distinct or unscoped keys start together.

First-party pins hold the declared scopes: `packages/fs/tool-fs/tests/tools.spec.ts` and `packages/fs/tool-str-replace-editor/tests/tools.spec.ts` read an unnormalized `./a.txt` write and an `a.txt` edit as one key, an unscoped `read`, and a different path as a different key.

`pnpm run verify-type-equiv` keeps the declaration blocks in [tools](../../../../docs/subsystems/tools.md) identical to the source.

## Alternatives considered

**Sibling-aware classification.** Hand the classifier the pending batch so it can compare calls. This needs shared resource identity and conflict semantics across unrelated tools, and it makes a pure predicate depend on batch order.

**A mutex owned by the tool inside `execute`.** This serializes after dispatch, so the pool still starts every call, cap accounting counts calls that are really waiting, and the loop can hold a committed result behind a slow sibling.

**A registry-level resource lock declared with its own vocabulary.** A second declaration type plus a runtime handle buys the same effect and leaves the native and PTC paths to reconcile two resource models.

**Leaving such tools exclusive.** Correct and already available, but it forfeits overlap between calls that touch different resources — the case that motivated the contract.
