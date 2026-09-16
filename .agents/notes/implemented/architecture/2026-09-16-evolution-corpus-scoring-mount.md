# Agent Note: Mounting corpus scoring and offline optimization

Status: implemented

English | [中文](2026-09-16-evolution-corpus-scoring-mount.zh.md)

## Problem

Two packages of the evolution family — `evolution-scorer`, which turns one recorded corpus scenario into the metric triple an optimizer selects on, and `evolution-optimizer`, which rewrites a skill body and stages the winner — were mounted by no profile. `/curator optimize <skill> <scenario...>` and `/curator experiments [skill]` are shipped in `command-evolution`, and both gate on `ctx.get('evolutionOptimizer')`, so in the product they could only ever answer "The evolution optimizer is not mounted." The gap was not a missing row: the scorer requires a corpus directory and the optimizer requires the agent composition each scoring attempt boots, and neither value exists in a shipped profile.

Investigating what a scoring attempt needs exposed a second, sharper defect. The optimizer stages a variant body into a temporary `DSH_HOME` and scored it by passing that home through the child environment — but the recorded-replay runner builds its own environment *after* layering the caller's, so `DSH_HOME` was overwritten and every attempt booted the workspace home: a run would have scored the user's live skills and promoted the winner on that reading. The attempt also had no way to name the profile it boots, so it could only launch a fake bin with its own config grammar, never the real `dsh` entry.

## Decision

1. **The two rows ship in the Web composition, off.** `packages/bundle/web-app/cordis.patch.yml` carries `evolution-scorer` and `evolution-optimizer` with `disabled: true`, alongside the rest of the family. What they need is deployment data — which recorded scenarios exist, and which profile, patch, source bin, and tsconfig an attempt boots — and a shipped profile cannot invent it; the same rows also cannot be useful without it, because a corpus root that does not exist fails every evaluation loudly.
2. **An example overlay is the supported way on.** `apps/cli/config/examples/evolution-optimize/cordis.yml` enables both rows with a checkout's own values, next to the `schedule` and `mcp-memory` examples that teach the same opt-in shape. Applying it turns `/curator experiments` into a ledger read and `/curator optimize` into a full run; the comment above the rows names the credential and the trigger the verb then needs.
3. **`agent.profile` becomes a validated optimizer field.** `AgentUnderTest` already carried `profile`, and the launcher uses it to boot `--profile <name> --patch <path>`; without it the launcher passes `--config <path>`, which only a test bin's own grammar accepts. The optimizer's `agent` config now exposes it, so a real deployment can boot a real attempt.
4. **The attempt's home is a harness option, not an environment entry.** `RunOptions.homeDir` (and `AcpTestLaunchOptions.homeDir`) name the child's `DSH_HOME`, defaulting to `<cwd>/.dsh`, and `overlayRunner` passes the staged home through it. The harness stopped setting `DSH_HOME` from the caller's `env` at all: one owner for the value, and an overlay that cannot be silently overwritten.
5. **A composition test pins the wiring.** `apps/cli/tests/evolution-optimize-composition.spec.ts` composes the real bundle layers plus the overlay through the boot's patch algorithm and asserts both rows are shipped off, are enabled by the overlay, and resolve (`!!js` evaluated against a stubbed `process`) to the corpus, bin, patch, profile, and tsconfig it documents.

## Alternatives considered

- **Mounting both rows enabled with repo paths.** Rejected: a shipped profile serves installations, not checkouts, and `snapshots/acp` exists only in this repository. Enabled rows would either fail loud at the first `optimize` or, worse, look configured while pointing at nothing.
- **Deriving the attempt composition from the running app** (its own bin path, its profile, its patch layer). Rejected: it makes the scored process an implicit function of wherever the host happens to run — against the repository rule that a package boundary exposes what it needs instead of defaulting it.
- **Giving the optimizer a corpus of its own under `$DSH_HOME`.** Rejected: the corpus is recorded evidence produced elsewhere (by the snapshot suite, or by a deployment's own harness), so a default directory would be empty at best and misleading at worst.
- **Letting the overlay only insert the rows** rather than flipping shipped ones. Rejected: the family's inventory belongs in one composition file a reader can audit, and the `disabled: true` row is how the repository already ships dormant capabilities (`budgets`, `ui-schedule`, `skill-badge`).
- **Passing the overlay home as `pathPrependedEnv`-style configuration instead of a harness option.** Rejected: the home is a lifecycle input the harness owns — it creates the directory's siblings, pins the sessions root, and ignores `.dsh` when capturing the workspace — so an environment override the harness then replaces is the bug this note fixes.
- **Recording a scored attempt as a scenario-level replay.** Deferred: the corpus is already replayed keylessly and the scorer never records, so nothing needs a new recording path; a deployment wanting more scenarios adds directories to its corpus.

## Consequences

The family's commands reach a real optimizer when a deployment opts in, and both the wiring and the values it resolves are pinned by a test. Four costs are stated in the package READMEs: the rows stay invisible until a profile enables them, an attempt boots a whole profile per scenario (slow, and it needs a credential for the mutation route), a variant is scored in a home that is not the user's, so a skill that depends on sibling files outside its SKILL.md still mis-scores, and the corpus root must exist before the first evaluation rather than degrading to "no scenarios".

Verification: the composition spec above (shipped-off, overlay-enabled, resolved values), 79 optimizer tests with the overlay home reaching the runner, and the session-snapshot suite's attempt-home test driving the REAL spawn path and reading the child's `DSH_HOME` back out of its env probe.
