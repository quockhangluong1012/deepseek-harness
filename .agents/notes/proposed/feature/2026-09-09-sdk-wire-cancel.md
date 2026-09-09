# Agent Note: Wire-level cancel for SDK JSON-RPC requests

Status: proposed

English | [中文](2026-09-09-sdk-wire-cancel.zh.md)

## Problem

An SDK client timeout is abandonment only: the transport drops the pending entry while the server keeps running the request until the runtime is closed. A caller that times out a long turn has no way to reclaim server work without tearing down the whole runtime, and a timed-out prompt's late result still mutates session state the caller already gave up on.

## Proposal

Add a protocol-level cancel: the client sends a `session/cancel`-style notification carrying the abandoned request id when a per-call timeout fires, and the server maps it onto the running turn's abort signal. Timeouts keep their current abandonment semantics until both sides negotiate the new method, so mixed-version pairs degrade to today's behavior. The server's abort path already exists for `close`; the new work is request-id routing plus a capability advertisement during `initialize`.

## Alternatives considered

**Keep abandonment and document `close` as the reclaim path.** Loses because tearing down the runtime to stop one turn destroys every session multiplexed over it; the cost grows with session count.

**Cancel by closing and reopening the transport.** Loses because reconnect recovers no durable subscription cursors and replays session state; a targeted cancel is cheaper than full re-establishment.

**Server-side deadline propagation without a cancel method.** Loses because only the client knows its timeout; the server cannot infer abandonment from silence on a multiplexed stream.

## Acceptance criteria

A timed-out `session/prompt` stops its server-side turn without closing the runtime, a late result never commits after its caller abandoned it, mixed-version client/server pairs behave exactly as today, and the protocol catalog carries the new method with a version gate.

## Risks

A cancel racing result settlement needs first-wins settlement on the server or a late result could half-commit; capability negotiation adds a version-skew matrix to the existing compatibility tests.
