---
description: "Bounded, lazily built repository index of one workspace root: the walked tree, declaration symbols, module imports and symbol references, and the derived test, package/dependency, and configuration graphs, with the cache freshness rule and every bound (ctx.repoIndex), for maintainers of the packages that embed repository facts."
kind: "package-reference"
---

# @deepseek-ai/dsh-repo-index

English | [中文](README.zh.md)

## Summary

`dsh-repo-index` turns one workspace root into a bounded snapshot: walked paths, declaration lines, each module specifier with how it resolved, declaration references, the tests that cover a file, the packages and dependencies the tree declares, and the configuration each plugin declares and reads. `ensure()` re-walks directory metadata and returns the cached snapshot while the freshness digest holds; `invalidate()` forces a rebuild. `maxFiles`, `maxFileBytes`, `maxSymbols`, `maxEdges`, and `maxRoots` bound one build. Extraction is line-oriented, every unresolved relation is reported unresolved rather than guessed, and nothing calls a model.

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

Mount the plugin wherever a consumer needs repository facts; it injects `fs` and registers `ctx.repoIndex`, and its cache dies with the fiber it was mounted on.

```ts
const snapshot = await ctx.repoIndex.ensure(workspaceRoot)
snapshot.symbols      // declaration lines, at most maxSymbols
snapshot.imports      // one edge per distinct specifier, with how it resolved
snapshot.references   // declaration-to-declaration name matches, at most maxEdges
snapshot.tests        // every test file and the files it covers
snapshot.packages     // every manifest and the dependencies it declares
snapshot.configs      // every configuration declaration and its fields
snapshot.configReads  // every configuration field a file reads
snapshot.stats        // { indexed, skippedLarge, capped }
ctx.repoIndex.invalidate()
```

`ensure(root, signal?)` resolves the root through `ctx.fs`, walks its directories, and returns the snapshot; a root whose walk digests the same `fingerprint` returns the identical cached snapshot without reading any file's text. `invalidate()` drops every cached snapshot, so the next `ensure()` walks and reads again.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-repo-index'
  config:
    maxFiles: 20000
    excludeDirs: [node_modules, .git, lib]
```

|Field|Default|Meaning|
|---|---|---|
|`maxFiles`|`10000`|Maximum tree entries one walk returns; the walk stops at this many and reports `capped`|
|`maxFileBytes`|`262144`|Maximum bytes of one file's text the index reads and derives facts from|
|`maxSymbols`|`20000`|Maximum declaration symbols retained across the index|
|`maxEdges`|`40000`|Maximum symbol references and configuration-read edges retained across the index|
|`maxRoots`|`4`|Maximum workspace roots whose snapshot stays cached; the least recently used root is dropped|
|`excludeDirs`|`['node_modules', '.git', 'lib', 'dist', 'coverage', '.sessions']`|Directory basenames the walk never descends into|
|`extensions`|`['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']`|File extensions whose text is read; a leading dot is optional|
|`testFileSuffixes`|`['.spec.', '.test.']`|File-name fragments that make one path a test file for the test graph|
|`testDirs`|`['tests', '__tests__']`|Directory basenames the test graph reads as holding test files|
|`sourceDir`|`'src'`|Directory basename a test directory maps to when a test covers source by path convention|
|`manifestNames`|`['package.json']`|Basenames whose JSON text the package graph reads as a package manifest|

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-repo-index) is the exhaustive source for every accepted field and its source declaration.

### Derived graphs

Four members report relations a consumer would otherwise re-derive, and each names how it was derived so a heuristic is never presented as a resolved fact.

- **Test graph.** One `tests` node per indexed test file. `covers` holds one entry per covered file: `via: 'import'` is direct evidence, because the test's own import resolved to that file; `via: 'naming'` is the path convention alone — the same name with the test fragment dropped, or a `tests`/`__tests__` directory replaced by `sourceDir`. A test of code the index does not hold reports `covers: []` rather than a guess.
- **Package/dependency graph.** One `packages` node per manifest the walk returned, with one dependency edge per declared range in `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies` order, `scope` naming that section. `to` is the manifest path of the workspace package whose `name` matches the declared dependency; an external dependency has no `to`.
- **Configuration graph.** One `configs` node per top-level `const` or `interface` whose binding name ends in `Config`, listing the fields at the first level of its block with `derivedFrom: 'schema'` or `'interface'`. One `configReads` edge per `config.<field>` or `config['<field>']` occurrence, capped by `maxEdges`.
- **Symbol references** carry `via`: `'call'` when the referring declaration's block writes the name as a call or construction, `'mention'` when it only names it, such as a type annotation.

Every module edge carries its `resolution`. `indexed` carries `to`; `workspace-package` carries the package name a bare specifier matched — the manifest's `exports` map, which the index does not read, decides the file; `external` is a bare specifier no indexed manifest names; `unresolved` is a relative specifier that names no indexed file.

### Observable behavior and failures

An invalid bound fails plugin load: each numeric bound must be a positive safe integer, `excludeDirs`, `testFileSuffixes`, `testDirs`, and `manifestNames` must each name at least one value, `sourceDir` must not be empty, and `extensions` must name at least one extension and stay unique after lowercasing. `stats.capped` is true when `maxFiles` stopped the walk or `maxSymbols`/`maxEdges` cut the graph, and `stats.skippedLarge` counts files whose reported or actual UTF-8 byte length exceeded `maxFileBytes`. A file that vanished, is permission-denied, or fails to decode since the walk is left out of the index rather than failing the whole build, and a manifest whose text is not a JSON object contributes a named-by-nothing package node rather than failing the build. A signal aborts the walk and the reads it started.

A backend that reports no version token for an entry contributes that entry's size alone to the freshness digest, so a same-size edit is invisible to `ensure()` until a caller invalidates the index.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **Facts from lines, not from a parser.** Declarations, module specifiers, reference name matches, and configuration fields are line-oriented matches, so the index has no parser dependency and no language-specific resolution to keep current.
- **One walk, then one bounded read pass per file.** The walk reads directory metadata only and never file text; the build reads each indexable file once for symbols, imports, and configuration and again for header-block references, reads each manifest once for its package facts, and decides from the reported size before each read.
- **Freshness is a digest of the walk.** The cache key is the resolved root's target identity and the value is the snapshot; `ensure()` compares the snapshot's fingerprint, so a cache hit costs directory listings and no content read.
- **A bound truncates the snapshot, never the process.** Hitting `maxFiles`, `maxSymbols`, or `maxEdges` stops the walk or the pass and reports `capped` instead of loading the whole tree.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `RepoIndex`, config validation, the root cache, and the bounded build |
| [`src/walk.ts`](src/walk.ts) | The bounded directory walk and the freshness digest |
| [`src/extract.ts`](src/extract.ts) | Line-oriented declarations, specifiers, header references, configuration declarations, and specifier resolution |
| [`src/graphs.ts`](src/graphs.ts) | The test, package/dependency, and configuration graph derivations |
| [`src/types.ts`](src/types.ts) | The snapshot, graph, symbol, edge, and stats vocabulary |

### Main flow

`ensure()` calls `walkRepository`, which resolves the root, lists each directory at most once in code-unit basename order, skips excluded basenames and already-visited directory targets, and stops at `maxFiles`. A cache hit on the walk's fingerprint returns the stored snapshot; otherwise the build reads each manifest under `maxFileBytes` for its package facts, reads each indexable file for declarations, configuration, and queued specifiers, and then resolves each specifier against the indexed paths — trying the specifier as written, its suffix variants and `index.*` forms, and the TypeScript source behind a `js`-family extension — and against the indexed package names for a bare specifier. The reference pass re-reads each indexed file, matches the identifiers in every declaration's header block against indexed symbols of the same name, marks an edge a call when the block calls that name, drops self-edges, and stops at `maxEdges`; the test graph then joins the resolved imports with the path convention over the same indexed paths. A file whose read fails is skipped, so one unreadable file cannot fail the build.

### No invariant companion

No runtime invariant companion is published because the snapshot is a bounded projection of the filesystem that the next `ensure()` re-derives: there is no independently stored copy of this state for an invariant to compare against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — target identity, directory metadata, and the freshness token the walk reads through `ctx.fs`.
- [`dsh-repo-map`](../../context/repo-map/README.md) — the consumer that ranks a snapshot against the session objective and injects the compact map.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-repo-index) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-repo-map`, every model-visible repository map is rendered from the snapshot this service returns; the index registers no prompt, tool, or session event of its own.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected; the reuse conditions of the map rendered from this snapshot belong to `dsh-repo-map`.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this index is a poor fit. They are current package constraints.

