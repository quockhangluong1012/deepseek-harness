---
description: "The Models sign-in companion for users and maintainers offering OAuth and interactive provider logins beside the API-key editor."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-authorization

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-client-ui-settings-authorization` renders the sign-in companion inside every `llm-pi-ai` card on the Models page, through the `settings.models.provider-card` seat. The page itself owns API keys; this companion owns every other method a route's authorization flow offers — OAuth for a subscription, an interactive key prompt, an account pick — so a Claude Pro/Max subscription signs in through the flow pi-ai ships instead of a key the subscription never issued. It polls the attempt it opened over the `authorization` Remote namespace and reports notices, prompts, and the terminal outcome.

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

The plugin activates with the web profile and needs no configuration: it registers one keyed contribution under the `llm-pi-ai` namespace and receives every card of that family. A card whose route offers no sign-in beside its API key renders nothing.

### What the card shows

A route with a stored grant shows a signed-in state with a sign-out action. A route without one shows a sign-in button — or a method picker plus the button when its flow offers several. The dialog renders each notice with its sign-in link and code, the latest unanswered prompt with its input, and the terminal outcome; closing it withdraws the attempt.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the companion; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The companion keeps no shared state: the attempt registry lives on the Host, and each card polls only the attempt its own dialog opened. API-key methods are filtered out because the page already owns them; a second surface answering one attempt would answer another human's question, so the dialog never shares its attempt id.

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Plugin entry: locale registration and the keyed seat contribution |
| [`src/client/SignInCard.tsx`](src/client/SignInCard.tsx) | The card, its dialog, and the actionable-prompt derivation |
| [`src/client/operations.ts`](src/client/operations.ts) | The Host operations the card invokes, as injected callbacks |
| [`src/client/locales.ts`](src/client/locales.ts) | The typed copy dictionaries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Models page](../ui-settings-models/README.md) — the section declaring the seat this companion fills.
- [authorization Remote](../../credentials/authorization-remote/README.md) — the Host namespace this companion polls.
- [Configure models](../../../docs/user/guide/providers.md) — the sign-in flow from the user's side.

-----

<a id="model-experience"></a>
## Model Experience

None, as authorization is a configuration-time conversation with a human and no flow, notice, or prompt reaches a model request.

#### KV Cache effect

No invalidation; no authorization state enters a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Polling, not streaming** — the dialog polls its attempt about once a second while it runs.
- **One card follows one attempt** — a second page opening the same record while one signs in is refused with `in-flight` until the first settles.
- **API-key methods stay on the page** — the companion filters them out, so a flow offering only a key renders nothing here.

**Runtime invariant:** No companion is published. The card derives everything from the Host attempt registry through the Remote namespace; no independent client observation of the same relation exists to diverge.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`actionablePrompt` derives the open question instead of receiving it, because the wire carries no "current prompt": the dialog takes the newest prompt frame that is neither withdrawn nor in its own `answered` set, which is also why a successful `answer` must record the id locally even though the Host has already settled it. The poll cursor is a `useRef` rather than state: an empty answer changes no frame, so the chain must re-arm on the cursor the Host answered from instead of restarting from the one a re-render kept. The `api-key` method is filtered here rather than on the Host, so the flow view stays complete for other surfaces while this companion never offers a sign-in the page's own key editor already covers.

</details>
