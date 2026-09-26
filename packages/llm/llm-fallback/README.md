---
description: "Provider route fallback on the agent loop's request recovery extension point (ctx fallback recovery), for hosts surviving provider outages without operator intervention."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-fallback

English | [中文](README.zh.md)

## Summary

`dsh-llm-fallback` switches the next model-request attempt to the next healthy configured route when downstream recovery declines a failure, and records the durable `llm/fallback` event first. A per-route breaker rests repeatedly failing routes until their cooldown elapses, and an optional deployment-owned key rotation hook runs before the switch. The switch rides the `agent/request` replacement contract the loop re-emits per attempt, so the loop itself is unchanged. Choose it when one provider's outage should not end the turn.

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

Mount the plugin with recovery routes in rotation order. On a declined failure whose code is eligible the plugin records the failure against its route, skips open breakers and the just-failed provider, runs key rotation when installed, appends `llm/fallback`, stashes the route for the step's next attempt, and answers `{ kind: 'retry' }`. Eligibility defaults to the transient codes the bounded retry policy retries (`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`); a request, credential, or context fault stays terminal on its own route. A downstream retry decision is always preserved, never superseded. Aborts and empty route lists decline without switching.

### Configuration

Recovery routes, breaker, and eligible codes are validated `Config` members changeable from `cordis.yml`. An empty route list is the valid off state. Key rotation is not configuration: provide `ctx.llmFallbackKeyRotation` before the tree mounts when rotated keys must precede the switched attempt.

```yaml
- name: '@deepseek-ai/dsh-llm-fallback'
  config:
    fallbackRoutes:
      - provider: 'other'
        model: 'other-model'
```

| Field | Default | Meaning |
|---|---|---|
| `fallbackRoutes` | `[]` | Recovery routes in rotation order; empty disables fallback |
| `breaker.failureThreshold` | `3` | Observed failures that open one route |
| `breaker.coolMs` | `60000` | Milliseconds an open route stays out of rotation |
| `eligibleCodes` | transient codes | Failure codes eligible for fallback; omission admits the transient set (`DEFAULT_RETRYABLE_CODES`: `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`) |

Mount the fallback row beside `llm-retry`. The shipped web-app row composes after it (the base insert carries the retry row), and the plugin delegates downstream first, so row order changes no v1 outcome; the canonical order — fallback outside the retry policy — is what keeps a future supersede decision possible. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-fallback) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Two request listeners, one stash, one durable event. The `agent/request-error` wrapper always delegates downstream first, so `llm-retry` and compaction keep their decisions; only declines of an eligible code reach fallback evaluation. The `agent/request` override serves the stashed route for the failed step's next attempt and passes every other request through untouched, mirroring the model-selection replacement pattern. Inherited reasoning effort is stripped on the switch because a different adapter may reject the previous route's effort knobs; adapter defaults fill the rest per attempt. Breaker state is process-local and keyed by provider; each step's close drops its stash, and the committed assistant message that proves a route served the step clears that route's failures.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, listeners, stash, breaker, and key rotation wiring |
| [`src/types.ts`](src/types.ts) | Durable `llm/fallback` event payload and session event declaration |
| [`src/brand.ts`](src/brand.ts) | Opaque fallback-chain identity |

### Failure and recovery

A switched route persists for later turns through the loop's persisted request header until another switch or selection change; fallback never switches back on its own. A throwing downstream listener rejects the waterfall instead of masking behind a switch. A throwing rotation hook warns and the switch proceeds, so rotation never blocks recovery. Disposal removes all listeners, clears the stash, and drains in-flight recovery; a stale captured callback resolves without recovering.

No invariant companion is published: the `llm/fallback` event validation (open turn/step, provider match, monotonic attempt, chain identity) arrives with the ordering and budget matrix.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md) — the behaviour contract this package implements.
- [LLM package map](../README.md) — the group's packages and their repository position.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-fallback) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the serving adapters: the plugin selects the route on recovery, while request assembly and adapters own the model-visible request.

#### KV Cache effect

Route switches change the request prefix, so provider cache reuse restarts on the switched attempt; non-switching turns are unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the fallback is a poor fit. They are current package constraints.

- **No automatic return** — a switched route persists across turns; nothing switches back when the primary recovers.
- **Always-mode retry starves fallback** — under an unbounded retry policy the loop never declines, so fallback never engages; use bounded normal policies where fallback should act.
- **Shared attempt budget** — each switched attempt costs one shared `maxRequestRetries` step; deep route lists need a matching ceiling.
- **Process-local breaker** — breaker state resets on restart and coordinates no agents; cross-session breakers arrive separately.
- **No invariant companion yet** — event validation and the ordering/budget matrix arrive separately.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
