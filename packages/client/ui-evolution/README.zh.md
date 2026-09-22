---
description: "演进历程页面及其基于每个作用域演进记录的 Host evolutionCurator 状态 Remote 面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-evolution

[English](README.md) | 中文

## 概述

查看某个作用域记录到的演进，并对等你决定的待审写入作出裁决：按可切换的时间窗口（今天、7 天、30 天、全部）看读模型能证明的每日桶——指令、经验与画像的写入、上下文附件、产出文件、待审写入以及按日统计的决策——并排呈现等待决定的待审写入、该作用域当前的经验（按置信度从高到低渲染）、整理器记录到的运行，以及简报相对记录上限的已用字节。批准或拒绝一条待审写入，它那一行就地退役。把它挂在 web composition 中；编辑指令、经验与画像仍是 CLI 的活。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在 `web-app` bundle 中把本行挂在演进 Host 行与控制器旁边。页面是一个全局面板：侧边栏行（`sidebar.panellist` 列表 id 为 `evolution-journey`）选中中央轨道同名的 `main` keyed 面板，因此该界面是增量式的——既不替换会话，也不争用工作区页面独占的 `shell.page` 席位。

面板以当前所选会话的工作区作为作用域。没有会话，或工作区注册表已不再列出该会话时，它渲染无作用域状态，而不是一列空白。已批准或已拒绝的待审写入会通过控制器按标识清除，并重新拉取时间线，使每日计数同步。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

不发布不变式伴随文件：Host 面只是投影已挂载的整理器，不持有独立状态。

### Design concept

浏览器侧读取两个 Remote 命名空间：控制器的 `evolution`（作用域读取、待审决定、历程时间线以及 follow 流）和本包的 `evolutionCurator`（整理器记录到的运行，外加今日缓存命中率与技能失败率汇总）。follow 流在每个世代给出恰好一份完整基线，并在作用域记录发生持久变更时给出一次 upsert，因此后台抽取或一次批准无需重新拉取即可落地；页面自身的记录投影携带待审列表，使决定在控制器应答的同一步内清除对应行。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 基于已挂载整理器的 Host `evolutionCurator` 状态面 |
| [`src/types.ts`](src/types.ts) | 浏览器安全的 Remote 词汇表 |
| [`src/client/index.ts`](src/client/index.ts) | 侧边栏面板行、中央轨道面板与字典 |
| [`src/client/rpc.ts`](src/client/rpc.ts) | 会抛错的页面动词与 follow 订阅 |
| [`src/client/Seat.tsx`](src/client/Seat.tsx) | 面板行图标与会话到作用域的映射 |
| [`src/client/Page.tsx`](src/client/Page.tsx) | 页面：时间线、待审决定、整理器、容量 |
| [`src/client/locales.ts`](src/client/locales.ts) | 类型化字典 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [演进 harness 子系统](../../../docs/subsystems/evolutionary-harness.zh.md) — Host 侧实现的行为契约。
- [演进式 Harness 子系统](../../../docs/subsystems/evolutionary-harness.zh.md) — 本家族的行为与本页面背后的历程读模型在此描述。

-----

<a id="model-experience"></a>
## Model Experience

无，因为历程页面及其整理器状态面只读取已记录的演进状态与整理器计数；本包渲染的任何内容都不进入模型请求。

#### KV Cache effect

与在线请求无关：本包从不触碰请求前缀，因此不会破坏 provider 的缓存复用。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **仅限 Web** —— 该页面存在于 web composition；其他 profile 没有对应界面。
- **没有历程导出与 web scenario** —— 规范中的 ZIP 导出与 `snapshots/web/evolution-journey` scenario 不在本切片范围内；用户已豁免快照工作，因此改为在真实界面上验证该页面。
- **整理器卡片读取运行记录与两个比率** —— 今日缓存命中率与技能失败率汇总，来源未挂载或无负载时各自隐藏；变更明细、回滚与合并报告仍属 CLI 界面。
- **简报只读** —— 页面展示已用字节与摘要；指令、经验与画像的编辑在页面长出这些编辑器之前仍由 CLI 负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

页面刻意占用 `main` keyed 面板而非 `shell.page`：`shell.page` 是已被工作区页面占用的单占席位，两个条件性占用者会双向冲突。

</details>
