# Agent Note: pi-ai adapter sends per-conversation x-opencode-session to the OpenCode gateway

Status: implemented

English | [中文](2026-09-09-pi-ai-opencode-session-header.zh.md)

## Problem

The OpenCode Go gateway requires `x-opencode-session` on every inference request and answers `400 MissingSessionID` without it. The pi-ai adapter forwarded `GenerateOptions.sessionId` only into pi-ai's `streamSimple()` options, whose session-affinity headers (`session_id`, `x-client-request-id`, `x-session-affinity`) never include `x-opencode-session`; the compat switches that enable them are withheld from profiles by the catalog drift gates. Every model served through the gateway therefore failed, including the highest-volume routes. A static `headers` entry is no repair: one fixed value for all conversations collapses the gateway's per-conversation routing affinity and degrades prefix-cache locality.

## Decision

`PiAiAdapter` stamps `x-opencode-session` with the loop-stamped conversation id verbatim on every request to the gateway, and sends nothing elsewhere. A request targets the gateway when its route key starts with `opencode` or its resolved model endpoint is hosted on `opencode.ai` (apex or subdomain); either fact alone selects the gateway, so a renamed route to the gateway and a gateway-named route to a proxy both keep the header. The per-conversation value wins over a same-named static profile entry (case-insensitive), because a fixed value cannot do a per-conversation id's job; Harness attribution names keep their existing precedence. Requests without a session id send no session header, and discovery probes are untouched.

This follows the established [mandatory attribution](../architecture/2026-06-21-mandatory-app-attribution-headers.md) pattern — Harness-owned names win over deployment headers — and the [DeepSeek request identity](../feature/2026-08-11-deepseek-request-user-id-header.md) precedent of sending the conversation id as provider-recognized transport metadata. The [provider-routed adapter](../architecture/2026-07-14-provider-routed-llm-adapters.md) header-merge sentence now names the gateway session header beside attribution.

## Alternatives considered

**A `sessionHeader` profile field (explicit opt-in per route).** Rejected as the default repair: it fixes nothing until every affected deployment edits its settings, so gateway breakage persists for deployments that never read the request thread. Explicit per-route headers remain available for gateways the adapter does not recognize.

**A static `headers` entry with a fixed value.** Rejected: one id across conversations points every conversation at the same affinity bucket and degrades cache locality, which operators observed as higher cost.

**Minting a fresh UUID per request when no session id exists.** Rejected: a per-request id satisfies the header-present check but carries no conversation affinity, which is the routing fact the gateway asks for. Calls without a session keep their current behavior.

**Extracting the bare UUID from the `session-<uuid>` conversation id.** Rejected: the gateway accepts the conversation id verbatim, so the transformation adds an unproven format dependency.

## Consequences

- Gateway requests carry one stable id per conversation across turns, resume, compaction, and retries; new conversations, forks, and subagent sessions present fresh ids.
- Providers other than the gateway receive no new header; no session id leaks to endpoints that did not ask for one.
- A static same-named profile entry has no effect on gateway routes; deployments still carrying one can remove it.
- Gateway recognition stays a route-key prefix plus an endpoint-host check in the adapter. A gateway that moves hosts or renames its contract needs an adapter change; a profile field would have needed a settings change instead.

## Testing

- Wire specs pin the header value verbatim on `opencode`-prefixed routes, its absence without a session id, no header on other providers, and the runtime value winning over a static entry.
- A route-matching table pins the prefix, apex, subdomain, case-insensitivity, non-match, and unparsable-endpoint cases.
- The full `dsh-llm-pi-ai` suite is green with per-file 100% coverage on the touched sources; package typecheck and oxlint are clean.
