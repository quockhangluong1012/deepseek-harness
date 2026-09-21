# Harness latency: tool calls, spawns, and per-step recomputation

**Status:** specification. This document owns the per-tool-call, per-spawn, and per-step latency findings and their staged remediation for the desktop and CLI profiles. The sibling `specs/improvement.spec.md` owns the evolution-harness roadmap and its observed cost list; nothing here changes it.

Slug: `harness-tool-latency`

## Context

The user runs `pnpm run dev:desktop` (Electron shell + `apps/desktop-host/lib/index.js` under plain Node) on Windows 11 and reports that tool calls, skill invocation, compaction, background jobs, and subagent delegation all feel much slower than another harness. The goal is a measured reduction of that overhead on the shipped desktop/CLI compositions, without weakening session recovery semantics.

Static analysis of eight code paths plus two direct measurements on the user's machine produced the ranking below. The dominant cost is not model latency and not the agent loop's structure; it is (a) one private Node.js helper process per subprocess-backed tool call and (b) synchronous durability/payload work repeated per tool call and per step.

Measured on the user's machine (each sample = `execFileSync` of a fresh Node process, `stdio: 'ignore'`, 6 samples, warm filesystem cache):

```
bare node spawn            : 133, 142, 146, 149, 150, 153 ms
same + importing the built
subprocess-local runner.js : 235, 242, 266, 274, 355, 400 ms   (median 270)
```

So a subprocess-backed tool call pays **~250–400 ms of harness overhead before the target command starts**. Cold samples reached ~1.5 s. This is the single largest measured term in the user's complaint, and it is why the ranking below puts the spawn path first.

## What the evidence says

|#|Cost|Frequency|Evidence|Magnitude|
|---|---|---|---|---|
|F1|Every subprocess-backed tool call spawns a private Node runner process (`packages/subprocess/subprocess-local/src/windows-job.ts` `launchWindowsJob` → `spawnRunnerInvocation`). On Windows the runner owns the kill-on-close Job, so this is by design, but the process is created per target.|per `bash`/`pwsh`/`grep`/`glob`/background job|`runner-launch.ts` `spawnRunnerInvocation`, `windows-job.ts:117`, `packages/fs/tool-fs-search/README.md:28,91,106` (grep/glob are `ctx.subprocess` rg spawns)|**200–450 ms per call** (measured floor + import)|
|F2|`session-checkpoint-policy` awaits a durable flush (zstd frame + `open`/`stat`/`write`/`sync`/`close`) before **every** top-level tool body, before every model stream, and before every step.|per tool call, per step|`packages/session/session-checkpoint-policy/src/index.ts:71-84`; `packages/session/session-persistence-jsonl/src/index.ts:1246-1261`|~2–12 ms per barrier; ~3 barriers per step|
|F3|Per-step recomputation with no memoization: `ToolRuntime.view()` rebuilds the layered catalog 3–5× per tool call; `SystemPrompt.assemble` `structuredClone`s every tool's parameters per step; `headerEquals` `JSON.stringify`s every schema twice per step; `tokenMeter.measure()` reprices the whole surface (+`structuredClone`+`deepFreeze`) 1–2× per step even far below threshold; `RuntimeContextProjection.systemNodes()` scans every surface node per step.|per tool call + per step|`packages/core/tools/src/index.ts:1203-1247,1255,1330`; `packages/core/system-prompt/src/index.ts:611-616`; `packages/core/session/src/request-header.ts:22-35`; `packages/llm/token-meter/src/index.ts:152,182-190`; `packages/core/agent-loop/src/runtime-context.ts:64-85`|~1–10 ms per step, grows with session length|
|F4|One tool result is deep-copied/frozen 5–6×: `createSuccessResult` (snapshot + validation + freeze + render snapshot), `finishScheduledExecution` (`materializeFinalResult` twice), `Session.append` (`snapshotJsonValue` + `deepFreeze`), `JsonlSessionHandle.enqueueLive` (`structuredClone`), `materializeAppendBatch` (`snapshotJsonValue`).|per tool result|`packages/core/tools/src/index.ts:1688-1700,1850-1878,1904`; `packages/core/session/src/index.ts:715-739`; `packages/session/session-persistence-jsonl/src/storage.ts:275`; `packages/session/session-persistence/src/storage-contract.ts:131-133`|~0.3–3 ms per 50 KB result|
|F5|Subagent spawn is in-process (no plugin remount — verified good), but the child's session is durably materialized before its first request (Windows: per-segment path walk + write-through moves + temp write + fsync), and the child's first step pays F2–F4 again plus a skill-catalog cache miss keyed by the child's scope chain and a fresh AGENTS.md baseline load.|per spawn|`packages/subagent/subagent-in-process-driver/src/index.ts:134`; `packages/session/session-persistence-jsonl/src/index.ts` `materializeWin32`; `packages/skill/skill/src/index.ts:522-545,643-645`|10–40 ms + one full step of F2–F4|
|F6|A settled background subagent/job notice opens or steers a parent turn: one extra model round trip per settled child (`continuation-activation.ts:827-833`). Structural, not harness CPU.|per background delegation|same|one model latency|

