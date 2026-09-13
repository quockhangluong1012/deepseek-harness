# Remove tracked `src/**/*.js` build residue

- Date: 2026-09-13
- Batch: 1 of full-sweep fixes (`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`)

## Why

145 JavaScript files were committed under `packages/*/src/` beside their
TypeScript originals (source plane mixed with artifact plane). Every one was
a byte-level build mirror: all 145 have a same-named `.ts` sibling, and no
`src/*.ts` file imports a relative `.js` specifier (the only `.js` imports in
the repo point at `lib/` output or live inside the residue itself). Deletion
therefore changes no runtime behavior; compilers keep emitting to `lib/`.

## What was given up

Nothing. Eight tracked `.js` files outside `src/` were deliberately kept:
`experimental/webworker-packer/bin.js` (a declared `bin` entry) and seven
plain-JS Cordis plugins under `tests/fixtures/plugins/` (test data, not
residue). A broad `git ls-files` pattern catches 153 files; the deletion used
the `*/src/`-filtered list of exactly 145.

## Verification

- `verify-no-src-js` (new gate): exit 0 on the clean tree; a force-staged
  probe file is flagged and the gate exits 1 (the `.gitignore` rule alone
  cannot stop tracked files, which is why the gate reads `git ls-files`).
- `pnpm run duplication`: no remaining clone pair references a deleted path.
- `vitest` on `llm/llm`, `attachment/attachment`, `shell/shell`: green on
  rerun (an initial 59-file parallel run showed 6 timeout-class failures in
  `llm-pi-ai`, a package untouched by this change; the 5 suites pass 153/153
  as a group — flakiness under load, not a regression).
- Full `pnpm run typecheck` (host `tsc -b` + `tsdown` + client `tsc -b`):
  green.
