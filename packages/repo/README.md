---
description: "The repo package group map: the bounded repository index derived from a workspace root, for readers choosing or navigating the family."
kind: "package-group"
---

# packages/repo

English | [中文](README.zh.md)

## Summary

The repo group turns one workspace root into repository facts a consumer can query: the walked tree, declaration symbols, module specifiers, the references between declarations, and the test, package/dependency, and configuration graphs derived from them. `dsh-repo-index` owns that bounded, lazily built snapshot and its per-root cache (`ctx.repoIndex`); the packages in other groups that rank, render, or embed those facts own every consumer-facing use. The index re-reads only when the walk's freshness digest changes or a caller invalidates it, and it registers no tool, command, or prompt of its own.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

One package produces the repository facts; every other repo-derived view belongs to the consumer that renders it.

| Package | Role | ctx key |
|---|---|---|
| [`repo-index`](repo-index/README.md) | Bounded, lazily built index of one workspace root: tree paths, declaration symbols, module imports, symbol references, and the test, package/dependency, and configuration graphs, cached per root | `ctx.repoIndex` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Filesystem subsystem](../../docs/subsystems/filesystem.md) — the resolved-target identity, directory metadata, and freshness token the walk reads through `ctx.fs`.
- [`dsh-repo-map`](../context/repo-map/README.md) — the context package that ranks a snapshot against the session objective and injects the compact map.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repo-index) — every accepted config field of the index and its source declaration.
- [Packages map](../README.md) — the group table this family appears in.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