F2's semantics are deliberate and documented (`packages/session/session-checkpoint-policy/README.md`): the policy records that a call was dispatched before any external effect can run, so a crash cannot make a resumed model blindly repeat a side effect. This plan keeps that guarantee for every tool that can have external effects.

## Approach

Four stages, ordered by measured impact. Each stage is one PR (stackable), each stage leaves the tree building and the existing suites passing, and each stage has its own before/after measurement. Stage 0 must land first because it owns the numbers the later stages are judged by. No stage depends on another stage's optimization to be correct — 3.3 stands alone without 3.2, and 2.1 without 2.2 — so a regression is answered by reverting one commit rather than by unwinding a chain.

### Stage 0 — Baseline and guards

**0.0 Land this plan in-tree as a spec.**
Create `specs/harness-tool-latency.spec.md` as a copy of this plan's content, with the `specs/` header convention used by its siblings (`improvement.spec.md`, `evolutionary-harness.spec.md`): a `# Harness latency: tool calls, spawns, and per-step recomputation` title followed by `**Status:** specification. This document owns the per-tool-call, per-spawn, and per-step latency findings and their staged remediation for the desktop and CLI profiles.` Add one line naming the sibling that owns the observed cost list it does not change (`specs/improvement.spec.md` owns the evolution-harness roadmap). Later stages append their measured before/after numbers to this file — it is the durable copy; the Agent Note records the same numbers for the repo's decision history.

