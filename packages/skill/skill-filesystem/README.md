---
description: "The local filesystem skill provider for users and maintainers authoring local skills or configuring how project, custom, and user skill roots are discovered and watched."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-filesystem

English | [中文](README.zh.md)

## Summary

Agents can use local skills from the repository, a custom directory, or the user's agent configuration: author a skill as a directory bundle with a `SKILL.md` or a flat `<name>.md` file under any scanned root, and it appears in the session catalog. The provider discovers the project, custom, and user roots, parses each skill's YAML frontmatter, gates each skill on the platform and tools it declares, security-scans project skills before indexing them, and watches the directories, so new, renamed, or deleted skills reach agents without a restart. Choose it when skills live on disk — the registry (`dsh-skill`) accepts any provider, and another provider can supply skills from elsewhere.

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

Mount the plugin to make local skills available to agents. It scans the project, custom, and user skill roots below, parses each skill's frontmatter into a catalog entry, and loads the body on demand; it also watches the roots so new, renamed, or deleted skills reach the next catalog without a restart.

### When to choose it

Use this provider when skills live on disk — in the repository, a custom directory, or the user's agent configuration. Avoid it when skills come from a remote registry or embedded plugin data: the registry accepts any provider, and this package is one implementation.

### Skill format

A skill is either a directory bundle `<name>/SKILL.md` or a flat file `<name>.md` at the top level of a scanned root; nested `**/SKILL.md` files are deliberately not discovered. The file starts with YAML frontmatter: required `name` and `description`, plus optional `whenToUse`, `metadata`, `disable-model-invocation`, `user-invocable`, `required_env` (a non-empty list of environment variable names the skill needs), `config` (a mapping whose scalar values are stored as their string forms), and the [gating keys](#platform-and-tool-gating) below. Every other top-level key is ignored with one warning naming the file and the key, and a recognized key with a malformed value — an empty `required_env`, a non-string entry, a `config` that is not a mapping, a `config` value that is not a scalar, an empty list where a non-empty one is required, or a `blueprint` missing its schedule, deliver mode, or prompt — is dropped with one warning naming the file and the key; the skill still loads either way.

`disable-model-invocation: true` keeps the skill out of model-facing catalogs and loaders; `user-invocable: false` keeps it out of human-facing commands, and omitted fields default to permitting their surface. The two keys accept YAML booleans plus the case-insensitive `true`/`false`, `yes`/`no`, `on`/`off`, and `1`/`0` forms; a rejected spelling or a non-boolean value drops the whole skill with a warning rather than silently permitting a surface.

Catalog entries and loaded skills expose the resolved instruction-file path, so symlinked directories and flat files can open as regular-file previews. Reload locators and resource bases retain the discovered paths, including symlinks.

The catalog and the body have separate lifecycles: discovery parses frontmatter into the catalog entry, and every load re-reads the current file, so editing a skill body needs no versioning or cache invalidation.

### Platform and tool gating

Optional frontmatter gates whether a skill is offered at all; a gated-out skill reaches no model or command catalog, so it cannot be loaded by name either.

| Key | Shape | Effect |
|---|---|---|
| `platforms` | non-empty list of platforms | Offered only when one entry names the running platform |
| `requires_tools` | non-empty list of tool names | Offered only when every named tool is mounted |
| `requires_toolsets` | non-empty list of toolset names | Offered only when every named toolset is mounted |
| `fallback_for_tools` | non-empty list of tool names | Hidden while any named tool is mounted |
| `fallback_for_toolsets` | non-empty list of toolset names | Hidden while any named toolset is mounted |
| `blueprint` | mapping with `schedule`, `deliver` (`session` or `file`), and `prompt` | Parsed for install-time schedule suggestions; nothing schedules itself |

Platform matching accepts the `process.platform` spelling and its agentskills.io alias (`darwin`/`macos`, `win32`/`windows`), case-insensitively. A toolset is addressed by the name prefix its tools share, so `requires_toolsets: [web]` is satisfied by any mounted `web_*` tool. A `fallback_for_*` pair is how a skill says "use me when the tool I stand in for is missing": the primary `requires_*` skill and the fallback swap places as that tool appears and disappears. A composition that mounts no `ctx.tools` registry hides every `requires_*` skill and offers every `fallback_for_*` skill. A malformed value is dropped with one warning and the skill keeps loading; a gated-out skill is skipped silently.

### Roots and priority

Default roots are scanned in this provider's rank order:

| Rank | Source | Path |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 150 | `project-hermes` | `<projectRoot>/.hermes/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |

The project root is the nearest ancestor containing `.git`; without one, the current cwd is used. Project roots index only when explicitly trusted: list absolute project roots in `trustedProjectDirs` (compared as resolved paths, case-insensitively on Windows; relative entries fail loudly at load), or set `projectDiscovery: false` to disable project discovery entirely. Skills under an untrusted root are skipped with one warning per root, and trust is configuration — non-interactive surfaces inherit it and never prompt. Every project skill is security-scanned before it is indexed, and dangerous content quarantines it: the skill is skipped, the host log names the matched rule, and the count travels on the `quarantinedCount` payload of `skills/change`. Quarantine is a host-side fact — the model catalog never receives a quarantine diagnostic, and a quarantined skill cannot be loaded by name. The scan covers project-owned roots only; `custom`, user, and bundled roots are harness-owned and index unscanned. The user DSH root skips its `.system` child. `includeDefaultRoots: false` omits the project and user rows plus the `$DSH_BUNDLED_SKILL_DIR` default so an isolated provider sees only its own configured roots; `bundledSkillDir` adds a bundled root at rank 600.

### Project skill scanning

Four lexical rules quarantine a project skill before it can be indexed:

| Rule | Matches |
|---|---|
| `pipe-to-shell` | A `curl` or `wget` download piped into a shell |
| `encoded-shell` | A `base64` decode piped into a shell |
| `root-delete` | An `rm` with recursive and force flags aimed at `/`, `~`, or `$HOME` |
| `credential-exfiltration` | A credential store (`~/.ssh`, `id_rsa`, `.aws/credentials`, `gh/hosts.yml`, `/etc/shadow`) read alongside a network request |

The rules are deliberately conservative, so an ordinary skill that merely mentions a command is not quarantined. A verdict is cached in this provider instance against the resolved file path and its modification time: an unchanged file is not rescanned, and a rewritten one is.

### Mount and configure

Load the plugin alongside the skill registry; it requires `ctx.skills`.

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
```

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `filesystem` | Unique provider name registered on `ctx.skills` |
| `includeDefaultRoots` | `true` | Include project and user roots around `customSkillDirs` |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness config root; its `skills` subdirectory is scanned |
| `agentsHome` | `$DSH_AGENTS_HOME` or `~/.agents` | Shared agent config root scanned for compatible skills |
| `customSkillDirs` | `[]` | Additional local skill roots, after project roots and before user roots |
| `trustedProjectDirs` | `[]` | Absolute project roots whose project skills index; all other project roots are skipped |
| `projectDiscovery` | `true` | Index project roots at all; `false` disables project discovery entirely |
| `watch` | `true` | Watch local roots and invalidate the provider when the catalog may have changed |
| `bundledSkillDir` | — | Bundled skill root scanned at rank 600 when configured |

The remaining `watch*` fields tune Chokidar behavior — polling, stability window, interval, project cap, and symlink following. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-skill-filesystem) is the exhaustive source for every field.

