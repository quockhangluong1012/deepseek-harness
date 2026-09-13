# Agent Note: Browser sign-in for subscription OAuth flows

Status: implemented

English | [中文](2026-09-13-browser-sign-in-for-subscription-oauth-flows.zh.md)

## Problem

The Models page knew exactly one credential shape: an API key typed into a field. Every provider route that authenticates another way — a Claude Pro/Max subscription through Anthropic OAuth, a ChatGPT subscription through Codex OAuth — had its flow registered on `ctx.authorization` by `dsh-llm-pi-ai` and no surface to run it. The user guide said so outright: providers that sign in with OAuth were not supported on the page. A subscriber's only path was to buy API credit separately and paste a key their subscription never issued.

## Decision

The web profile now serves subscription sign-in beside the API-key editor. Three pieces ship together:

- `dsh-authorization-remote` (`packages/credentials/authorization-remote`) owns the `authorization` Remote namespace. A sign-in is a conversation but a Remote call is one request producing one result, so the namespace bridges the two with attempts: `begin` opens an attempt and runs its flow in the background, `frames` polls the conversation since a cursor, and `answer`/`decline` settle one pending prompt. Prompt answers travel only browser-to-Host; notices, prompts, and the terminal outcome travel only Host-to-browser; stored values never ride any method. `status` answers whether a grant is stored, and `signOut` forgets it.
- `dsh-client-ui-settings-authorization` (`packages/client/ui-settings-authorization`) renders the companion inside every `llm-pi-ai` card through the `settings.models.provider-card` seat the Models page declares for exactly this extension. API-key methods are filtered out because the page owns them. The dialog polls its attempt, renders each notice with its sign-in link and code, answers the latest unanswered prompt, and closes the loop on the terminal outcome; closing withdraws the attempt.
- The `web-app` bundle mounts the `authorization` seam (which offers no flows of its own), the remote owner, and the companion. The `authorization/settled` event is forwarded to browsers so a second tab learns an attempt ended.

The `authorization/settled` event declaration moves from the seam's main entry to its browser-safe `./types` subpath, following the `credentials/record-updated` precedent: the Client face can only consume declarations that carry no Host Cordis merge.

## Alternatives considered

- **Edit the Models page to own sign-in.** Rejected: the provider-card seat exists so adapter families extend the page without editing it, and the slot discipline fails the build on undeclared renders. A companion plugin is what the seat is for.
- **Stream the attempt instead of polling.** Rejected: the conversation still needs client-to-Host answers, so a stream would need a second answer RPC beside it. One poll per second for a login that lasts seconds is the smaller mechanism; the Host package README records this.
- **Expose the seam's `begin` directly as one Remote call.** Rejected: `begin` takes an interaction object with callbacks, which has no wire form. The attempt registry with cursor polling is the wire form.
- **Share one attempt across surfaces.** Rejected: the seam refuses a second `begin` per key because two surfaces would prompt two humans through one flow. The companion never shares its attempt id, and a second page reads `in-flight` until the first settles.

## Consequences

Subscription holders sign in where they configure models, and API-key-only deployments see no change: a flow offering only a key renders nothing from the companion. What the change costs is a second credential path with its own lifecycle — attempts are process-local, so reloading mid-login abandons them, and sign-out forgets locally without telling the issuer — both recorded in the package READMEs rather than fixed here.

## Testing

- `authorization-remote.host.spec.ts` drives scripted flows through the namespace: listing, stored-state reads, sign-out, a notice plus code prompt to `authorized`, select prompts, declines and withdrawals to `cancelled`, flow failures to `failed` with the diagnostic, prompt withdrawal mid-attempt, late answers, malformed ids and cursors, and retention eviction past fifty attempts.
- The companion specs drive the card over a stubbed Remote face: no-flow and key-only routes render nothing, refused reads retry, a code prompt reaches a signed-in card, secret and select prompts, failed and cancelled outcomes, refused polls and answers, withdrawal, and sign-out.
- `pnpm run test:gui` covers the client suites; the Host suite runs under the root test lane.
