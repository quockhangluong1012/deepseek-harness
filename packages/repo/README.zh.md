---
description: "repo 包组概览：从工作区根目录派生出的有界仓库索引，供选择或浏览本组的读者阅读。"
kind: "package-group"
---

# packages/repo

[English](README.md) | 中文

## 概述

repo 组把单个工作区根目录变成消费方可查询的仓库事实：遍历得到的树、声明符号、模块说明符、声明之间的引用，以及由它们派生出的测试图、包/依赖图与配置图。`dsh-repo-index` 负责这份有界、惰性构建的快照及其按根目录的缓存（`ctx.repoIndex`）；其他组中负责排序、渲染或嵌入这些事实的包负责所有面向消费方的用法。索引仅在遍历的新鲜度摘要变化或调用方使其失效时重新读取，且它自身不注册工具、命令或提示词。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

只有一个包产出仓库事实；其余一切由仓库派生的视图都归渲染它的消费方所有。

| 包 | 职责 | ctx key |
|---|---|---|
| [`repo-index`](repo-index/README.zh.md) | 单个工作区根目录的有界、惰性构建索引：树路径、声明符号、模块导入、符号引用，以及测试图、包/依赖图与配置图，按根目录缓存 | `ctx.repoIndex` |

-----

<a id="related-documentation"></a>
## 相关文档

- [文件系统子系统](../../docs/subsystems/filesystem.zh.md)——遍历经 `ctx.fs` 读取的解析目标标识、目录元数据与过时令牌。
- [`dsh-repo-map`](../context/repo-map/README.zh.md)——把快照按会话目标排序并注入紧凑地图的 context 包。
- [生成的配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-repo-index)——索引的每个受支持配置字段及其源声明。
- [包地图](../README.zh.md)——本系列所在的组表格。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