**0.1 Package-local diagnostic for the real spawn cost.**
Add `packages/subprocess/subprocess-local/tests/subprocess-local.perf.ts` (the `.perf.ts` suffix is this repo's marker for a package-local diagnostic that does not join `test:bench`, per `benchmarks/AGENTS.md`), `describe.skipIf(process.platform !== 'win32')`. It mounts the provider against a `Context` and spawns a fixed short command (`process.execPath`, argv `['-e', '0']`, collect stdio) `N = 8` times sequentially, printing `{ samplesMs, medianMs, coldMs, warmMs }` and logging which `spawnRunnerInvocation()` branch was taken. It asserts completion, not a time budget: the Windows-only path runs on a developer machine, and a Windows-only case can never be a required lane in a Linux CI (`node-24-bench` runs on ubuntu), so the timing number is evidence for humans while the regression guard is the structural counter in 1.5.
Run it with `pnpm run build && node --test` under the package's own vitest project (`pnpm exec vitest run packages/subprocess/subprocess-local --config vitest.perf.config.ts` if one exists; otherwise `pnpm exec vitest run --config vitest.config.ts packages/subprocess/subprocess-local/tests/subprocess-local.perf.ts`).

**0.2 Extend the existing continuation bench with phase counters.**
In `benchmarks/agent-continuation/agent-continuation.worker.ts`, add to `ContinuationReport`: `flushCount`, `flushMs`, `appendMs`, `assembleMs`, `toolWallMs`. Collect them in the worker only, through public seams — `ctx.on('session/event', …)` to time `Session.append`, `ctx.on('session/flush', …)` to count barriers, and `performance.now()` around `agent.whenIdle()` boundaries for the rest. Do not add production code for measurement.

**0.3 Record the baseline.**
Run `node_modules/.bin/vitest run --config vitest.bench.config.ts benchmarks/subprocess-spawn` (or the repo's `pnpm run test:bench`) and `pnpm run test:bench` for the continuation case on the user's machine, and write the numbers into the Agent Note created in 0.4.

**0.4 Agent Note.**
Add `.agents/notes/implemented/process/<date>-tool-call-latency-reduction.md` (+ `.zh.md`) with the findings table above, the measurement method, the raw samples, and the accepted/rejected fixes. Every later stage appends its before/after to this note.

### Stage 1 — Remove the per-spawn runner cost on Windows (F1)

The runner must stay one-per-target (its Job handle is the containment guarantee). Instead of reusing a runner, pre-spawn the *next* runner speculatively so a tool call finds a connected runner waiting and pays only the IPC handshake.

**1.1 Move target argv onto the IPC start request.**
`packages/subprocess/subprocess-local/src/runner-protocol.ts`: add `argv: readonly string[]` to `WindowsStartRequest`; extend `parseWindowsStartRequest`'s `hasExactKeys` list with `'argv'` and validate every element is a string with a non-empty array. `packages/subprocess/subprocess-local/src/spawn-runner.ts`: the Windows branch reads `request.argv` as the target argv (keep the resolved-executable handling in `resolveWindowsExecutable`); delete the Windows use of `parseRunnerTargetArgv` (the Linux branch keeps it).

**1.2 Split launch from attach.**
In `packages/subprocess/subprocess-local/src/windows-job.ts`, split `launchWindowsJob` into two functions over the same code:
- `spawnWindowsRunner(internals)` — the `spawn(...)` call with the default shape (see 1.3), returning the child plus its `connected` promise. It no longer appends target argv to the invocation.
- `attachWindowsRunner(child, spec, targetEnv, internals)` — everything from `const targetStdin = child.stdio[4]` to the returned `ManagedProcessLaunch`, with the `child.once('spawn')` handler sending `{ type: 'start', argv: spec.argv, cwd: spec.cwd, env: targetEnv }`.
`launchWindowsJob` keeps its signature and becomes: take a spare if one is available and shape-compatible, otherwise `spawnWindowsRunner` + `attachWindowsRunner`; then arm a replacement spare.

**1.3 Spare shape rule.**
A spare is spawned with `runnerStdio(spec, true, 'pipe')`-equivalent stdio and is consumable only when the incoming spec's stdio matches that shape (`stdin: not 'ignore'`, `stdout`/`stderr` piping, i.e. the collect shape used by `tool-bash`, `tool-pwsh`, and `tool-fs-search`). Any other shape (for example an `inherit` request) spawns on demand exactly as today. Export a predicate `spareRunnerServes(spec): boolean` next to `runnerStdio` so the rule is one function, not an inline condition.
Arming is driven by observation, not by the expectation that a spare will be used: the provider arms a replacement **only after a collect-shaped spawn was consumed**, so a workload that only ever spawns `inherit`-shaped targets never pays for an unused spare. Do not arm at provider mount — a session that never calls a subprocess tool must not hold an idle Node process.

**1.4 Own the spare with a lifecycle.**
Add `packages/subprocess/subprocess-local/src/windows-prewarm.ts` exporting `class WindowsRunnerPrewarm` with `arm(): void`, `take(spec): RunnerProcess | undefined`, `dispose(): void`. It holds at most one child and obeys all of:
- At most one outstanding arm at a time (`arm()` while a spare exists and is live is a no-op).
- `take(spec)` returns the child only when `spareRunnerServes(spec)` AND the liveness predicate holds — `child.connected === true && child.exitCode === null`; otherwise it discards the child and returns `undefined`, and the caller spawns on demand. Clearing the slot on the child's `'close'` and `'error'` is the normal path; the predicate covers the gap between the two.
- The replacement arm runs on the next macrotask after the consuming spawn settles (`setTimeout(…, 0)`, cleared on dispose), so the 250–400 ms of arming CPU never competes with streaming, tool-result serialization, or the request that is about to be assembled.
- The spare is killed when it is superseded, when it is not consumed within `PREWARM_IDLE_TIMEOUT_MS` (internal scheduling constant, 30 s, documented with the same wording as `LIVE_WRITE_BATCH_MAX_DELAY_MS` in `session-persistence-jsonl/src/storage.ts:36`), and on `dispose()`.
- `arm()` is a no-op once disposal has started.
In `packages/subprocess/subprocess-local/src/index.ts`: construct it in `apply()` only when `process.platform === 'win32'` and `probeWindowsJob()` reports the native path available; `dispose()` it inside the existing `ctx.effect` teardown before `disposeManagedProcesses()`; and add the spare child to the same kill path `terminateForHostExit()` already walks. No spare failure may fail a real spawn: a dead, unconnected, or handshake-failing spare is discarded and the spawn falls back to `spawnWindowsRunner`.

**1.5 Tests.**
Extend the existing `windows-job` unit tests (they already inject `WindowsJobInternals`: `spawn`, `runnerInvocation`, `runnerAvailable`) with: a spare is consumed by the next spawn (one `spawn` call for two targets); a shape-mismatched spec does not consume the spare; a dead spare falls back; `dispose()` kills the spare; the idle timeout kills an unused spare. Use fake timers for the timeout.
These injected-seam tests are the CI-visible regression guard: they assert the spawn *count*, not a duration, so they run in the Linux CI lane where the Windows timing case cannot. The `spawn` call count for two sequential collect-shaped spawns must be exactly 2 (one consumed spare, one replacement arm) rather than the pre-change 2 real spawns + 0 — pin the counter, not the clock.

Acceptance: the Stage 0.1 diagnostic's median drops from the pre-change value by at least 100 ms on the user's machine, and `coldMs` (the first spawn, which has no spare) stays at the pre-change level. Record both raw sample sets in the Agent Note.

### Stage 2 — Cheaper durability barriers (F2)

**2.1 Let read-only tools skip the pre-body checkpoint.**
`packages/core/tools/src/schema.ts` (`ToolDefinition` options, near `timeoutMs`) gains:
```ts
/**
 * Whether dispatching this call can change state outside the harness. A tool
 * that declares `false` runs without the pre-dispatch durability checkpoint,
 * because a crash cannot make a resumed model repeat an effect it never had.
 * Absent reads as `true`, so every tool that does not declare it keeps the
 * fail-closed behaviour.
 */
readonly externalEffects?: boolean
```
Thread it through `defineTool` the same way `timeoutMs` is threaded (`schema.ts:600`), and read it in `packages/session/session-checkpoint-policy/src/index.ts`'s `tools/execute` listener: resolve the definition through `ctx.tools.get(exec.name, exec.agent)` (the same call `timeout-policy` already makes) and skip only the `await ctx.sessions.flush(…)` when it resolves to an exact `false`. Everything else in that listener stays byte-for-byte: the `exec.agent === undefined || exec.parent !== undefined` guard, the post-flush `exec.signal.aborted` recheck that returns `abortedBeforeDispatchResult()`, and fail-closed propagation of a flush rejection. The `llm/stream` and `agent/pre-step` barriers stay unconditional — only the pre-body barrier becomes conditional.
Declare `externalEffects: false` on exactly three first-party tools: `read` (`packages/fs/tool-fs`), `glob` and `grep` (`packages/fs/tool-fs-search`). Do not mark `lsp` (it has rename/edit actions), `bash`, `pwsh`, `write`, `edit`, `todo_write`, `ask_user_question`, `session_query`, or any web tool.
Add one guard test in `session-checkpoint-policy/tests/**` naming the three tool names and asserting (a) each of them skips the flush, (b) a definition without the field still flushes, and (c) the aborted-signal path still returns `ABORTED_BEFORE_DISPATCH` with no flush. Document the field in the checkpoint policy README's `Three barriers are checkpointed` paragraph and in the tool cookbook.

Residual risk accepted here: a tool that declares `false` while effects reach outside the harness loses its durable intent record, so a crash could make a resumed model repeat that effect. The fail-safe default, the three-name allowlist, and the guard test are the mitigation; a fourth tool must not be added to that list without its own evidence that the body cannot change external state. An earlier flag of this shape was rejected for session projections (`.agents/notes/archived/architecture/2026-08-19-session-projection-state-and-client-views.md`); it is accepted here because it defaults to the safe value and can only remove work from tools whose body cannot change external state.

**2.2 Reuse one append handle across batches — only if the measurement licenses it.**
Gate: run Stage 0.2's continuation case and read the ratio of `flushMs` to the number of barriers. If the `open`/`stat`/`close` share of a barrier is under half of it, STOP here and record the measurement — the remaining barrier time is `fsync`, which this step cannot remove, and the churn is not worth the change to a crash-recovery path.
If the gate passes: `packages/session/session-persistence-jsonl/src/index.ts` `appendLines` opens, stats, writes, syncs, and closes per batch. Keep the append `FileHandle` in the handle's storage state instead — open lazily on the first append of a write handle (in `persistContiguous`, next to `ensureLease`), reuse it for later batches, and close it in `JsonlSessionHandle.close()` before the lease release. Keep the pre-write `stat()` on the first write after open and track the bytes this handle wrote for later rollbacks, so `rollbackAppend` keeps its exact previous-size input.
Two hazards this step must handle, both verified in the current code: (a) a session-generation change (migration writes a different file) invalidates the cached handle — close and reopen it whenever the resolved generation path changes, and (b) `rollbackAppend` opens a second `r+` handle to truncate, so the retained append handle must keep `O_APPEND` semantics for the next write to land at the new end rather than at a stale offset.
Verification: `packages/session/session-persistence-jsonl/tests/**` storage-contract and live-write suites pass unchanged; add one test asserting a second append reuses the same file handle (inject a recording `open`) and one asserting the handle reopens after a generation change.

### Stage 3 — Remove per-step and per-call recomputation (F3)

**3.1 Memoize `ToolRuntime.view()`.**
Own the invalidation token where the mutations happen: `packages/core/scope/src/store.ts` `ScopedLayers` already funnels every layer mutation through one private callback (`this.onChange()` at `store.ts:260,262`). Replace those call sites with a single `notifyChange()` that both bumps a new `private revision = 0` and calls `onChange`, and expose `get revision(): number`. Any other mutation site in that class must route through `notifyChange()` too — grep every mutation in `store.ts` and prove none bypasses it, because a missed bump silently serves a stale catalog.
Then, in `packages/core/tools/src/index.ts`, cache `view()` in a `WeakMap<object, { revision: number; view: ToolView }>` keyed by the scope key, plus one field for the undefined-scope view, returning the cached view while `this.layers.revision` is unchanged. `modeFor` reads the same layers, so mode and restriction changes are covered by the same token. Test: register a tool after a first `get()` and assert it becomes visible; remove it and assert it disappears; restrict a scope and assert a hidden tool stays hidden.

**3.2 Stop re-snapshotting and re-cloning tool schemas.**
`packages/core/tools/src/index.ts` `schemaOf(definition, true)` calls `snapshotJsonValue(parameters)` per call. Compute the detached, deep-frozen schema **at registration** inside `ToolLayer.insert` (where the definition is already validated and owned) and have `schemaOf` return it, so a definition's schema is copied exactly once per process rather than once per lookup. Do not compute it lazily on first lookup: a caller that registers a definition object and then mutates it would otherwise freeze the first observed shape.
`packages/core/system-prompt/src/index.ts:611-616` then drops its `structuredClone(parameters)` and reuses `result.schemas` as received, documenting in its JSDoc that a tool provider must hand over detached values this assembly never mutates. A `system-prompt/assemble` listener that mutates tool schemas now fails loudly on the frozen objects — that is the intended contract and must be stated in the package README.

**3.3 Digest-based header comparison.**
`packages/core/session/src/request-header.ts`: keep `headerEquals`'s semantics exactly, and replace `JSON.stringify(a) === JSON.stringify(b)` in `sameSchema` with a memoized serialization — a module-level `WeakMap<object, string>` keyed by each schema *object*, storing the exact `JSON.stringify(schema)` result, so equality is still string equality, not a hash with a collision risk. Memoize only objects for which `Object.isFrozen(schema) && Object.isFrozen(schema.parameters)` is true, and serialize directly for anything unfrozen; that single check removes the only failure mode (a foreign provider hand-mutating an object after its digest was cached). Stage 3.2 makes the live assembly's schema objects stable across steps, so both the live side and the folded header side hit the cache after their first comparison. `toolsChanged` and `buildRequest` then compare a handful of cached strings per step instead of re-serializing ~2×N schemas three times per step. If review rejects Stage 3.2's contract change, this step still stands alone: it just serializes each distinct object once instead of once per comparison.

**3.4 Memoize the token measurement.**
`packages/llm/token-meter/src/index.ts` `measure(session, requestHeader?)` (`index.ts:145`) reprices the whole surface and returns `deepFreeze(structuredClone(…))`. Key a retained measurement on the meter's own `logRevision`, the resolved pricing identity, the file-text identity, and the `requestHeader` argument identity (a `WeakMap` for the header object plus one field for the `undefined` case) — all four, because a different header is a different measurement. Return the retained frozen value when all four are unchanged. Both per-step callers (`compaction-basic` and `guard/budgets`) pass the session and, within one step, the session's same folded header object, so they share one repricing per step instead of 1–2 full `priceSurface` passes plus `structuredClone` + `deepFreeze`. Invalidate whenever the meter folds a new event. The retained value is a frozen snapshot of a derived measurement, so a stale read is impossible while the key holds; do not extend retention beyond the current session.

**3.5 Cache the system-node scan.**
`packages/core/agent-loop/src/runtime-context.ts` `systemNodes()` walks every surface node once per step. Cache the resulting array keyed by the pair (`surface.replaceGeneration`, `surface.nodes.length`) and skip the walk when both are unchanged — a compaction `replace` bumps the generation and an append grows the length, so the pair covers every way the answer can change. Do not use an incremental high-water mark: a replacement splices nodes into positions before the mark, and the keyed cache sidesteps that hazard for the same win (the walk happens once per surface change instead of once per step).

**3.6 Cache the project-root probe.**
`packages/context/agent-instructions/src/index.ts` `compose()` calls `findProjectRoot(cwd, projectRootMarkers, …)` on every `agent/pre-step`, which walks ancestors probing markers. Cache the resolved root per `(cwd, markers)` in a `Map` for the plugin's lifetime; a session's cwd and the configured markers do not change. Accepted consequence: a project root marker created mid-session (for example a `.git` initialized after the session started) is not observed until the next session — record that in the package README's `Known Limitations and Deferred Work` section, next to the existing touch-driven refresh bullet. Leave the per-scope candidate probes alone; they carry the documented refresh semantics.

### Stage 4 — Remove redundant payload traversals (F4)

**4.1 Make result materialization idempotent.**
`packages/core/tools/src/index.ts` `materializeFinalResult` builds a fresh object and deep-freezes it on every call (`index.ts:1904-1919`: `deepFreeze({ ...detached, value: result.value })` for success, `materializePresentation(…)` — `snapshotJsonValue` + `deepFreeze` — for errors), and `finishScheduledExecution` runs it twice per call on top of `createSuccessResult`'s own materialization. Add `private readonly materializedResults = new WeakSet<object>()`; return the input immediately when it is already in the set, and add the object this call returns whenever it did the work. Record only deeply frozen outputs — both branches above are, so the invariant is local and checkable. This collapses the `createSuccessResult` → `finishScheduledExecution` chain from 4–5 traversals to 1 and makes the second `materializeFinalResult` in `finishScheduledExecution` free when no `finalizeContent` is registered. A result replaced by a tool-owned finalizer is a new object and still gets its own traversal; do not skip that. The WeakSet holds references weakly, so retained memory does not grow with session length.

**4.2 Stop cloning the event again in the persistence route.**
`packages/session/session-persistence-jsonl/src/storage.ts` `enqueueLive` does `this.buffered.push(structuredClone(event))`. `Session.append` has already deep-snapshotted and deep-frozen the same graph before the `session/event` fan-out reaches this listener (`packages/core/session/src/index.ts:720-739`), so the clone protects against a mutation that freezing already makes impossible. Push the event reference and document the invariant on `enqueueLive` ("the routed event is the frozen durable graph owned by `Session.append`; it is shared, never copied, and a mutation attempt throws rather than diverging"). Leave `materializeAppendBatch`'s snapshot alone — that is the seam's own boundary and the remaining copy is deliberate.
Guard the invariant rather than the timing: add one test asserting the buffered entry is the identical object (`toBe`) and that `Object.isFrozen` holds deep down the event. If a future change stops deep-freezing appended events, that test fails before aliasing can corrupt a durable batch.

## Critical files and anchors

- `packages/subprocess/subprocess-local/src/windows-job.ts` — `launchWindowsJob`, the `child.once('spawn')` start handshake at the end of the file; the two halves that Stage 1.2 splits.
- `packages/subprocess/subprocess-local/src/runner-protocol.ts` — `WindowsStartRequest` + `parseWindowsStartRequest`; the exact-keys validation is a private wire protocol, so the new field must be added there and nowhere else.
- `packages/session/session-checkpoint-policy/src/index.ts` — the three barriers; the only place that decides durability boundaries.
- `packages/core/tools/src/index.ts` — `view()`, `schemaOf`, `materializeFinalResult`, `finishScheduledExecution`, the `ScopedLayers` change callback; all of Stage 3.1/3.2 and Stage 4.1 live here.
- `benchmarks/agent-continuation/agent-continuation.worker.ts` — the only existing real-agent-loop measurement; Stage 0.2 extends it.

## Verification

Prerequisites: `pnpm run build` once (bench workers import built `lib/`), Node per `engines`, `DSH_GATE_VERBOSE` unset, working directory = repo root, no API key needed (every case here is keyless with a synthetic adapter).

- Stage 0: run the package-local diagnostic (`pnpm exec vitest run packages/subprocess/subprocess-local/tests/subprocess-local.perf.ts`) and `pnpm run test:bench` for the extended continuation case; paste raw samples into the Agent Note. Local timing on this machine varied up to 2.5× between samples, so compare medians of repeated runs and treat local numbers as direction only — CI budgets come from CI medians, never from a laptop run.
- Stage 1: the diagnostic's median decreases on the user's machine while `coldMs` holds; `pnpm exec vitest run packages/subprocess/subprocess-local` passes with the spawn-count assertions from 1.5 (this is the CI-visible guard, since the timing case is Windows-only); `pnpm exec vitest run packages/fs/tool-fs-search packages/shell` passes (their spawn specs assert argv and stdio, which the IPC-started target must keep identical).
- Stage 2: `pnpm exec vitest run packages/session packages/core/tools` passes; `pnpm run test:snapshot` is unchanged (no model-visible change); the continuation bench's `flushCount` for the same workload drops by the number of read/glob/grep calls in the scripted turns and its `flushMs` drops accordingly.
- Stage 3: each sub-item is its own commit with its own micro-assertion: 3.1 registers a tool after a first lookup and must see it; 3.2 asserts `ctx.tools.schemas()` returns an identical (===) parameters object on two calls; 3.3 asserts identical headers compare equal and one changed description compares unequal; 3.4 asserts the second `measure()` in the same revision returns the identical object and a new event invalidates it; 3.5 asserts a second `project()` over an unchanged surface does not re-walk the nodes and that an append and a replacement each do; 3.6 asserts one `findProjectRoot` walk across three pre-steps. Then `pnpm run test:snapshot` unchanged and `pnpm run test` for the touched packages.
- Stage 4: `pnpm run test` for `packages/core/tools`, `packages/session/session-persistence-jsonl`, `packages/session/session-checkpoint-policy`; `pnpm run test:snapshot` unchanged.
- Whole change set: `pnpm run check:all` once at the end (repository-wide, cross-package), and per-PR checks via `.agents/skills/dsh-pre-push-checks/SKILL.md`.
- End-to-end confirmation on the user's path: launch `pnpm run dev:desktop`, run a task that issues a `grep`, a `bash`, and a `read` call in one turn, and compare the tool-call wall time reported by the `sessionStats` projection (`toolMs`) before and after. Record both.

## Assumptions and contingencies

- The user's reports come from the desktop dev profile, which runs built `lib/` under plain Node (`apps/desktop-host` is started with `DSH_DESKTOP_NODE_BINARY=process.execPath` and `lib/index.js`), so `spawnRunnerInvocation()` takes its non-`.ts` branch and the runner is plain `node <lib/runner.js>`. If a spawn turns out to run through the `tsx` branch (source launch), Stage 1 still helps but the baseline will be far larger; the Stage 0.1 diagnostic logs which branch ran, so read that line before interpreting any number.
- Stage 1 assumes a spare runner can be launched with the collect stdio shape and that shell/search tool calls use that shape. If the diagnostic shows most real spawns use `inherit` or `stdin: 'ignore'`, extend `spareRunnerServes` with a second spare slot for that shape instead of widening the rule.
- Every stage's timing claim is a Windows developer-machine claim. The CI-visible protections are structural: spawn counts (1.5), buffer identity and frozenness (4.2), identical schema objects across lookups (3.2/3.3), and the existing benchmark lane in `benchmarks/agent-continuation/`. If a stage can only be justified by a local timing number, it does not get a CI gate.
- Stage 2.2 assumes the write lease makes this handle the session's only writer. If review finds a second in-process writer path, skip 2.2 entirely and keep the per-batch `open`/`stat`/`close`; the barrier cost then stays at the Stage 0 baseline, which is still correct.
- Stage 3.2 changes the mutation contract of the `system-prompt/assemble` waterfall (frozen tool schemas). If review rejects that, keep `structuredClone` in `assemble` and take only Stage 3.3's serialization cache — the per-step cost then halves instead of disappearing.
- If `pnpm run test:snapshot` shows any diff at Stage 3.2/3.3, stop and treat it as a behavior change: the recorded request headers are the authority for what the model saw.
- F6 (background settlement opening a parent turn) is deliberately not addressed here; it is a product decision about delegation feedback, not a harness-cost defect.
- Not taken, so a later reader does not re-litigate it: owning the Windows Job from the host process instead of a helper runner. That removes the per-spawn process entirely but changes the containment and shutdown design (kill-on-close ownership, host-exit finalization), which is a design change and not a spawn-path optimization.
