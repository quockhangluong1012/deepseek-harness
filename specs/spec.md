# Harness Audit — DeepSeek Harness (all-plugin Cordis agent stack)

**Audit date:** 2026-09-09 · **Commit audited:** `dcd9a82` · **Branch:** `main`

## Context

`deepseek-harness` is an all-plugin Cordis agent harness: **255 workspace packages**, ~1,600 `src`
TypeScript files, **998 unit specs**, **197 repo scripts**, **142 npm scripts**, **2,918 Markdown
files**, **1,317** bilingual pairing records, **17** subtree `AGENTS.md`, and **665**
current-authority Agent Notes (717k words).

Its *specification* discipline is genuinely excellent — capability seams with three named roles,
eleven generated-and-verified catalogs, a 33-leaf doc-sync gate set, per-file 100% coverage
thresholds, a 1,572-line gate orchestrator, keyless recorded-session replay, and a
defensive-patterns doc grounded in real incidents.

This audit asked whether that discipline is **enforced today**. It is not. Three enforcement layers
were designed to hold the system together; all three are currently non-functional:

| Layer | Designed | Actual |
|---|---|---|
| **CI gates** | 11 `ci-*` lanes over ~60 leaf gates | `workflow.rules: - when: never` — no pipeline on any branch or MR |
| **Docs & notes kept current** | mandatory note per change, gated links/catalogs/pairing | 46 broken links; 23 notes describe deleted CI; 2 doc gates red; 1 gate structurally vacuous |
| **Runtime approval + sandbox** | `ask`/`deny` policy + per-platform confinement | no shipped bundle can emit `ask`; 40+ tools have no timeout |

