# Agent Note: Remove tracked `src/**/*.js` build residue

Status: implemented

English | [中文](2026-09-13-remove-src-js-residue.zh.md)

## Problem

Batch 1 of the full-sweep fixes (`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`) found 145 JavaScript files committed under `packages/*/src/` beside their TypeScript originals, mixing the source plane with the artifact plane. Every one was a byte-level build mirror: all 145 have a same-named `.ts` sibling, and no `src/*.ts` file imports a relative `.js` specifier (the only `.js` imports in the repo point at `lib/` output or live inside the residue itself).

## Decision

The 145 residue files are deleted. Compilers keep emitting to `lib/`, so the deletion changes no runtime behavior.

Eight tracked `.js` files outside `src/` are deliberately kept: `experimental/webworker-packer/bin.js` (a declared `bin` entry) and seven plain-JS Cordis plugins under `tests/fixtures/plugins/` (test data, not residue). A broad `git ls-files` pattern catches 153 files; the deletion used the `*/src/`-filtered list of exactly 145.

## Alternatives considered

- **A broad `git ls-files` deletion of every tracked `.js` file (153 paths):** rejected because eight of those paths are not residue — the declared `bin` entry and seven Cordis test-fixture plugins — so the deletion was narrowed to the `*/src/`-filtered list of exactly 145.
- **Relying on the `.gitignore` rule alone:** rejected because a `.gitignore` rule cannot stop tracked files; the new gate therefore reads `git ls-files`.

## Consequences

Nothing was given up: `lib/` remains the artifact plane, the `.js` files outside `src/` keep working, and no runtime behavior changed.

## Verification

- `verify-no-src-js` (new gate): exit 0 on the clean tree; a force-staged probe file is flagged and the gate exits 1 (the `.gitignore` rule alone cannot stop tracked files, which is why the gate reads `git ls-files`).
- `pnpm run duplication`: no remaining clone pair references a deleted path.
- `vitest` on `llm/llm`, `attachment/attachment`, `shell/shell`: green on rerun. An initial 59-file parallel run showed 6 timeout-class failures in `llm-pi-ai`, a package untouched by this change; the 5 suites pass 153/153 as a group — flakiness under load, not a regression.
- Full `pnpm run typecheck` (host `tsc -b` + `tsdown` + client `tsc -b`): green.