### Change detection

Existing roots are watched, so adding, renaming, or deleting a skill (or editing its frontmatter) triggers a catalog refresh for the next model step; edits below `references`, `scripts`, `assets`, and other bundle resources do not. The first-party `write` and `edit` tools invalidate the provider directly when their target could affect a watched skill, so the model observes its own filesystem mutation without waiting for the host watcher. External IDE, Git, and shell changes are picked up by the host watcher, and a root that does not exist yet is probed until it appears.

### Observable success and failures

A valid skill under any scanned root appears in the session catalog sorted by name, and loading it returns the current file body. A file without valid frontmatter, an invalid name, or an invalid invocation value is skipped with a warning, so the model catalog receives no per-skill diagnostic and cannot distinguish an absent skill from an invalid one. A project skill that fails the security scan is quarantined the same way — absent from every catalog and unloadable by name — while the host log carries the matched rule and `skills/change` carries the count. Unexpected discovery or read failures leave the catalog observation incomplete rather than replacing the last-good view with a misleading deletion.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how discovery and watching are organized; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The provider is built on two separations. First, catalog versus body: discovery parses frontmatter into summaries, while every load re-reads the file, so body edits need no hash, revision, or cache invalidation. Second, discovery versus watching: `list()` scans roots and resolves the project root through `ctx.fs` when a filesystem service is present (falling back to abortable Node I/O), while a separate watch manager owns Chokidar handles, missing-root probes, and invalidation.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, provider, root resolution, frontmatter parsing, watch manager |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Discovery flow