Everything below is downstream of that. **Mid-audit, commit `dcd9a82` ("feat: Implement structured
delegation and telemetry scrubbing") landed directly on `main`** — 56 files, 999 insertions, one
test file, zero snapshots, with doc gates red before *and* after. That commit is the audit's best
single case study and is referenced throughout.

**Every finding below was verified by running the repository's own gates on this checkout or by
reading the named source.** Line references are to `HEAD = dcd9a82`.

---

## Prioritized issues

### P0 — the harness cannot currently detect its own regressions

| # | Issue | Area | Kind |
|---|---|---|---|
| 1 | No CI runs on any branch or MR; all 11 `ci-*` lanes orphaned | `.gitlab-ci.yml:1-4` | **Bug** |
| 2 | `pnpm run test` is red at `HEAD` — 15 failures, ENOENT on deleted workflows | `scripts/ci-workflow.spec.ts:837` | **Bug** |
| 3 | `AGENTS.md` tells agents *not* to verify locally because "CI owns" it | `AGENTS.md:94-95` | **Design weakness** |
| 4 | No shipped bundle can produce an approval prompt — the permission seam never fires | `packages/hooks/hooks-claude-code/src/index.ts:242` | **Design weakness** |

### P1 — safety, correctness, and prompt integrity

| # | Issue | Area | Kind |
|---|---|---|---|
| 5 | 40+ tools — every mutating one — escape the tool-timeout guard | `packages/guard/timeout-policy/src/index.ts:56-60` | **Design weakness** |
| 6 | Tool-arg schemas omit `additionalProperties: false`; undeclared model keys always pass | `packages/core/tools/src/schema.ts:449-458` | **Bug** |
| 7 | `mcp__*` tools bypass schema validation; invalid args silently become `{}` | `packages/mcp/mcp-client/src/tools.ts:312-321` | **Bug** |
| 8 | Tool-catalog completeness guard globs only `packages/*/tool-*`; `mcp__*` and `structured_output` undocumented; one deployment note factually false | `scripts/gen-tool-catalog.ts:621,260` | **Bug** |
| 9 | `CLAUDE.md` files are 9-byte text files, not symlinks → a junk instruction file reaches the model every session | `AGENTS.md:150`, `packages/context/agent-instructions/src/files.ts:368` | **Bug** |
| 10 | Writable-root derivation has four disagreeing implementations; Windows fs-fence grants all of `os.tmpdir()` | `packages/sandbox/sandbox/src/roots.ts:52-55` | **Bug** |
| 11 | No network confinement on any platform | `packages/sandbox/sandbox-local/src/profiles.ts:16-58` | **Future risk** |
| 12 | 28.8% of `src` files (459/1602) excluded from the "per-file 100%" coverage gate | `vitest.config.ts:209-352` | **Design weakness** |
| 13 | Coverage thresholds silently disabled under `DSH_COVERAGE_PARTITION_MODE=1` | `vitest.config.ts:357-365` | **Bug** |
| 14 | `dcd9a82`: 24 source files changed, 1 test added, 0 snapshots — against `AGENTS.md:127,130` | commit `dcd9a82` | **Bug** |
| 15 | Pre-commit translation gate is keyed on the file that *doesn't* change | `lefthook.yml:8` | **Bug** |
| 16 | `tools:sdk` is ~85% of a 37 KB system prompt; ~9-13.5k tokens per request before any content | `packages/core/tools/src/index.ts:868` | **Design weakness** |

### P2 — drift, staleness, and instruction quality

| # | Issue | Area | Kind |
|---|---|---|---|
| 17 | 23 current-authority Agent Notes + `docs/development.md` + `.github/AGENTS.md` document a deleted CI system | `.agents/notes/implemented/process/2026-07-21-serial-cross-platform-ci-reference.md` et al. | **Bug** |
| 18 | `verify-md-links` red: 46 broken links | `scripts/verify-md-links.ts` | **Bug** |
| 19 | 665 unindexed current-authority notes carry a per-change freshness duty; archive rate collapsed 47%→10% | `.agents/notes/README.md:13,19,38` | **Design weakness** |
| 20 | Word-budget rules are stated but unenforced, phantom, and violated 5-9 ways | `docs/AGENTS.md:57`, `scripts/verify-doc-budgets.ts:27` | **Design weakness** |
| 21 | No conflict-resolution precedence is stated between root and subtree `AGENTS.md` | `docs/AGENTS.md:21-22` | **Design weakness** |
| 22 | `AGENTS.md` "Repository layout" omits 17 of 50 package groups and names 2 that don't exist — while also delegating the same fact | `AGENTS.md:16-59` | **Bug** |
| 23 | `AGENTS.md` `## Commands` omits `check:all` and the entire `check:ci*` family (18 of 142 scripts documented) | `AGENTS.md:63-83` | **Design weakness** |
| 24 | `verify-skill-invocation-metadata` is structurally vacuous — passes unconditionally in any clean clone | `scripts/verify-skill-invocation-metadata.ts:31-38` | **Bug** |
| 25 | `defensive-patterns.md` covers 8 classes; the 5 largest recurring classes have no pattern | `docs/defensive-patterns.md` | **Design weakness** |
| 26 | 9 `AGENTS.md` rules have no executing gate — incl. "no hardcoded tunables", violated by `dcd9a82` itself | `AGENTS.md:110,115,121,123,128-130` | **Design weakness** |
| 27 | `dcd9a82` bundles ~15 unrelated fixes across 12 package groups into one note | commit `dcd9a82` | **Design weakness** |
| 28 | Fixes applied to `bash` not propagated to `pwsh` (the Windows shell), `terminal`, `subagent`, `tool-fs` | `packages/shell/tool-pwsh/src/index.ts:354,392` | **Bug** |
| 29 | Telemetry secret-scrubbing ships with no consumer; tool args logged unscrubbed | `packages/session/session-telemetry/src/sensitive.ts` | **Design weakness** |

### P3 — speed, coverage holes, overfitting

| # | Issue | Area | Kind |
|---|---|---|---|
| 30 | `test:docs` "quick" lane costs 83s; `verify-md-links` alone 73s | `scripts/verify-md-links.ts` | **Future risk** |
| 31 | `pytest` suite (6 files) and `native/landlock-run` tests are run by nothing | `pytest.ini` | **Bug** |
| 32 | Snapshot normalizers hardcode user-visible prose; wording changes silently break scrubbing | `packages/test-support/session-snapshot/src/normalize.ts:42-58` | **Future risk** |
| 33 | `path-boundary.ts` has no blocking coverage gate on any platform | `vitest.config.ts:82` | **Design weakness** |
| 34 | No per-turn step or token ceiling in the agent loop | `packages/core/agent-loop/src/agent.ts` | **Future risk** |
| 35 | `test:snapshot:record` needs an API key, yet `AGENTS.md:127` makes snapshots mandatory | `AGENTS.md:71,127` | **Design weakness** |
| 36 | Unknown `{{var}}` in a prompt section throws at first-turn assembly; no escape syntax | `packages/core/system-prompt/src/index.ts:322-340` | **Future risk** |
| 37 | No aggregate byte budget across instruction sources (`TODO` in source) | `packages/context/agent-instructions/src/files.ts:333-335` | **Future risk** |
| 38 | Release-blocking `FIXME` with no gate | `packages/guard/timeout-policy/src/index.ts:6-9` | **Future risk** |

---

## P0 detail

### 1. There is no CI. — Critical / Bug

**Area:** `.gitlab-ci.yml:1-8`; absent `.github/workflows/`; `scripts/run-gates.ts:24-40`

```yaml
workflow:
  rules:
    - if: '$CI_COMMIT_TAG =~ /^python-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/'
    - when: never
```

`- when: never` means **no pipeline is created for any branch push, merge request, or
default-branch push.** The only reachable pipeline fires on a `python-v*` tag, has stages
`build`/`publish`, and does nothing but build and publish six Python wheels; its entire repo-gate
signal is `pnpm run verify-runtime-closure`. No `cache:` block anywhere, so every job re-installs
cold.

`.github/workflows/` does not exist and never did in this history
(`git log --all --diff-filter=A -- '.github/workflows/*'` → empty). `scripts/ci-workflow.spec.ts`
asserts the contents of **twelve** absent workflow files.

Consequently `scripts/run-gates.ts` — 1,572 lines orchestrating `ci-primary`, `ci-linux-primary`,
`ci-static`, `ci-lint-contracts-ready`, `ci-coverage`, `ci-snapshot`, `ci-artifacts`,
`ci-consumers`, `ci-windows-blocking`, `ci-windows-complete`, `ci-windows-observational`,
`node-compat` — **has no caller.** `ci-primary` alone composes 12 static gates, typecheck, lint,
duplication, both coverage gates, 4 node-compat smokes, the snapshot lane, all **33** doc-sync
leaves, module graph, build, publint, node-next types, built-package invariants, and a 12-file
built-bin smoke. All unreachable.

Surviving enforcement is `lefthook.yml` only: pre-commit (staged lint --fix, staged whitespace,
staged-record translation pairing, archived-note guard, third-party-notices regen, vendor manifest)
and pre-push (`pnpm run typecheck`).

**Failure mode.** Every invariant encoded as a gate rather than a type is unenforced: coverage
thresholds, snapshot parity, catalog sync, package invariants, the 5-platform matrix, SDK projection
parity, doc links, i18n pairing, JSDoc completeness. Regressions land silently — `dcd9a82` is proof.

**Durable fix.** The orchestrator is intact and needs a caller, not a rewrite:

```yaml
workflow:
  rules:
    - if: '$CI_COMMIT_TAG =~ /^python-v.../'          # keep the existing release lane
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
stages: [static, test, artifacts, build, publish]
```

Jobs shell straight to the existing scripts — `check:ci:static`, `check:ci:lint:contracts-ready`,
`check:ci:coverage`, `check:ci:snapshot`, `check:ci:artifacts`, `check:ci:consumers`,
`check:node-compat`, `check:ci:windows-blocking` on the `windows-x64` tag. Runners for `linux-x64`,
`linux-arm64`, `macos-arm64`, `macos-x64`, `windows-x64` already exist — the wheel jobs use them.
Add a pnpm-store `cache:` keyed on `pnpm-lock.yaml`.

Do **not** try to restore the GitHub Actions topology: the twelve deleted workflows encoded
self-hosted pools, Wine-hosted Windows, and an `all checks passed` aggregate that GitLab models
differently. Rebuild on `run-gates.ts` lanes — the platform-independent inventory.

**Proof.** Open a throwaway MR deleting one line of a covered function → the pipeline must fail
`ci-coverage`. Then make the *claim* testable: `scripts/verify-ci-lane-coverage.ts` asserting every
`Mode` union member in `run-gates.ts:24-40` is invoked by some `.gitlab-ci.yml` job and that
`workflow.rules` admits `merge_request_event`. Wire into `ci-static` and `hygiene`.

### 2. `pnpm run test` is red at `HEAD`. — Critical / Bug

**Area:** `scripts/ci-workflow.spec.ts:837`; collected via `vitest.config.ts:121-125`
(`scripts/**/*.spec.ts`)

```
Test Files  1 failed (1)
     Tests  15 failed | 7 passed (22)
Error: ENOENT: no such file or directory, open
  '…\.github\workflows\docs-pages.yml'
 ❯ loadWorkflow scripts/ci-workflow.spec.ts:837:39
```

The spec is in `testIncludes` and in neither `platformUnsupportedTests` nor
`coverageExemptExcludes`, so it runs in the default `thread-safe` project — and therefore in
`test:coverage`, the nominal CI gate. **Neither `pnpm test` nor `pnpm test:coverage` can pass on
this checkout.**

**Failure mode.** Worse than one broken test: it destroys the signal an agent depends on. A harness
whose baseline test command fails cannot tell an agent whether *its own* change regressed anything.
The agent either learns to discount red output — which then hides a real regression — or burns turns
investigating a failure it did not cause. For an autonomous loop this is the most corrosive possible
state, and it compounds finding 3 exactly.

**Durable fix.** Rewrite the spec against `.gitlab-ci.yml` as part of finding 1 — its pinned
contracts (runner-private pnpm `dest`, blocking-job inventory, trigger scoping) are worth keeping,
retargeted — or delete it. Then prevent the class: route every repo-file read in a spec through a
helper that fails at *collection* with the missing path named, not mid-assertion.

**Proof.** `pnpm run test` exits 0 on a clean tree, and `ci-primary` includes it, so a red baseline
can never merge again.

### 3. The instructions delegate to a backstop that does not exist. — Critical / Design weakness

**Area:** `AGENTS.md:93-95`; `.agents/skills/dsh-pre-push-checks/SKILL.md:8,29,68`

> "Never default to the full suite or repeat a passing check for commit or push. **CI owns
> exhaustive coverage and the platform matrix**; rehearse all locally only by explicit request, for
> CI diagnosis, or for an irreducibly repository-wide change." — `AGENTS.md:94`

> "`test:coverage`, not `test`, is the CI coverage gate" — `AGENTS.md:95`

The skill reinforces it: *"Git hooks are intentionally narrow… CI owns exhaustive coverage and the
platform matrix"*, and *"Run the complete local approximation only when the user explicitly requests
it."* It also says *"do not recreate the removed `check:pre-push` aggregate"* — so the one
consolidated local safety net was deliberately retired *in favour of* the CI that no longer exists.

This is well-reasoned policy **conditional on CI existing**. With CI gone it actively suppresses the
only remaining verification path. An agent following the harness's own rules *correctly* validates a
56-file change with one focused spec and pushes — which is exactly what `dcd9a82` looks like.

**Failure mode.** Instruction/reality inversion: the more obedient the agent, the less verified the
change. This is the highest-leverage finding in the audit, because it converts finding 1 from
"missing automation" into "actively misleading guidance".

**Durable fix.** Restore CI (finding 1) so the prose becomes true again — that is the right fix, not
rewriting the rule. Until it lands, add one sentence to `AGENTS.md:94` and the skill naming the
current fallback. Then make the coupling mechanical via `verify-ci-lane-coverage` so the claim can
never silently become false again.

### 4. No shipped bundle can produce an approval prompt. — Critical / Design weakness

**Area:** `packages/hooks/hooks-claude-code/src/index.ts:242`; `packages/bundle/*/cordis.patch.yml`

Independently verified. The **only** producer of `{kind: 'ask'}` in the source tree is:

```ts
// packages/hooks/hooks-claude-code/src/index.ts:242
if (merged.decision === 'ask') return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
```

`grep -rn 'hooks' packages/bundle/*/cordis*.yml` → **no matches** in any of the six bundle patches
(`base`, `web-app`, `headless`, `sdk-app`, `sdk-minimal`, `acp-app`). `hooks-codex` denies only
(*"Codex blocks only (no allow/ask honored)"*, `src/index.ts:224`). The packages appear solely as an
`apps/cli/package.json` dependency — installable, never mounted. The only other `tools/pre-execute`
listener is a non-gating output-limit recorder (`packages/jobs/tool-jobs/src/index.ts:232-236`).

So in every shipped profile, `ctx.approval.request(...)` at `packages/core/tools/src/index.ts:1697`
is unreachable from the tool pipeline. `bash`, `pwsh`, both persistent shells, `write`, `edit`,
`str_replace_editor`, all six `terminal_*`, `subagent`, `workflow`, `ralph`, `todo_write`,
`job_kill`, `skill`, `schedule_*`, and every `mcp__*` execute with **no human approval prompt**. The
`ApprovalService`, `permission-presets`, the `/permission` command, the persisted `approval/policy`
event, the `approval/asked`+`approval/decided` audit pair, and the ACP approval bridge are all
wired and all dead code in practice.

`packages/shell/tool-bash/src/index.ts:6-7` already knows:
`TODO(permissions): deployment policy belongs in 'tools/pre-execute' and sandboxing executors`.

The design around the hole is good: `serviceAsk` fails closed on a missing service, a missing agent,
and on `rejected`/`cancelled`/`unavailable`; `'never'` is decided inside the service before any
listener so a `prepend: true` listener cannot front-run it; there is deliberately **no**
`allow-always` grant (`packages/acp/acp/src/index.ts:151-153`: *"never infers a durable grant from an
unknown client response"*). What actually remains as human-in-the-loop: the sandbox mode fence
(findings 10-11), the model's *voluntary* `sandbox_permissions` escalation after a denial — which
does route through approval (`packages/sandbox/sandbox/src/escalation.ts:12,157-189`) — and the
separate `ctx.userQuestions` seam for `ask_user_question` / `exit_plan_mode`.

**Failure mode.** The documented permission model (`docs/subsystems/permission-presets.md`, the
`read-only`/`workspace-write`/`danger-full-access` × `ask`/`never` table at
`packages/bundle/base/cordis.patch.yml:235-247`, and the model-facing `ASK_SENTENCE` at
`user-approval/src/index.ts:68`) describes behaviour the shipped product does not have. The `ask`
policy is configurable, selectable via `/permission`, persisted to the session log, narrated to the
model — and has no effect. Anyone reading it, human or agent, will over-trust the harness.

**Durable fix.** Move the policy decision out of the optional hook bridge into a first-class shipped
plugin: a `tools/pre-execute` listener mapping `(tool, sandboxMode, approvalPolicy)` →
`allow | ask | deny` from validated Config, mounted in `bundle/base`. The decision types, service,
presets, audit events, and UI all exist — only the producer is missing. Then add a runtime invariant
(the repo's own pattern, `AGENTS.md:106`) asserting that under `approvalPolicy === 'ask'` at least
one registered mutating tool resolves to `ask`.

**Proof.** A test in `bundle/base` booting the shipped tree, calling `bash` under `read-only` +
`ask`, asserting an `approval/asked` + `approval/decided` pair in the session log. Today that test
cannot pass.

---

## P1 detail — tools, permissions, sandbox

### 5. 40+ tools escape the timeout guard. — High / Design weakness

`packages/guard/timeout-policy/src/index.ts:56-60`:

```ts
const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs
if (timeoutMs === undefined) return next()          // no budget = no deadline
```

The guard has **no default of its own** — it enforces only what a `ToolDefinition` declares
(`packages/core/tools/src/index.ts:240-247`: *"Omit for no deadline"*). Only **7 tools** declare
one: `glob`/`grep` (30s), `lsp` (60s), `web_search`/`web_fetch` (30s),
`session_search`/`session_event_search` (30s).

Escaping it: `bash`, `pwsh`, both persistent shells, `read`, `read_image`, `write`, `edit`,
`str_replace_editor`, all six `terminal_*`, all three `job_*`, all three `*_goal`, `todo_write`,
`skill`, `subagent`, `list_subagent_models`, `send_message`, `interrupt_agent`, `list_agents`,
`workflow`, `ralph`, all seven `cordis_*`, `schedule_*`, `exit_plan_mode`, `ask_user_question`,
`run_code`, `structured_output`, every `mcp__*`. Note `session_trace`/`session_event_trace`/
`session_event_read` lack one while their two siblings *in the same file* have it — a 3-of-5 split.

They rely on backend deadlines instead — a parallel mechanism with an unexplained asymmetry:
`bash-sandbox` is configured to 60s (`cordis.patch.yml:220-224`) while `pwsh-sandbox` gets no config
and keeps `pwsh-local`'s 120s default (`packages/shell/pwsh-local/src/index.ts:133`) — and pwsh is
the shell that ships on Windows. `run_in_background: true` has **no timeout at all**
(`bash-local/src/index.ts:257`). `mcp__*` expiry surfaces as an MCP-SDK error rather than the
structured `TOOL_TIMEOUT` a retry/observer plugin routes on. Nothing bounds `run_code`.

**Fix.** Add a validated `defaultTimeoutMs` Config field so absence is bounded rather than
unbounded; keep per-tool declarations as overrides; gate that every registered tool resolves to a
finite deadline. **Proof:** register a tool with no `timeoutMs`, assert `TOOL_TIMEOUT` at the
default.

### 6-8. Tool-argument validation has three holes. — High / Bug

**6 — the parameter root is open.** `packages/core/tools/src/schema.ts:449-458` emits
`{ type: 'object', properties, required? }` with **no `additionalProperties: false`**, so undeclared
model keys always pass. Only `tool-bash` and `tool-pwsh` re-enforce by hand, with an identical
comment: *"Undeclared keys are allowed, so schema omission also needs enforcement"*
(`tool-bash/src/index.ts:352`). Every other tool silently accepts arbitrary extra keys.
**Fix:** emit `additionalProperties: false` from the DSL compiler and delete the hand-checks.

**7 — `mcp__*` tools are unvalidated.** `packages/mcp/mcp-client/src/tools.ts:257-272` does not use
`defineTool`; `parameters` is the server's raw `inputSchema` verbatim, and the executor never
validates:

```ts
// packages/mcp/mcp-client/src/tools.ts:312-321
const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
```

Non-object args become `{}` **silently**, and `packages/core/agent-loop/src/tool-calls.ts:107-113`
turns unparseable JSON into the raw string. So a malformed MCP call reaches a third-party server as
an empty object with no error to the model. `structured_output` shows the correct pattern — it
hand-calls `validateJsonSchemaValue` and throws `ToolArgsError`
(`subagent-in-process-driver/src/structured.ts:88`). **Fix:** do the same for MCP.

**8 — the catalog completeness guard has a blind spot.** `scripts/gen-tool-catalog.ts:621`:

```ts
const onDisk = globSync('packages/*/tool-*', { cwd: scanRoot }).map(p => basename(p)).sort()
```

so a model-callable tool registered anywhere else is silently undocumented — directly contradicting
the doc's own claim (`docs/tool-catalog.md:7`): *"so a new tool cannot be silently undocumented."*
`mcp__*` and `structured_output` are absent today (`grep -c mcp docs/tool-catalog.md` → 0);
`run_code`, `exit_plan_mode`, and `schedule_*` appear only because someone hand-added them to the
manifest. `cordis-host-runner` can also let a dynamically-defined VM package register further
model-visible tools at runtime.

Two further catalog defects: the pwsh *"mirrors the bash tool call-for-call minus sandbox
controls"* note (`gen-tool-catalog.ts:260`) is **false** — `tool-pwsh/src/index.ts:33,102-142`
implements full escalation — and `sandbox_permissions`/`justification`, the two most
security-relevant parameters in the shipped bundle, never appear because the generator mounts
non-confining executors.

**Fix:** derive the inventory from `ctx.tools` on a booted *shipped* profile rather than a directory
glob, and derive deployment notes from source instead of hand-writing them. One change closes all
three defects.

### 9. `CLAUDE.md` is not a symlink, and a junk instruction file reaches the model. — High / Bug

**Area:** `AGENTS.md:150`; `packages/context/agent-instructions/src/{config.ts:12,files.ts:363-384}`

`AGENTS.md:150` states: *"`CLAUDE.md` symlinks `AGENTS.md` at root and `packages/`; edit the real
file."* Both clauses are false. Verified against the **committed tree object**, which is independent
of checkout settings:

```
$ git ls-tree -r HEAD | grep -E 'CLAUDE\.md|\.claude/skills'
100644 blob 47dc3e3d…  .agents/notes/implemented/CLAUDE.md
100644 blob 2b7a412b…  .claude/skills
100644 blob 47dc3e3d…  CLAUDE.md
100644 blob 47dc3e3d…  packages/CLAUDE.md
100644 blob 47dc3e3d…  vendor/CLAUDE.md
$ git ls-tree -r HEAD | awk '$1=="120000"' | wc -l
0
```

Mode `100644` = regular file, not `120000` = symlink. **Zero symlinks exist anywhere in the
commit.** Root `CLAUDE.md` is 9 bytes: `AGENTS.md`, with no trailing newline (which also violates
`AGENTS.md:134`). There are **four**, not two — `vendor/CLAUDE.md` and
`.agents/notes/implemented/CLAUDE.md` are unlisted. `.claude/skills` is a 17-byte text file
containing `../.agents/skills`, so repository skills are not discoverable through `.claude/skills`.
The proximate cause is visible: `git config core.symlinks` → `false`, so a symlink-authored upstream
was flattened when this history was created. Regardless of cause, the committed state is what every
consumer gets.

**The runtime consequence is model-visible.**
`packages/context/agent-instructions/src/config.ts:12` sets
`DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']` — both are loaded from the same
directory with no candidate priority, then collapsed only when their **trimmed content digests
match** (`dedupInstructionFilesByDirectory`, `files.ts:368-384`). Its docstring
(`files.ts:363-364`) says: *"A candidate that symlinks a sibling resolves to the same content and
collapses here like any byte-identical real file."* That holds only for real symlinks. Here
`AGENTS.md` (16,557 B) and `CLAUDE.md` (9 B) have different digests, so **both load**, and the
model receives a second workspace-instruction file whose entire body is the literal string
`AGENTS.md` — at root, at `packages/`, at `vendor/`, and at `.agents/notes/implemented/`.

Two static gates share the blind spot: `scripts/verify-md-wrap.ts:4-5` and
`scripts/verify-md-links.ts:7` both document *"symlinked instruction files are deduped"*, implemented
via `realpathSync` at `scripts/repo-files.ts:48`, which cannot dedupe a non-symlink — so they scan
the 9-byte stubs as documents. The same defect hits the feature's own test fixtures:
`snapshots/session/agent-instructions/workspace/{,nested/}AGENTS.md` are 19-byte text files
containing `AGENTS.canonical.md`, so the recorded expected output encodes the degraded behaviour.
`snapshots/AGENTS.md` ¶7 likewise relies on adapter-local symlinks that do not exist.

**Fix.** Decide and enforce one representation. Either (a) commit real symlinks and add a gate
asserting mode `120000` for every `CLAUDE.md` — brittle on Windows checkouts; or preferably
(b) drop the stub files entirely and register `CLAUDE.md` only as a *fallback* candidate that is
skipped when a sibling `AGENTS.md` exists. (b) removes the whole class, fixes the four gates and the
fixtures, and matches how the candidate list is actually meant to work. Either way, correct
`AGENTS.md:150` and re-record the snapshot fixtures.

**Proof.** A test asserting the assembled instruction baseline for this repo root contains exactly
one source. Today it contains two, one of which is nine bytes of noise.

### 10-11. Sandbox confinement is inconsistent and network-blind. — High / Bug + Future risk

**10 — four answers to "what is writable".** `packages/sandbox/sandbox/src/roots.ts:52-55` claims to
be the single home:

```ts
export function writableRoots(policy) {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath))]
}
```

Only Seatbelt (`profiles.ts:53`) and the in-process fs fence (`fs-sandbox/src/index.ts:134`) use it.
`bwrapProfileArgs:16-23` uses `--tmpfs /tmp` + `--bind workspaceRoot` (an *ephemeral* tmpfs;
`os.tmpdir()` never granted). `landlockProfileArgs:30-36` grants `['/dev/null','/tmp',workspaceRoot]`
**un-canonicalized**. `windowsAclRunnerArgv` (`sandbox-local/src/index.ts:353-375`) grants a random
private `mkdtemp` child with its own capability SID.

The practical Windows consequence: `fs-sandbox` is mounted unconditionally on all platforms
(`cordis.patch.yml:490-491`), so under `workspace-write` the `write`/`edit`/`str_replace_editor`
fence grants the **entire** `os.tmpdir()` (`C:\Users\<u>\AppData\Local\Temp`) plus `C:\tmp` if it
exists, while `pwsh` in the same session gets only a per-session private temp. Two tools, one
session, one mode, materially different write scope. `roots.ts:9-11` frames these as *"honest
per-runner differences… with parity pinned by test"*, but that framing hides a genuine capability
difference rather than documenting one.

Related asymmetry: two containment algorithms for the same question —
`sandbox-windows-acl/src/path-boundary.ts:24-25` does case-sensitive `relative()` + `..` on
`realpath`'d paths, while `fs-sandbox/src/containment.ts:58-76` uses a case-insensitivity flag keyed
on `process.platform !== 'win32'` with a `dev`/`ino` identity fallback.

What *is* handled well and should be left alone: symlinks (`realpathSync.native` on both sides, with
a recorded rationale for `.native` over the JS impl at `roots.ts:32-36`), `..` traversal,
cross-drive paths, and the honest `STATIC_ENFORCEMENT: 'partial'` declaration for Windows with its
reason inline (`WRITE_RESTRICTED` needs Everyone in both restricting lists; NTFS hard links can
alias a granted file outside the workspace). Genuinely unhandled and undocumented: **UNC and `\\?\`
paths** — `grep -riE 'unc|\\\\\?' packages/{sandbox,fs,shell}` returns nothing relevant, and a UNC
workspace root would be hashed to a capability SID and passed to `SetNamedSecurityInfoW` with no
rejection or normalization. Also worth flagging: `configuredRunnerCommand`
(`sandbox-local/src/index.ts:319-326`) trusts an operator-supplied runner unconditionally, hands it
**bwrap-shaped** args regardless of what it is, and claims `enforcement: 'full'` with no probe.

**Fix.** Make `writableRoots()` the sole source for every backend *and* the fence, expressing
per-runner differences as an explicit typed reduction from that set rather than four independent
derivations. Reject or normalize UNC roots explicitly. **Proof:** one parametrized test asserting,
for each backend and the fence, that the writable set equals the declared reduction of
`writableRoots()` — the test that would fail today.

**11 — no network confinement anywhere.** `bwrapProfileArgs` uses `--unshare-pid` but **not**
`--unshare-net`. Seatbelt is `(allow default) (deny file-write*)` — file writes only. Landlock is
filesystem-only by construction. Windows ACL: *"network policy … out of scope"*
(`sandbox-windows-acl/README.md:173`). So under `read-only`, a `bash` command cannot write a file
but can exfiltrate the whole workspace over the network. That is a defensible threat-model choice —
but it is not stated in `docs/subsystems/sandbox.md` as a negative guarantee, and `read-only` reads
as stronger than it is. **Fix:** add `--unshare-net` / a Seatbelt network rule for `read-only`, or
document the exclusion as an explicit negative guarantee.

### 12-13. The coverage gate is narrower and softer than advertised. — High

`AGENTS.md:67` says: *"`pnpm run test:coverage` # CI coverage gate: per-file 100% on
`packages/*/*/src`"*. Thresholds are real (`vitest.config.ts:357-365`, `perFile: true`, all four
metrics at 100), but:

**12 — 459 of 1,602 `src` files (28.8%) are excluded** (`vitest.config.ts:209-352`). By group:
`experimental` 182, `client` 128, `extensions` 40, `api` 18, `sandbox` 10, `typert` 10, `session` 7,
`interaction` 6, `llm` 6. Whole trees are dropped — `packages/extensions/*/src/**`,
`packages/experimental/webworker-runtime/src/**` (listed twice, L261 and L341),
`packages/typert/generator/src/*.ts`, most of `packages/client/ui-*/src/client/*` — plus ~30
individually-named client files and a `!(ApprovalCommand)` negation pattern. Platform-conditional
exclusions drop 39 more on the win32 lane. The exclusions correlate almost exactly with the worst
spec:src ratios (`experimental` 261/68, `extensions` 40/15, `client` 543/278, `storage` 18/5):
**the untested trees are also the ungated trees.** One package has no spec at all —
`packages/util/values` — and is *not* excluded, so its 100% comes incidentally from other suites.

**13 — thresholds silently vanish under partitioning.** `vitest.config.ts:357-365` sets
`thresholds: coveragePartitionMode ? undefined : {…}`, and `scripts/coverage-partitions.ts:574` sets
`DSH_COVERAGE_PARTITION_MODE=1` per partition child. The merge step re-enables them (L591-594) — so
correctness depends entirely on the merge running. A partitioned run whose merge is skipped reports
success with **no thresholds at all**. That is a silent downgrade, which `AGENTS.md:116`
("Misconfiguration fails loud") forbids.

**Fix.** (a) Restate the AGENTS.md claim with its real scope, and print the measured
`excluded/total` count in the gate's own output so the number cannot drift unnoticed. (b) Give each
exclusion a reason and owner in a manifest — the repo already does this for `coverage-exempt.ts` and
`doc-budgets.manifest.json` — and gate that the list only shrinks. (c) Make partition mode fail loud
without its merge, via a sentinel the merge consumes.

### 14-15. `dcd9a82`: how a 56-file change ships unverified. — High / Bug

**14 — 24 source files, one test, zero snapshots.** The only test artifact is
`packages/session/session-telemetry/tests/sensitive.spec.ts`, paired with the one new source file.
Untested: three behavioural changes in `agent-loop/src/agent.ts` (attempt-counter seeding on resume,
`AggregateError` on a failed `turn/end`, persisted `maxTokens` restore), the new
`TOOL_OUTCOME_UNKNOWN` scheduler path in `tool-calls.ts`, every new tool bound (`todo` 100/2000,
`subagent` 8000, `web_search` snippet caps, `job_output` validation, `str_replace_editor` streaming
+ caps), both `llm-deepseek` fixes, both `temperature: 0` determinism fixes, and the `spill-policy`
`glob`/`grep` skip.

The nearest pre-existing coverage is insufficient in an instructive way:
`packages/core/agent-loop/tests/tool-calls.spec.ts:639-697` asserts only the final `turn/end`
reason, never the new `tool/result` closers — so it will *execute* the new lines, satisfying line
coverage, without asserting them. That is exactly what `docs/testing.md:10` warns about: *"Line
coverage is necessary, never sufficient — it proves lines ran, not that the feature works as
shipped."* Similarly `resume.spec.ts:497-534` asserts `TOOL_OUTCOME_UNKNOWN` for the *durable
crash-recovery* path, not the new *live-scheduler* path — a distinction the commit's own note calls
out at line 17. No test anywhere references attempt-id uniqueness across resume.

`AGENTS.md:127` requires a keyless recorded-session snapshot for *"every non-trivial model- or
product-user-visible change"*; `AGENTS.md:130` requires both SDK projections updated for agent-loop
and `SessionEventMap` changes. This commit alters turn-end semantics, tool-result content, **five
tool schemas** (`number`→`integer`), and **four tool descriptions** — all model-visible — and
touches nothing under `snapshots/`, `apps/cli/tests/`, or `apps/web/tests/`.

**15 — the pre-commit translation gate is keyed on the wrong file.** `lefthook.yml:8`:

```yaml
glob: '*.i18n.yaml'
run: … verify-translation-pairing.ts --cached {staged_files}
```

The drift this gate exists to catch is introduced by editing a `.md`. `dcd9a82` staged seven **new**
`.i18n.yaml` records (so the hook ran and passed on those) while modifying **nine** `.md` files
*without* their records — `docs/config-catalog.md`, `docs/tool-catalog.md`, and the READMEs of
`tool-str-replace-editor`, `tool-lsp`, `session-telemetry`, `spill-policy`, `tool-subagent`,
`tool-todo`, `tool-web`. Because those records were not staged, the glob excluded them and the hook
never examined them. The gate is **still red after the commit** — verified by running
`pnpm run verify-translation-pairing` at `HEAD`.

**Fix.** Change the glob to `'*.md'` (plus `*.i18n.yaml`) and have the checker map each staged
Markdown file to its record. One line, for a gate currently a no-op against its primary failure
mode. Two of the nine are *generated* catalogs, so also have `gen-*-catalog --write` re-record
pairing for files it rewrites.

**Proof.** Modify one `README.md` without its `.i18n.yaml` and attempt a commit — the hook must
reject it.

### 16. The system prompt is dominated by a generated SDK dump. — High / Design weakness

**Area:** `packages/core/tools/src/index.ts:848,868`; `snapshots/**/system-prompt.expected.md`

Recorded prompt sizes from committed snapshots:

| Scenario | bytes | ≈tokens |
|---|---|---|
| `session/cordis-inspect-jsdoc` | 54,047 | ~13,500 |
| `session/ptc-python-turn` | 41,448 | ~10,400 |
| `session/both-mode-turn` | 36,783 | ~9,200 |
| `web/ptc-round` | 33,991 | ~8,500 |
| `sdk/text-turn` | 4,147 | ~1,040 |

In the 36,783-byte `both-mode-turn` prompt, the harness identity, persona, and all fourteen
per-tool guidance sections occupy **lines 1-33**. The `tools:sdk` section — a generated TypeScript
declaration set (`interface ToolArgsMap`, `ToolOutputMap`, `declare class ToolCallError`,
`declare const tools`) regenerated per calling scope — occupies **lines 34-558, roughly 85% of the
prompt.**

The architecture around this is sound and worth preserving: sections are registry-contributed with
explicit `order` constants (`system-prompt/src/index.ts:121-152`), tool schemas are whitelisted to
`{name, description, parameters}` (`core/tools/src/index.ts:1249-1259`), and the whole prompt sits
at the front of an append-only prefix so DeepSeek's server-side cache is reused — a property
actually asserted against a live provider by
`packages/core/agent-loop/tests/request-cache.e2e.ts:14-22`. So the cost is a *cache-warm* cost, not
a per-request cost, in steady state.

**Failure mode.** It is still ~9-13.5k tokens of the context window consumed before any
conversation, and it grows linearly with the tool count — the `cordis-inspect-jsdoc` scenario is
already 54 KB. Combined with `compaction-basic`'s `retainRatio 0.16`, a large prompt directly
shrinks the retained verbatim tail after compaction. And because the block is regenerated **per
scope**, a subagent with a different tool set gets a different prefix and a cache miss.

**Fix.** Two independent levers, in order of value: (a) emit the SDK declarations only for scopes
that actually enable PTC/`run_code` — the `both-mode-turn` name suggests both modes are advertised
simultaneously, which doubles the surface; (b) compress the generated declarations (drop redundant
JSDoc, collapse `ToolArgsMap`/`ToolOutputMap` for tools whose schemas are already in the tool
definitions the provider receives separately). **Proof:** the existing
`system-prompt.expected.md` snapshots make this directly measurable — assert a byte ceiling per
scenario and watch it fall.

---

## P2 detail — drift and instruction quality

### 17-18. Deleted CI still documented as current; the detector was never run. — High / Bug

`pnpm run verify-md-links` fails with **46 broken links, all `.github/workflows/*`**: 22 × `ci.yml`,
10 × `ci-master.yml`, 4 × `build-exe-for-python-sdk.yml`, 2 each of `sandbox.yml`,
`issue-policy.yml`, `issue-lifecycle.yml`, `e2e.yml`, plus `docs/development.md:123` and
`docs/development.zh.md:127`. Zero anchor failures — the gate itself is well built.

Behind those links, **23 current-authority Agent Notes** describe the deleted system, including
`implemented/process/2026-07-21-serial-cross-platform-ci-reference.md`,
`…/2026-07-23-portable-required-pull-request-ci.md`, `…/2026-07-26-ci-failover-runbook.md`,
`…/2026-08-08-native-windows-pull-request-ci.md`,
`…/2026-08-31-serial-windows-notices-timeout-budget.md`,
`implemented/testing/2026-06-19-real-api-e2e-ci.md`,
`…/2026-08-29-windows-lane-hook-and-lefthook-budget.md`,
`implemented/bug-fix/2026-07-29-pnpm-setup-runner-isolation.md`, and every `.zh.md` counterpart.
`.github/AGENTS.md` (144 words) does the same in prose, describing `ci.yml`, `ci-master.yml`, the
Wine job, `windows-2025`, the `dsh-win-ci` pool, `serial-windows`, and `wine-apt-cache`.

`.agents/notes/README.md:13` makes these binding — an `implemented/` note is *"**kept current with
what actually shipped**"* — and `AGENTS.md:125` exempts only *archived* notes from being current
authority. So an agent reading the serial-CI reference is told with full repo authority that pull
requests run Wine-hosted Windows jobs, that `all checks passed` is a required aggregate, and that
self-hosted `vm-backup`/`dsh-win-ci` pools continuously re-prove failover. None of it exists.

**Fix.** These describe replaced infrastructure, not a reversed decision. Per
`.agents/notes/README.md:38,50`: write one `implemented/process/2026-09-…-gitlab-ci-migration.md`
recording the move and what was given up, archive the obsolete CI-topology notes as a single
archival change (which repairs inbound links per the archive procedure), and fix
`docs/development.md` and `.github/AGENTS.md`. Do **not** edit the old notes into describing
GitLab — the README forbids rewriting a note into a different decision.

**Proof.** `pnpm run verify-md-links` green. It is the mechanical detector for this exact class and
already caught all 46 — it was simply never run, which is finding 1.

### 19. The current-authority corpus is unbounded and archiving has collapsed. — High / Design weakness

| Lifecycle | English notes |
|---|---|
| `implemented/` | **665** (716,908 words) |
| `archived/` | 176 |
| `proposed/` | 28 |
| `rejected/` | 9 |

By class: `feature` 207, `architecture` 186, `bug-fix` 113, `process` 84, `simplification` 55,
**`testing` 18**.

| Month | implemented added | archived | ratio |
|---|---|---|---|
| 2026-06 | 50 | 18 | 36% |
| 2026-07 | 262 | 123 | 47% |
| 2026-08 | **329** | **33** | **10%** |
| 2026-09 (9 d) | 22 | 1 | 5% |

Three rules compound into a drift engine:
- `README.md:46` / `AGENTS.md:125` — every non-trivial change **must** add or update a note.
- `README.md:13` — every `implemented/` note kept current with shipped reality, in the same change.
- `README.md:19` — *"**Do not add a centralized `INDEX.md`**"*; discovery is "browse the folders or search the repository".

So the corpus grows ~330 notes/month, carries a per-change freshness duty across 717k words, and is
deliberately unindexed. Archiving — the only pressure valve — fell 47% → 10%.

**Failure mode.** No agent can honour `README.md:13` at this scale: it cannot know which of 665
notes a change invalidates without reading all of them. Finding 17 is that failure already realized.
The no-index rule optimizes against a stale index and pays with no way to find the owning note,
which drives duplicate notes and the mega-note of finding 27.

**Fix — machinery, not more prose.**
- **Generated index.** The no-index note rejected a *hand-maintained* index; a generated one
  (`scripts/gen-agent-note-index.ts` + `--check`, matching the eleven existing `gen-*`/`verify-*`
  catalog pairs) carries none of that objection. Emit path, title, class, status, and the
  packages/scripts/paths each note names.
- **Reference-integrity gate.** Extend `verify-agent-note-format`: every path, package name, and
  script name a non-archived note states in backticks must exist. That is the mechanical form of
  "kept current", and it would have caught finding 17 the day the workflows were deleted —
  `verify-md-links` only sees Markdown links, so the notes' *prose* claims were invisible.
- **Report the aggregate.** `README.md:38` rightly rejects a quota for *which* note to archive, but
  that left the total unmonitored. Print implemented-note count and total words from `doc-quick`.

**Proof.** Rename a package a note references → the gate fails naming note and symbol. Regenerate
the index on a clean tree → `--check` is a no-op.

### 20-23. The instruction hierarchy has no precedence, saturated budgets, and two stale inventories. — Medium

**20 — the budget rules are stated, unenforced, phantom, and violated.** `docs/AGENTS.md:57` states
three rules beyond the ceilings: *"At or below target, retain at least 5% headroom"*; *"subtree
`AGENTS.md` ≤ 600"*; and a target for `examples/AGENTS.md` (310). But
`scripts/verify-doc-budgets.ts:27` iterates **only** the 8 entries in
`scripts/doc-budgets.manifest.json` and checks only the ceiling. Consequences:

| File | ceiling | actual | headroom | 5% rule |
|---|---|---|---|---|
| `AGENTS.md` | 1950 | **1945** | 0.26% | **violated** |
| `docs/cordis-primer.md` | 600 | **599** | 0.17% | **violated** |
| `docs/testing.md` | 1300 | 1290 | 0.8% | **violated** |
| `docs/AGENTS.md` | 1320 | 1303 | 1.3% | **violated** |
| `packages/AGENTS.md` | 750 | 715 | 4.7% | **violated** |

- `examples/AGENTS.md` **does not exist** anywhere in the repo, and is not in the manifest, so the
  verifier's own "missing budgeted file" branch never fires for it.
- The `subtree ≤ 600` rule is exceeded by `packages/client/AGENTS.md` at **3,205 words (5.3×)** and
  `native/landlock-run/AGENTS.md` at 705 — **neither is in the manifest**, so the gate cannot see
  them. `packages/client/AGENTS.md:3` also claims authority over `apps/web` from inside `packages/`,
  and there is no `apps/cli/AGENTS.md` or `apps/web/AGENTS.md`.
- `docs/AGENTS.md:22` enumerates the subtree set as exactly `(packages/, docs/, .agents/notes/)`;
  **17** subtree `AGENTS.md` exist across 13 further locations (`packages/{client,experimental,schedule,web}`,
  `snapshots/`, `scripts/`, `website/`, `vendor/`, `native/landlock-run/`, `.github/`,
  `apps/cli/tests/profiles/`, `.agents/notes/{implemented,archived}`).
- `.agents/notes/README.md` (1,710 words) governs the entire note corpus and is **unbudgeted**.

The saturation is not cosmetic. With ~32 words of combined headroom across the three files an agent
reads first, every new rule must bump a ceiling or displace a rule, and the observed response has
been extreme compression: `AGENTS.md` is 33 single-line bullets averaging ~30 words, each a dense
clause chain with 1-3 outbound links — line 118's "Trust TypeScript at typed same-process
boundaries" packs a policy plus a seven-item exception list into two sentences. Prose that dense
degrades instruction-following, and the overflow is what fed the 717k-word note corpus.

**Fix.** Enforce what is stated or stop stating it: add the headroom clause and the subtree rule to
`verify-doc-budgets`, register every subtree `AGENTS.md` (and `.agents/notes/README.md`) in the
manifest, and delete the phantom `examples/AGENTS.md` target. Then re-target the budget from total
words to **words per rule plus a declared overflow destination**: raise `AGENTS.md` to ~2,400, keep
the ~10 genuinely global rules in plain sentences, move the rest into `docs/testing.md`,
`docs/development.md`, and `packages/AGENTS.md` so the root becomes a routing table. Add a
**rule-count** budget so compression cannot smuggle in more rules under the same word cap.

**21 — no conflict-resolution precedence exists.** `docs/AGENTS.md:21-22` states an *ownership* rule
("one home per fact"), not an order. Every subtree file self-describes as additive — `packages/AGENTS.md:3`
*"supplement the repo-wide conventions"*, and the same word in `packages/{web,experimental,schedule,client}/AGENTS.md:3`.
No document anywhere says what wins when root and subtree disagree. The only precedence statement
that reaches the model is a string literal in
`packages/context/agent-instructions/src/render.ts:12-14`: *"More specific instructions take
precedence over broader ones. They do not override system, developer, or direct user
instructions."* **Fix:** state that sentence once in `docs/AGENTS.md` as the repo's rule, so the
authoring hierarchy and the runtime hierarchy agree and are discoverable without reading source.

**22 — the layout table is stale while also delegating the same fact.** `AGENTS.md:16-50` lists 35
package groups; `packages/` has 50. It omits **17** (`attachment`, `client`, `code-runtime`,
`extensions`, `feedback`, `goal`, `host`, `jobs`, `mcp`, `runtime-diagnostics`, `sandbox`,
`schedule`, `session-query`, `spill`, `storage`, `test-support`, `workspace`) and names **2** that no
longer exist (`self-modification/` → now `extensions/`; `support/` → now `test-support/`). Several
are load-bearing for this audit: `sandbox`, `spill`, `mcp`, `jobs`. Meanwhile `AGENTS.md:59` says
*"Package groups: [packages/README.md]"* — it delegates the fact and then inlines a stale competing
copy, which is the first item on `docs/AGENTS.md:61`'s own slop checklist (*"The same rule stated in
more than one home"*). The delegated home is nearly right: `packages/README.md` documents 49 of 50,
missing only `mcp`. **Fix:** delete the inline table, keep the delegation, and gate
`packages/README.md` against the directory listing (fold into `verify-package-paths`).

**23 — the Commands block omits the aggregates.** 18 of 142 npm scripts are documented, and all 18
resolve. But omitted entirely: **`check:all`** (the full local aggregate — the single largest gate
graph), the whole **`check:ci*`** family (11 scripts), `build:web`, `build:official`, `test:web*`,
`test:gui`, `docs:check`, `constraints`, `publint`, `lint:fix`, `mock:llm`, `dev:web`, and
**`change-scope`** — which `.agents/skills/dsh-code-review/SKILL.md:8` *requires* an agent to run.
Also `AGENTS.md:80` describes `website:build` as the VitePress build; it is a bare alias for
`docs:build`, and the gate graph never invokes it. **Fix:** document `check:all` and the `check:ci*`
family (they are the answer to "how do I verify like CI does"), and add `change-scope` since a skill
depends on it.

### 24-26. Gates that don't fire, and rules with no gate. — Medium

**24 — `verify-skill-invocation-metadata` is structurally vacuous.**
`scripts/verify-skill-invocation-metadata.ts:31-38` returns only skill directories where
`agents/openai.yaml` exists. `.agents/skills/.gitignore` is exactly `*/agents/openai.yaml`, and no
such file exists. So in any clean clone the gate iterates an empty list and **passes
unconditionally** — including in `doc-quick`, where it reports as a passing gate. The one skill with
a non-default invocation policy (`dsh-translate-docs`, `disable-model-invocation: true` /
`user-invocable: true`) is therefore never cross-checked. **Fix:** fail when the skill set is empty
but skills exist, or check the frontmatter directly and drop the sidecar dependency.

**25 — the largest recurring failure classes have no defensive pattern.** Cross-referencing
`docs/defensive-patterns.md`'s 8 patterns against the 141-note bug-fix corpus:

| Recurring class | Notes | Pattern? |
|---|---|---|
| GUI / composer / scroll / layout | 50 | **none** |
| resume / lifecycle / HMR reload | 46 | only teardown, not resume-side identity reuse |
| cancel / abort / signal escalation | 42 | yes (L15) — still recurring |
| tool-argument / schema validation | 42 | **none** |
| streaming / decode / chunk-queue | 41 | yes (L11) — still recurring |
| **unbounded output / missing cap / spill** | **39** | **none** |
| compaction / context-window | 31 | **none** |
| token accounting / meter | 30 | **none** |
| teardown / dispose / quiescence | 26 | yes (L19) — still recurring |

The unbounded-output gap is sharpest: **three of the five newest bug-fix notes are that class**
(`2026-09-09-decode-cap-single-spill`, `-editor-bounds-subagent-guidance`,
`-early-wait-validation-bounded-search`), and `dcd9a82` adds five separate hardcoded caps. Note also
that patterns L19 and L31 were written *before* incidents that still recurred
(`2026-08-12-unlink-fixture-junctions-before-delete` post-dates the unlink pattern) — so pattern
coverage alone is not converting into prevention. The missing half is a gate. **Fix:** add the three
highest-yield patterns (declared output caps; resume-side identity reuse; tool-argument bound-and-type
rules) and, for each, name the gate that enforces it.

**26 — nine `AGENTS.md` rules have no executing gate:**

| Rule | Where | Gate |
|---|---|---|
| No hardcoded tunables in plugins | `AGENTS.md:115` | **none** — violated by `dcd9a82`: `MAX_EDITOR_FILE_BYTES`/`MAX_LIST_ENTRIES`/`MAX_SEARCH_BYTES` (`tool-str-replace-editor/src/index.ts:44,46,48`), `MAX_TODOS`/`MAX_TODO_CONTENT_CHARS` (`tool-todo/src/index.ts:29,31`), `MAX_PARTIAL_TEXT_CHARS` (`tool-subagent/src/index.ts:178`) — while `tool-web` added the equivalent caps *as Config fields* in the same commit |
| Prefer symmetry for parallel values | `AGENTS.md:123` | **none** — finding 28 |
| An empty `catch` names what it swallows | `AGENTS.md:121` | **none** |
| Model-visible ⟺ logged | `AGENTS.md:110` | partial (`verify-session-format-catalog`); nothing checks a new model-visible tool parameter has a session event |
| Design each tool's UI presentation up front | `AGENTS.md:128` | **none** — `presentCall`/`presentResult` optional (`core/tools/src/index.ts:271,279`) |
| Plan unit, e2e, and snapshot coverage | `AGENTS.md:129` | coverage only; nothing checks a snapshot was added |
| Both SDKs project the loop | `AGENTS.md:130` | **none** — AGENTS.md itself says *"`pnpm run test` covers neither"* |
| Every tool declares `timeoutMs` | implied by the guard | **none** — finding 5 |
| Every mutating tool is gated | implied by the approval seam | **none** — finding 4 |

The hardcoded-tunables case is the most telling: the same commit violated it three times and
honoured it once. That is what an ungated rule looks like in practice. **Fix:** prioritize by
observed violation rate — a lint rule for module-scope `MAX_*`/`DEFAULT_*` numerics in
`packages/*/tool-*/src` not reachable from a `Config` field, and a `change-scope`-driven check that
an agent-loop / `SessionEventMap` / tool-schema diff also touches `snapshots/` and both SDK expected
outputs.

### 27-29. Change hygiene and one unwired safety module. — Medium

**27 — `dcd9a82` bundles ~15 unrelated fixes.** One note's `## Decision`
(`2026-09-09-harness-reliability-and-tool-quality-fixes.md:13`) spans agent-loop attempt-id seeding,
synthetic `TOOL_OUTCOME_UNKNOWN` closers, `AggregateError` on `turn/end` failure, `buildRequest`
`maxTokens` restoration, DeepSeek `mapUsage` clamping, `httpErrorCode` overflow routing,
`terminal send` `TOOL_ABORTED`, `bash` escalation policy, a background-`bash` registration race,
web-fetch error redaction plus loopback rejection, `todo_write` bounds, `goal` integer types,
compaction/title `temperature: 0`, and subagent output capping — across 12 package groups.

`AGENTS.md:131` says *"**Choose PR history deliberately.** Split independent changes."* These share
a theme, not a cause: bundled, they cannot be reverted independently or bisected, and fourteen
distinct decisions share **one** `## Alternatives considered` section with four alternatives — so
most shipped without their trade-off recorded, the exact failure Agent Notes exist to prevent
(`README.md:111`). Two changes in the commit — the `path-boundary.ts` contract widening and the
`tool-bash`/`tool-terminal` abort fixes — are not named by any note. This is plausibly a consequence
of finding 19: with 665 unindexed notes and a mandatory note-per-change rule, batching is cheapest.
**Fix:** split by owning seam (agent-loop/session-log, LLM adapter, per-tool), or at minimum split
the note per decision cluster so each carries its own alternatives.

**28 — asymmetric fixes.** The two `tool-bash` fixes were not propagated:

| Fix in `tool-bash` | `tool-pwsh` | `tool-terminal` | `tool-subagent` | `tool-fs` |
|---|---|---|---|---|
| `standingPolicy === undefined` refusal | ✗ (`src/index.ts:354`) | n/a | n/a | ✗ (`src/sandbox.ts:96,128`) |
| pre-`jobs.start()` abort check | ✓ | ✗ | ✗ | n/a |
| post-`jobs.start()` abort + `jobs.kill` | ✗ (`:392`) | ✗ (`:275`) | ✗ (`:575`) | n/a |

Critically, `tool-bash` is `disabled: process.platform === 'win32'` and `tool-pwsh` is
`disabled: process.platform !== 'win32'` (`cordis.patch.yml:252-258`) — **on Windows the hardened
file is the one that never loads.** `tool-str-replace-editor` got both fixes in the same commit;
`tool-fs/src/sandbox.ts` did not. Also `tool-terminal/src/index.ts:280` throws the **literal**
`'TOOL_ABORTED'` instead of importing the exported constant, which `tool-bash:14` does. **Fix:**
propagate all four and extract the standing-policy resolution and background-registration guard into
one shared helper so the next fix cannot land on one call site only.

Related: most tools throw plain `Error`, and `errorInfo` (`core/tools/src/index.ts:635-641`)
populates the structured `{name, code}` **only for `HarnessError`** — a fact
`packages/fs/tool-fs/src/sandbox.ts:113-117` documents as load-bearing. So every sandbox-escalation
refusal (`sandbox/src/escalation.ts:53,56,59,163,166,169,184-186`) reaches the model with no
routable code. **Fix:** make the escalation refusals `HarnessError`s.

**29 — telemetry scrubbing ships unwired.** `packages/session/session-telemetry/src/sensitive.ts`
(new in `dcd9a82`, exported at `src/index.ts:180-186`, tested) provides `scrubSensitiveValue`,
`scrubSensitiveRecord`, `DEFAULT_SENSITIVE_PATTERNS` — and has **no consumer anywhere outside its
own package**. The module header frames this deliberately (*"the seam itself ships no rules so
pass-through stays explicit"*), but telemetry bodies carry tool arguments, so they ship unscrubbed by
default while the commit presents the work as "telemetry scrubbing". **Fix:** mount a default rule
set in `bundle/base`, or state the negative guarantee in the package README and the note.

---

## P3 detail

**30 — doc validation is slow enough to discourage running it.** Measured: `pnpm run test:docs` →
`13 passed, 2 failed in 83.24s`, of which `verify-md-links` **73.6s** and
`verify-translation-pairing` **76.5s**, over 2,918 Markdown files and 1,317 records. This is the
*quick* lane (15 of 33 leaves). Combined with finding 3's "run the narrowest check" and finding 1's
absent CI, doc gates effectively never run — findings 15, 17, 18 are the result. **Fix:** add an
incremental `--since <ref>` mode driven by `scripts/change-scope.ts`, which already computes
committed/staged/unstaged/untracked paths against a merge base; the lefthook path already passes
`{staged_files}`, so the plumbing exists. Keep the full scan as the CI lane. **Proof:** time
`verify-md-links --since origin/main` on a one-file change — target <3s — and assert incremental and
full modes agree on a seeded broken link.

**31 — two test suites are run by nothing.** `pytest.ini` + `python/sdk/pyproject.toml:27-29`
declare a 6-file suite; no npm script and no gate runs `pytest` (`.gitlab-ci.yml:43` uses
`uv run --group test` only to run `smoke-python-runtime.py`).
`native/landlock-run/test/{entry,launcher}.test.js` are reachable only via that package's own
`"test"` script — `grep landlock-run scripts/run-gates.ts` → zero hits. Neither is mentioned in
`AGENTS.md`. **Fix:** add both to `ci-consumers`.

**32 — snapshot normalizers hardcode user-visible prose.**
`packages/test-support/session-snapshot/src/normalize.ts:49-58` — `LOCAL_SPILL_PATH_RE` /
`SNAPSHOT_SPILL_PATH_RE` embed `session-[0-9a-f]{12}/[0-9a-f]{12}-` plus the literal lookahead
`(?=\. Use read with offset/limit|[\s)]|$)`, i.e. the exact retrieval-hint wording of the spill
notice; `EVENT_READ_TARGET_REGION_RE` (L42-43) hardcodes the literal
``Session … — …\nTarget event seq N:\n```json`` envelope. Changing that model-visible prose silently
breaks time/byte scrubbing rather than failing loudly. Broader note: because the recorded
`assistant/message` stream *is* the replay input and the persisted JSONL *is* the expected output,
every scenario asserts byte-exact model text; the only independent oracle is `workspace.expected/`
on `workspace.final: true` scenarios, and `snapshots/AGENTS.md:15` states the mitigation as a review
convention (*"Model prose and tool-result text do not prove the external effect"*), not a mechanism.
**Fix:** derive those regexes from the same exported format constants the producer uses, so a
wording change breaks compilation rather than scrubbing.

**33 — `path-boundary.ts` has no blocking coverage gate.** Coverage-excluded on non-win32
(`vitest.config.ts:82`), and the Windows coverage job was pinned non-blocking
(`ci-workflow.spec.ts:226`, *"temporarily non-blocking while Windows ACP half-close tests are
stabilized"*). The whole `sandbox-windows-acl` tree (10 files) plus 39 win32-lane-excluded files sit
in the same hole; Windows CI also never ran the snapshot lane (`run-gates.ts:543`). **Fix:** when
restoring CI, make `windows-coverage` blocking or record the exclusion in a manifest with an owner
and an expiry.

**34 — no per-turn step or token ceiling.** `agent.ts:543` carries `maxTokens` per request; there is
no `maxSteps`/step-count/per-turn token budget in `agent-loop`. Loop hygiene is delegated to
`guard/repeat-tool-reminder` (a nudge) and `guard/timeout-policy` (per-tool, and per finding 5
inactive for 40+ tools). Compaction bounds *context*, not *work*: `compaction-basic` uses
`thresholdRatio 0.8`, `retainRatio 0.16`, `maxTokens ?? 8192`, with `contextWindow` read from the
adapter. So a tool-calling loop that never overflows context can run unbounded. **Fix:** a validated
per-turn step ceiling in `agent-loop` Config with a loud terminal event.

**35 — a mandatory artifact that cannot be produced without a key.** `AGENTS.md:127` requires a
snapshot update for every model-visible change; `test:snapshot:record` needs `DEEPSEEK_API_KEY`
(`AGENTS.md:71`). An unkeyed agent — the normal case — cannot satisfy a mandatory rule, so the rule
gets skipped, as in `dcd9a82`. **Fix:** state the keyless path explicitly.
`test:snapshot:refresh` is keyless and rewrites expected outputs from fixtures already on disk; for
a change that alters *rendering* of an existing recorded session — which most tool-schema and
description changes are — refresh suffices and record is unnecessary. Say so at `AGENTS.md:127` and
in `dsh-pre-push-checks`.

**36 — a prompt-variable typo is a first-turn crash.**
`packages/core/system-prompt/src/index.ts:322-340`: unknown, valueless, or malformed `{{variable}}`
refs **throw** during `assemble()`, and `README.md:171-173` records that there is **no escape syntax
for a literal `{{…}}`**. `toolOrder` misconfiguration likewise surfaces at first-turn assembly, not
boot — which `AGENTS.md:116` ("Misconfiguration fails loud **at load** when self-contained") argues
against. **Fix:** validate registered section templates against the registered variable set at
plugin activation, and add an escape form.

**37 — no aggregate instruction budget.**
`packages/context/agent-instructions/src/files.ts:333-335` carries
`TODO(total-instruction-read-bound)`: each source is capped at `maxSourceBytes` (1 MiB default,
over-cap files **silently ignored** at `:337,347`), but nothing bounds the *sum* read across a
baseline. The rendered message is well handled — a five-stage degradation ladder
(`render.ts:275-331`) with in-band disclosure of every omission and truncation, plus
`escapeInstructionFrameBody` (`:81-83`) so repository text cannot close the `system-reminder` frame.
The read side is the gap. **Fix:** add the aggregate bound the TODO names, and log rather than
silently drop an over-cap source.

**38 — a release-blocking `FIXME` with no gate.**
`packages/guard/timeout-policy/src/index.ts:6-9`: *"FIXME: settle the intended
'@deepseek-ai/dsh-timeout-guard' rename before the first tagged release."* Repo-wide there are 58
`TODO`/`FIXME`/`XXX` markers (52 TODO, 4 XXX, 2 FIXME) and 179 lint-disable / `@ts-expect-error`
comments. **Fix:** gate that no `FIXME` survives in a release-tagged tree — `AGENTS.md:133` already
defines `FIXME` as the urgent tier, so the semantics exist without the enforcement.

---

## Refactor plan

Ordered so each phase makes the next verifiable. Phase 0 is a prerequisite for trusting any other
work in this repo.

### Phase 0 — restore the signal (≈1 day) — blocks everything

1. **Fix or delete `scripts/ci-workflow.spec.ts`** so `pnpm run test` is green (#2). Retarget its
   still-valid contracts at `.gitlab-ci.yml`; drop the Actions-specific assertions.
2. **Restore an MR/branch pipeline** calling the existing `check:ci:*` scripts (#1). Add a
   pnpm-store cache keyed on `pnpm-lock.yaml`. Protect `main`.
3. **Fix `lefthook.yml:8`** — glob `*.md` too, so the translation gate sees the file that drifts (#15).
4. **Green the two red doc gates**: re-record the nine out-of-sync pairing records and add the
   missing `.zh.md` switcher (#15); supersede-and-archive the CI-topology notes and fix
   `docs/development.md` + `.github/AGENTS.md` (#17, #18).

**Exit criterion:** `pnpm run test`, `pnpm run test:docs`, and a real MR pipeline all green on `main`.

### Phase 1 — close the safety gaps (≈3-5 days)

5. **Ship an approval producer** (#4) — a `tools/pre-execute` policy plugin in `bundle/base` plus a
   runtime invariant that `ask` policy yields at least one `ask`-resolving mutating tool.
6. **Bound every tool** (#5) — validated `defaultTimeoutMs`; gate that every registered tool
   resolves to a finite deadline.
7. **Close the arg-validation holes** (#6, #7) — emit `additionalProperties: false` from the DSL
   compiler and delete the hand-checks; validate `mcp__*` args and return `INVALID_ARGS`.
8. **Fix the instruction-file duplication** (#9) — make `CLAUDE.md` a skipped fallback when a
   sibling `AGENTS.md` exists, delete the four stubs, correct `AGENTS.md:150`, re-record fixtures.
9. **Unify writable roots** (#10) — every backend and the fence reduce from `writableRoots()`; one
   parity test; reject/normalize UNC. Decide and *document* the network stance (#11).
10. **Propagate the asymmetric fixes** (#28) — `pwsh`, `terminal`, `subagent`, `tool-fs`; extract the
    shared helpers; make escalation refusals `HarnessError`s.

### Phase 2 — make the ungated rules gated (≈1 week)

11. **Tool inventory from the runtime** (#8) — `gen-tool-catalog` enumerates `ctx.tools` on a booted
    shipped profile; derive deployment notes from source. Fixes the missing `mcp__*`/
    `structured_output` entries, the false pwsh note, and the absent `sandbox_permissions` docs at once.
12. **`verify-ci-lane-coverage`** (#3) — every `run-gates.ts` `Mode` has a CI job; CI admits MRs.
13. **Hardcoded-tunable lint rule** (#26); backfill the five `dcd9a82` violations as Config.
14. **Model-visible-change gate** (#14, #26) — a `change-scope`-driven check that an agent-loop /
    `SessionEventMap` / tool-schema diff also touches `snapshots/` and both SDK expected outputs.
15. **Coverage-exclusion manifest** (#12, #13, #33) — reason + owner per exclusion, list may only
    shrink; partition mode fails loud without its merge.
16. **Fix the vacuous and unenforced gates** (#20, #24) — headroom + subtree rules in
    `verify-doc-budgets`, every subtree `AGENTS.md` in the manifest, phantom target deleted;
    `verify-skill-invocation-metadata` fails on an empty skill set.
17. **Wire the orphan suites** (#31) — `pytest` and `native/landlock-run` into `ci-consumers`.

### Phase 3 — drift control, prompt cost, and speed (≈1-2 weeks)

18. **Generated Agent Note index + reference-integrity gate** (#19).
19. **Generate the package-group listing; delete the inline table** (#22).
20. **Restructure the instruction files** (#20, #21, #23) — root `AGENTS.md` as a routing table of
    ~10 global rules in plain sentences; state the precedence sentence once; document `check:all`,
    `check:ci*`, and `change-scope`; add a rule-count budget.
21. **Shrink the system prompt** (#16) — SDK declarations only for PTC-enabled scopes; assert a byte
    ceiling per `system-prompt.expected.md` snapshot.
22. **Incremental doc gates** (#30) — `--since <ref>` via `change-scope`.
23. **Backfill the missing defensive patterns** (#25), each naming its enforcing gate; and
    `dcd9a82`'s tests and snapshots (#14).
24. **Remaining hardening** — per-turn step ceiling (#34); prompt-template validation at activation
    (#36); aggregate instruction read bound (#37); `FIXME` release gate (#38).

---

## Recommendations

### Harness reliability

- **Never let the baseline be red.** Make `pnpm run test` green a merge requirement and keep it
  there. A red baseline is uniquely damaging to an agent loop because it removes the agent's ability
  to attribute failure — the single most important signal it has.
- **Every prose rule gets a gate or gets deleted.** The evidence is unambiguous: `AGENTS.md:115` was
  violated three times and honoured once *in the same commit*; defensive patterns L19 and L31 were
  written before incidents that still recurred; `docs/AGENTS.md:57`'s headroom rule is violated by
  five of its eight budgeted files. Ungated rules in this repo have a near-zero prevention rate.
  Prefer nine enforced rules to thirty-three stated ones.
- **Audit the gates themselves, not just the code.** Three gates are currently no-ops against their
  own purpose: the lefthook translation glob, `verify-skill-invocation-metadata`, and the coverage
  thresholds under partition mode. A gate that cannot fail is worse than no gate, because it reports
  green.
- **Fail loud on downgrade paths.** `AGENTS.md:116` already states the principle. Apply it to
  partition-mode thresholds, over-cap instruction sources (silently ignored today), and
  prompt-template misconfiguration (deferred to first turn today).
- **Prefer runtime enumeration over directory globs** for anything claiming completeness. The
  tool-catalog guard is the template failure: a glob over `packages/*/tool-*` cannot see a tool
  registered elsewhere, and two such tools exist.

### Output quality

- **Restore the human-in-the-loop.** #4 is the largest quality gap: the harness advertises a
  permission model it does not have, all the way down to a sentence narrated to the model. Shipping
  the `ask` producer restores both the safety property and the documentation's truth.
- **Declare output caps as Config, not constants.** 39 recorded bug-fix notes and three of the five
  newest are the unbounded-output class. Make "every model-facing text surface has a validated
  `Config` cap" a pattern *and* a lint rule, then delete the five constants `dcd9a82` added.
- **Finish the `integer` migration.** `dcd9a82` moved `goal`, `lsp`, `jobs`; still `number`:
  `read.offset/limit`, `terminal_read.offset/count`, `bash.timeoutMs`, `pwsh.timeoutMs`,
  `ralph`, `list_agents.depth`, `schedule_*`. A float where an index is meant is a recurring class —
  do it in one pass.
- **Keep prompt-prefix stability tested.** The append-only prefix discipline — compaction replaying
  system+tools verbatim so the provider KV cache survives, spill appending rather than rewriting —
  is genuinely good design, and `packages/core/agent-loop/tests/request-cache.e2e.ts` asserts real
  provider cache hits. But it needs a key and lives in a lane no gate runs. Put it in a keyed CI
  lane or the property will regress silently.

### Speed

- **Incremental doc gates** (#30) are the highest-yield latency fix: 83s → single digits for the
  common case, which is what makes the gates actually get run.
- **Cache in CI.** The current pipeline has no `cache:` block; every job re-runs
  `pnpm install --frozen-lockfile` cold.
- **Cut the system prompt** (#16). ~9-13.5k tokens before any conversation, ~85% of it a generated
  SDK dump, and it directly shrinks the post-compaction retained tail via `retainRatio 0.16`.
- **Bound the loop's work, not just its context** (#34). A per-turn step ceiling is cheap and
  prevents the runaway case compaction cannot.
- **Leave the parallelism alone.** `maxParallelToolCalls` (default 10, reclassified per call before
  start) and the rolling pool in `tool-calls.ts:203` are well built; the `pool: 'forks'` choice is
  documented against a real Node 24 CJS-lexer abort. No change recommended.

### Regression prevention and drift control

- **Couple every claim to a check.** The pattern that failed here is *documentation asserting
  infrastructure*. `verify-ci-lane-coverage`, the note reference-integrity gate, and a generated
  package-group listing all convert a prose claim into a test. Generalize it: if a doc names a file,
  script, job, or package, a gate should assert it exists. That single rule would have caught
  findings 9, 17, 18, 20, 22, and 24.
- **Generated over hand-maintained, always.** Eleven `gen-*`/`verify-*` pairs already work well. The
  worst drift sources are precisely the hand-maintained ones: the `AGENTS.md` layout table (17
  groups stale, 2 phantom), the `gen-tool-catalog` boot manifest (one note factually wrong, two
  tools missing), the doc-budget manifest (three subtree files invisible, one phantom target), and
  the Agent Note corpus (no index by policy).
- **Reconsider the no-index rule.** It correctly rejects a *hand-maintained* index but has produced
  a 665-note, 717k-word corpus that is current authority and unnavigable. A generated index carries
  none of the original objection.
- **Watch the archive ratio as a leading indicator.** 47% → 10% in one month preceded the drift
  finding 17 documents. Print the count from `doc-quick`; no quota needed.
- **Treat a direct-to-`main` commit as an incident, not a shortcut.** `dcd9a82` landed on `main`
  with red gates, one test for 24 source files, and no snapshots. Every process rule in
  `AGENTS.md:131-132` about PR history, stacks, and labels assumes a PR.

---

## Verification

How to prove the plan worked, end to end:

1. **Baseline green.** `pnpm run test` and `pnpm run test:docs` both exit 0 on a clean `main`.
   Today: 15 test failures and 2 gate failures.
2. **CI actually runs.** Open an MR with a one-line change; confirm a pipeline is created and that
   `ci-static`, `ci-coverage`, `ci-snapshot`, `ci-consumers`, and the Windows lane all report.
3. **CI actually catches things.** In a throwaway MR, separately: delete a line from a covered
   function (must fail `ci-coverage`); change a tool description (must fail the snapshot lane);
   edit a `README.md` without its `.i18n.yaml` (must fail the pre-commit hook *and*
   `verify-translation-pairing`); add a package group without regenerating the listing (must fail
   the new gate); delete a `run-gates.ts` lane's CI job (must fail `verify-ci-lane-coverage`).
4. **Approval works.** Boot the shipped `headless` profile under `read-only` + `ask`, call `bash`,
   assert an `approval/asked` + `approval/decided` pair in the session log. Today no such pair can
   be produced.
5. **Every tool is bounded.** A test enumerating `ctx.tools` on the shipped tree asserting each
   entry resolves to a finite deadline; and a tool with no declared `timeoutMs` times out at the new
   default.
6. **Sandbox parity.** One parametrized test asserting each backend's and the fs fence's writable set
   equals the declared reduction of `writableRoots()`. Today bwrap, landlock, windows-acl, and the
   fence disagree four ways.
7. **One instruction source per directory.** A test asserting the assembled instruction baseline for
   this repo root contains exactly one source. Today it contains two, one of which is nine bytes of
   noise.
8. **Prompt cost is capped.** A byte ceiling asserted per `snapshots/**/system-prompt.expected.md`;
   watch `both-mode-turn` fall from 36,783 bytes.
9. **Docs are fast.** `verify-md-links --since origin/main` under 3s on a one-file change, agreeing
   with the full scan on a seeded broken link.
10. **Behavioural backfill.** New tests asserting the *live-scheduler* `TOOL_OUTCOME_UNKNOWN` closers
    (not the crash-recovery path), attempt-id uniqueness across resume, and the
    `'Turn failed and its turn/end boundary was rejected'` `AggregateError` — the three `dcd9a82`
    behaviours currently executed but unasserted.
