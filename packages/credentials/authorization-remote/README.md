---
description: "The authorization Remote owner for users and maintainers exposing credential sign-in flows to browser surfaces."
kind: "package-reference"
---

# @deepseek-ai/dsh-authorization-remote

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-authorization-remote` is the Host owner of the `authorization` Remote namespace: the conversational half of `ctx.authorization` as a browser surface drives it. A sign-in flow is a conversation — the Host shows a page, the human answers a question — while a Remote call is one request producing one result. This service bridges the two with attempts: `begin` opens an attempt and runs its flow in the background, `frames` polls the conversation since a cursor, and `answer`/`decline` settle one pending prompt. The Models page's sign-in companion renders these frames; the seam's own flows (for example `llm-pi-ai`'s provider logins) stay untouched.

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

Mount this plugin when a composition serves a browser surface that signs into provider flows — OAuth for a subscription, an interactive key prompt, an account pick. It requires the `authorization` seam and a credential provider; the flows themselves are registered by the plugins that know how to obtain their own credential.

### The attempt protocol

One sign-in runs through four calls:

1. `begin(key, method?)` opens an attempt and runs its flow in the background, returning `{ attemptId, key, label, method }`.
2. `frames(attemptId, cursor)` returns the conversation after `cursor` — notices, prompts, withdrawals, and the terminal outcome — with the `next` cursor for the following poll.
3. `answer(attemptId, promptId, value)` answers one pending prompt; `decline(attemptId, promptId)` declines it, settling the attempt as `cancelled`.
4. `cancel(key)` withdraws the attempt running for a record from a second call, for a surface answering a Cancel button without holding the first call.

`list()` and `describe(key)` report the registered flows for a picker, while `status(key)` reports whether a grant is stored — never anything it holds — and `signOut(key)` forgets it. Signing out deletes the local record without telling the issuer.

### Failures

Every refusal carries a namespaced code: `authorization/no-flow`, `authorization/unknown-method`, and `authorization/in-flight` for a `begin` that cannot run; `authorization/unknown-attempt`, `authorization/unknown-prompt`, and `authorization/inactive-prompt` for follow-up calls that name nothing answerable. Malformed ids fail as `gateway/bad-request`. A flow that throws carries its own diagnostic on the attempt's failed outcome frame rather than failing any one call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the namespace; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The namespace keeps no conversation state of its own beyond the attempt registry: the seam owns flow lifecycle and the commit contract, and this service only translates between its interaction callbacks and wire frames. Prompt answers travel only from the browser toward the Host, and stored credential values never ride any method — `status` answers a boolean from `describeRecord`, and the prompt answers a surface types are held only until the flow consumes them.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the `AuthorizationRemoteService` and its attempt registry |
| [`src/types.ts`](src/types.ts) | Browser-safe wire vocabulary: flow views, frames, prompts, outcomes |

### Registration and lifecycle

The service registers the `authorization` namespace with one attempt slot per record inherited from the seam: a second `begin` while one runs is refused rather than joined, because two surfaces would prompt two humans through the same flow. Attempts are retained past settlement for late polls and evicted oldest-first, settled first, past fifty.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-authorization](../authorization/README.md) — the flow registry this namespace converses through.
- [Credentials subsystem](../../../docs/subsystems/credentials.md) — the record store and the `authorization/settled` event.
- [Configure models](../../../docs/user/guide/providers.md) — the sign-in surface this namespace serves.

-----

<a id="model-experience"></a>
## Model Experience

None, as authorization is a configuration-time conversation with a human and no flow, notice, or prompt reaches a model request.

#### KV Cache effect

No invalidation; no authorization state enters a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Polling, not streaming** — a surface polls `frames` for the conversation. A login lasts seconds and its frames are few, so one round trip per poll beats a second transport; a streaming projection would only move the same cursor.
- **One surface per attempt** — two pages following one `attemptId` both render its frames, but the first answer wins and the second reads `unknown-prompt` or `inactive-prompt`. The seam's one-attempt-per-key rule is what keeps two humans from answering each other's questions.
- **Fifty retained attempts** — late polls past the bound read `unknown-attempt`. Attempts are small and logins rare; the bound only keeps a forgotten page from growing the registry.
- **Nothing revokes** — `signOut` forgets the local record without telling the issuer, matching the seam's own sign-out semantics.

**Runtime invariant:** No companion is published. The attempt registry is internal to this service: frames derive from the seam's own lifecycle, and no second observation of the same relation exists to diverge.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`status` and `signOut` never ask the seam: they read and delete through `ctx.credentials` (`describeRecord`, `deleteRecord`), because the record store owns the grant and `ctx.authorization` owns only flow lifecycle — which is why a grant written by any other path is still what `status` reports. Prompt ids are per-attempt counters (`p1`, `p2`, …) and mean nothing on their own, so every follow-up call carries the attempt id first; making them globally unique would buy nothing and cost a UUID per question. A prompt a human settled is dropped from `attempt.pending`, while one the flow withdrew stays there with `active: false`, so the two late refusals are not interchangeable: `unknown-prompt` means no prompt was ever pending under that id, `inactive-prompt` means the flow took its question back. `frames` addresses the conversation by array index — `next` is `frames.length` — and per-frame `seq` exists for rendering keys, not for cursor arithmetic.

</details>
