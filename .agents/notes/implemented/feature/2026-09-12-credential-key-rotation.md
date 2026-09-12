# Agent Note: Credential Key Rotation on the Credential Seam

Status: implemented

English | [中文](2026-09-12-credential-key-rotation.zh.md)

## Problem

`llm-fallback` shipped a deployment-owned rotation hook (`ctx.llmFallbackKeyRotation`) that runs before a route switch, but a hook had no way to actually rotate a key. The credential seam could `resolve` a reference per operation and `set` a new value, and a correct rotation is read-decide-replace: the decision must see the value as it stands now, inside the same lock as the write, or two processes rotating one key lose whichever wrote first. Composing the existing `resolve` and `set` from a hook leaves the exclusive window open between the two calls.

## Decision

The credential Service Definition gains one abstract reference-write method:

```ts
abstract rotate(ref: CredentialRef, mutate: (current: string | undefined) => string): Promise<void>
```

`rotate` is `modifyRecord`'s twin on the reference half: `mutate` receives the value the reference resolves to at the moment the write is exclusive, its returned non-empty value is persisted, and the commit publishes `credentials/reference-updated` exactly once, after the durable write. The value exists only as that callback argument — the seam never returns it and never caches it across calls. Providers own the locking: `LocalCredentialProvider` runs `rotate` on the same operation chain and cross-process writer lock as `set`/`modifyRecord`, re-reads the document first, and admits the result before rendering so a blank can never be persisted as a stored reference.

The rotation policy stays deployment-owned. Which key comes next — a pool, a vault, a schedule — is the deployment's decision function, reached through the hook `llm-fallback` already ships ([LLM Route Fallback without Loop Changes](2026-09-11-llm-fallback.md)); the seam owns only the locked read-decide-replace. A deployment writes `await ctx.credentials.rotate(ref, current => nextKey(current))` inside that hook.

An environment-shadowed reference is refused loudly, on the same terms as `set`/`unset`: the inherited launch environment cannot be edited from inside, so a committed rotation would resolve to the shadowing value forever — a write that appears to succeed and has no effect, which is worse than a failed call.

## Alternatives considered

- **A concrete default built from `resolve` plus `set`.** Rejected: the exclusive window would span two operations, so a concurrent writer could slip between the decision and the write — exactly the lost-rotation bug `rotate` exists to prevent.
- **A separate key-rotation service or an `llmFallbackKeyRotation` implementation shipped in the credentials packages.** Rejected: the seam already owns the reference write path and its event, so a second write path would need its own lock and notification semantics beside an existing one.
- **Rotating an environment-shadowed reference into the store.** Rejected: the write would commit and the next `resolve` would still return the launch environment's value, so the call would report success with no observable effect. Users get a loud rejection naming the shell variable instead.
- **Letting `mutate` return `undefined` to decline, like `modifyRecord`.** Rejected for this primitive: a rotation policy with no next key simply does not call `rotate`, and a value-returning signature keeps the callback's single job unambiguous.

## Consequences

A rotation hook now has a primitive whose result serves the next request — no restart and no configuration edit. The value-returning callback makes a no-op rotation inexpressible; a policy with nothing to do skips the call. The abstract method is a breaking change for every `CredentialProvider` subclass, so both in-repo test doubles (the credentials and authorization memory providers) implement it in the same change. `set`/`unset` remain the paths for a value the caller already holds; `rotate` is the path where the next value depends on the current one.

## Testing

Seven specs pin the local provider: a decision that sees the stored value and a first write for an absent one, a `.env`-supplied reference whose stored replacement outranks the fallback, a loud refusal when the launch environment shadows the reference, an empty decision rejected before anything is written, a throwing decision that commits nothing and notifies nobody, and refusal after disposal; the drain suite covers the queued-after-disposal branch. Two more pin the composition with `llm-fallback`'s hook contract: a registered hook rotates the reference and the next `resolve` serves the new key, and a throwing policy rejects with the store untouched so the fallback can warn and still switch. Per-file 100% holds on both `src` trees.
