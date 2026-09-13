# Agent Note: Evolution slash-menu picks claim input

Status: implemented

English | [中文](2026-09-13-evolution-slash-menu-claims-input.zh.md)

## Problem

Picking `/memory`, `/skills`, `/curator`, or `/trajectory` in the slash menu cleared the draft and executed the bare command in the background, leaving the composer empty. The host descriptors declared no `input`, so the client's decision table (`packages/client/ui-commands/src/client/service.ts`) took the host-bare branch: consume the trigger span, then detached-execute. These are governance commands whose real work needs arguments (`approve <id>`), so the menu could never compose them — and Space after `/memory` claimed nothing either, forcing fully manual lines where one wrong word earns a usage error.

Separately, `/skills` usage advertised `diff <id>` while the handler hard-errored every diff: the staged payload has no declared shape until background proposals land.

## Decision

The four argument-taking evolution commands declare `input` hints in `packages/evolution/command-evolution/src/index.ts`: `memory` advertises `pending | approve <id> | reject <id>`, `skills` advertises `pending | approve <id>`, `curator` advertises `status | run | adopt <name> | purge | rollback | ledger | pin <name>`, and `trajectory` advertises `[--out <path>] [--all]`. Menu picks now take the existing claim path (`/memory ` stays in the draft), reusing the tested `slash/input-begin-command` pipeline — no client change. `journey`, `refine`, and `suggestions` keep no `input`: `journey` has a useful bare default and the other two take no arguments.

`SKILLS_USAGE` drops `diff <id>` and the dead `diff` branch is deleted, so `/skills diff <id>` reports usage instead of promising an unimplemented feature. The package README pair documents the current grammar.

## Alternatives considered

**Claim every menu pick client-side instead.** Would fix this instance without touching host descriptors — but it rewrites the documented decision table (bare host commands execute on pick) and would also change commands whose immediate execution is correct. Lost: a local exception against a tested contract.

**Implement a real skill diff.** Needs a declared staged-payload shape that does not exist yet; background proposals have not landed. Lost: speculative surface promising what the store cannot render.

## Consequences

Bare Enter on these four commands now claims `/name ` into the draft instead of executing (a second Enter executes) — the same behavior `/plan` already has. They also leave inline (mid-text) menus via the existing `hint === undefined` filter; the leading menu is unaffected. Attachments stay refused loudly, unchanged: no handler ever accepted them. Gained: the approve/reject flow is composable from the menu, and usage text no longer advertises a dead verb.

## Testing

`packages/evolution/command-evolution` specs pin the four `input` hints through descriptor `toContainEqual` assertions, assert the new skills usage text (including `/skills diff abc` → usage), and cover the pending/approve/reject paths: 85/85 pass. Scoped `tsc --noEmit` on the package is clean. Full `lint` and the CI lanes are deferred to CI.