Discovery resolves the root list for the lookup cwd, asks the watch manager to attach to each root, then scans each root's direct entries: directory bundles resolve `<name>/SKILL.md`, flat files resolve `<name>.md`. Each file is parsed for frontmatter — `name` must be kebab-case, `description` is required, and the invocation keys resolve through the strict boolean grammar — then gated against the running platform and the mounted tools, then security-scanned for project-owned roots, and only then pushed as a candidate carrying the root's source label and rank so the registry can merge them with other providers. Confirmed missing paths are valid empty state; malformed or non-text entries warn and skip.

### Watching and invalidation

Existing roots are watched by Chokidar at depth 1; a root that does not exist is followed from its nearest existing ancestor one missing segment at a time using `fs.watchFile`. Relevant events — direct bundle add/remove, flat `.md` add/remove, and direct `SKILL.md` add/remove/change — coalesce into one provider invalidation per microtask batch, while resource-subtree changes are ignored. The watch manager is bounded by `watchMaxProjects`, logs and retries failed startup, and closes every handle at teardown. First-party `write`/`edit` mutations invalidate synchronously through the `fs/observed` event.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the registry contract to the consumer that renders discovered skills and the home-path resolution used by the config defaults.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry contract and the local discovery priority table.
- [skill package](../skill/README.md) — the registry this provider registers on.
- [tool-skill package](../tool-skill/README.md) — how discovered skills reach the session catalog and the model.
- [home-paths package](../../util/home-paths/README.md) — how `dshHome` and `agentsHome` resolve.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which renders this provider's invocable names and capped descriptions into the initial or replacement catalog and a selected current instruction body plus resource-base guidance into retained tool history while paths, provider ranks, and disabled skills remain hidden.

#### KV Cache effect

Watcher invalidation can cause the named consumer to append a replacement catalog to the existing request history. Body-only edits leave the catalog digest unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Discovery is one level deep** — only `<root>/<name>/SKILL.md` and `<root>/<name>.md` are recognized; nested skill trees and package manifests are ignored.
- **Project skills need explicit trust** — discovery never prompts: an unlisted project root contributes nothing, and there is no interactive trust-on-first-use. Trust changes arrive through configuration, not through the model.
- **The security scan reads only `SKILL.md`** — a bundle's `references`, `scripts`, `assets`, and other resource files are not scanned, and the rules are lexical, so an obfuscated payload passes. Quarantine is a conservative first filter, not a sandbox.
- **Scan verdicts are process-local** — the path-and-modification-time verdict cache lives in this provider instance and persists nothing across restarts, so a fresh process rescans every project skill.
- **Gating needs the tool registry** — `requires_*` and `fallback_for_*` read whatever `ctx.tools` is mounted at discovery time, so a composition without that service hides every `requires_*` skill; a `requires_toolsets` entry is satisfied by the name-prefix convention (`web` ← `web_search`), which a tool naming scheme that shares no prefix cannot express.
- **Project scope is the nearest `.git` ancestor** — workspaces without that marker fall back to the supplied cwd, with no alternate project-root marker or monorepo subproject selection.
- **Malformed entries disappear with a warning** — the model catalog receives no per-skill diagnostic and cannot distinguish an absent skill from an invalid one; unexpected I/O failures preserve the last-good catalog instead.
- **Missing-root observation polls one path segment** — roots absent at startup use `fs.watchFile` at `watchPollIntervalMs` until Chokidar can attach, trading bounded detection latency for reliable creation detection across IDE, Git, and shell workflows.
- **No body revision protocol** — a loaded body is ordinary retained tool history; later file edits affect later calls but neither rewrite old results nor announce that the body changed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the code. A TODO in `src/index.ts` proposes extracting the Chokidar and missing-root observation into a Cordis file-watch service, keeping skill filtering and invalidation here; the missing-root polling tradeoff documented above is part of that open design.

</details>
