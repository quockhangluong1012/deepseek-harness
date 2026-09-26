---
description: "注入模型请求上下文的、按相关性排序且有字节上限的仓库地图：把仓库索引按会话目标排序，并在地图变化时注入这张紧凑图，供启用、限定或调试仓库上下文的维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-repo-map

[English](README.md) | 中文

## 概述

`dsh-repo-map` 给模型一张紧凑、按相关性排序的工作区源码树地图：把仓库索引按当前任务目标排序，保留最佳符号及其最佳关联符号，并在地图变化时把渲染结果作为一条持久、替换前者的快照注入。`maxBytes`、`maxNodes` 与 `maxEdgesPerNode` 限定文本与排序范围。地图是索引指纹与目标的纯函数，因此目标与树都没变化的步骤不注入任何内容，请求前缀保持逐字节一致。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当模型应当在开工时就对源码树有所定位时，把本插件与 `dsh-repo-index` 一起挂载；它注入 `repoIndex`，每个会话的地图都派生自该会话的工作目录。

```yaml
- name: '@deepseek-ai/dsh-repo-map'
  config:
    maxBytes: 4096
    maxNodes: 24
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxBytes` | `4096` | 完整渲染地图文本的 UTF-8 字节上限（不含边界值） |
| `maxNodes` | `24` | 地图列出的排序符号上限 |
| `maxEdgesPerNode` | `4` | 每个符号下方列出的关联符号上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-repo-map)是每个受支持字段及其源声明的穷尽式真源。

### 模型能得到什么

每个合格步骤上，插件渲染地图并把它作为持久的 user 角色消息追加；提供排序词的目标是该步骤所见的最新一条用户撰写文本，包括该步骤刚认领的消息。地图未变化时不注入任何内容，模型继续读取上一份快照。会话没有工作目录，或索引没有任何符号时，完全不注入。

### 何时选择挂载

当会话在单个工作区根目录内工作、且模型需要知道哪些文件与符号对当前任务重要时挂载它。目标很少变化且树小到模型可直接阅读时，或已有其他上下文来源承载同样事实时，则跳过。地图自身的消费方是模型与上下文编译器；它不定义工具，也不定义命令。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

- **按变化注入，而非按步骤注入。** 监听器渲染地图、与会话上一份地图文本比较，仅在文本不同时追加消息，因此未变化的步骤保持请求前缀不变。
- **排序是固定的加权分数。** 目标词按符号名精确匹配与词匹配、声明路径的词匹配、上限之内的引用度数，以及声明种类计分；同分时按标识符、路径与行号排序，因此相同的索引与目标始终产出相同的地图。
- **一次渲染服务两个消费方。** pre-step 监听器把渲染文本按会话存入 `WeakMap`，可选的编译器注册读取它，而不再遍历第二次树。
- **上限作用于完整文本。** 渲染器只保留整行，因此被截断的地图始终是完整地图的前缀，且永不超过 `maxBytes`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置校验、pre-step 监听器与可选编译器注册 |
| [`src/rank.ts`](src/rank.ts) | 目标词、加权分数与确定性排序 |
| [`src/render.ts`](src/render.ts) | 地图文本及其按字节截断整行的逻辑 |
| [`src/types.ts`](src/types.ts) | 排序节点、选择上限与头部计数 |

### 主要流程

`agent/pre-step` 监听器先委托给下一个监听器，在拒绝或信号已中止时原样返回决策；随后解析会话工作目录，向 `ctx.repoIndex.ensure()` 取快照，快照没有符号时原样返回决策。否则它按目标对快照排序并渲染地图；文本与会话上一份相同时不改动决策，不同时则存入并把该文本作为 user 消息追加，其 `repo-map` 快照来源会替换上一份。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-repo-index`](../../repo/repo-index/README.zh.md)——本地图所排序的快照、符号与引用。
- [Agent-context 子系统](../../../docs/subsystems/agent-context.zh.md)——可选编译器注册所遵循的来源封装、放置位置与持久记录。
- [context 组地图](../README.zh.md)——相邻的请求上下文包。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-repo-map)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 持久的仓库地图快照

#### 模型看到的内容

地图以一条追加的 user 角色消息抵达模型，其文本即渲染出的地图。首行是下方逐字不变的头部，其下是每个排序符号一行、每个关联符号一行缩进，形如 `- <name> [<kind>] <path>:<line>` 与 `  -> <name> [<kind>] <path>:<line>`，最佳者在前。该消息携带来源 `{ kind: 'repo-map', form: 'snapshot', sections: [{ name: 'repo-map', text }], supersedes: true }`，因此它作为会话当前快照替换上一份地图。

##### 地图头部

```markdown
Repository map (ranked by relevance to the current task; <symbols> indexed symbols from <indexed> files, most relevant first):
```

#### Token 影响

有条件且有上限：地图未变化、会话没有工作目录、索引没有符号时都不注入；被截断的地图只保留整行，因此单次注入永不超过 `maxBytes` 字节（默认 4096）。

#### KV Cache 影响

前缀稳定：地图未变化时不追加消息，请求前缀保持逐字节一致，现有 KV Cache 条目继续可复用；地图变化时新内容追加在该前缀之后，而非改写它。

### stable-core 仓库地图产物

#### 模型看到的内容

挂载 `dsh-agent-context` 时，插件还会注册一个来源，其 producer 为 `repo-map`、kind 为 `artifact`、trust 为 `untrusted`、placement 为 `stable-core`，并使用同一个 `maxBytes` 上限；请求该来源的一次编译会收到与地图完全相同的文本，作为唯一条目 `{ id: 'map', text, relevance: 1 }`，取自 pre-step 监听器上次渲染的文本，或按需渲染。

#### Token 影响

有条件且有上限：编译请求该来源时，它贡献那一个条目；会话没有工作目录、索引没有符号或渲染为空时，则不贡献任何内容。

#### KV Cache 影响

独立于那条持久消息：索引指纹与目标不变期间，该来源重复发布相同文本；只有当 pre-step 监听器渲染出变化后的地图时，插件才刷新它提供的文本。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明地图何时不合适。它们是当前包约束。

- **排序是词法匹配**——目标提供的是至少三个字符的小写词项，因此只出现在任务文本、而未出现在标识符或路径中的同义词或缩写不计分。
- **目标只由最新一条用户文本提供**——描述分散在多条用户消息中的任务，只按最新那条排序，外加该步骤已认领的消息。
- **只有索引中的事实可被排序**——地图继承 `dsh-repo-index` 的按行提取，因此索引未识别的符号或引用不会出现在这里。
- **按字节而非按 token 限长**——`maxBytes` 按 UTF-8 字节、以整行为单位截断，因此 token 成本随标识符与路径长度变化，而头部仍照实声明完整索引总量。
- **截断是静默的**——模型不会被告知字节上限砍掉了哪些排序符号或关联符号，只知道索引共有多少。
- **没有工作目录就没有地图**——会话头部不携带 `cwd` 时，无论索引多大都不会收到任何内容。
- **过期地图不会重新注入**——目标停止变化后，上一份快照持续生效，因此更晚的步骤看到的仍是最后一次变化时的地图。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

pre-step 监听器在计算任何内容之前先做委托，因此拒绝的监听器仍会短路该步骤，已中止的信号也不花费任何遍历。会话渲染不出内容时 `WeakMap` 条目会被删除，因此失去工作目录的会话不会继续发布上一份文本。

排序的目标取自 `session.deriveMessages()` 加上该步骤已认领的消息，因为已认领消息尚未出现在表层；这正是开启任务的步骤按它刚认领的任务排序、而非按上一轮目标排序的原因。

</details>