- **Line facts, not a parse** — a declaration split across lines, a computed import specifier, a computed configuration key, and an identifier inside a string, comment, or object literal are not recognized. A consumer needing a real type or call graph needs a parser-backed tool.
- **A reference is a name match** — `via` reports whether the referring block calls the name (`'call'`) or only names it (`'mention'`), but neither resolves scope, overloads, aliases, or types, so two declarations that share a name each get their own edge and a call through an alias gets none.
- **A bare specifier resolves to a package, not a file** — `workspace-package` names the matched manifest, because the manifest's `exports` map decides the entry file and the index does not read it; a tsconfig path alias or a specifier matching no package name stays `external`.
- **A test-subject edge can rest on the path convention** — `via: 'naming'` reports a subject the test never imports, so a test whose subject moved still lists the old path while a test that exercises a differently named file reports nothing.
- **The configuration graph reads `*Config` bindings and `config.` reads only** — a plugin that reads its configuration through a destructured local, and a repository that declares configuration in YAML or JSON, contribute no node or edge.
- **Freshness depends on the backend's version token** — an entry whose backend reports no token contributes size alone, so a same-size edit stays invisible to `ensure()` until `invalidate()`.
- **Bounds truncate silently** — `capped` reports that a bound cut the result but names neither the dropped file, symbol, nor reference, and `skippedLarge` counts oversized files without naming them.
- **Exclusion is by basename at any depth** — a source directory named `lib` or `dist` is skipped wherever it appears in the tree, not only at the root.
- **The cache is per plugin fiber and per process** — snapshots live in the instance and are never persisted, so a second mount or restart walks and reads again.
- **Only whole files are indexed** — a file over `maxFileBytes` contributes no symbol, import, reference, test, or configuration fact at all; the index has no partial-file read.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The walk sorts each listing with a code-unit basename comparator so that two machines with different filesystem orderings produce the same `entries` sequence, and it keeps a `visited` set of target identities so a backend that surfaces a directory link cannot make the walk revisit a subtree. The digest hashes `path`, `version`, and `size` per entry, which is why a backend without version tokens can only detect size changes.

The build checks `maxFileBytes` twice: once against the reported size before reading, and once against the UTF-8 byte length of the text it got back, because a backend may report a size that differs from the decoded text. The reference pass re-reads the files rather than retaining their text, so peak memory holds one file's text rather than the whole tree's.

</details>
