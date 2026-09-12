---
description: "ShareGPT trajectory export of finished Sessions and Workspace scopes: per-turn conversations written under the harness home (ctx.evolutionTrajectory), for evals and outer-loop training."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-trajectory

[English](README.md) | 中文

## 概述

`dsh-evolution-trajectory` 把已结束的 Session 写成 ShareGPT 对话文件，用于评测与强化学习数据。单个 Session 导出写一个文件，其中每个回合一个对话；作用域导出为某个 Workspace 的每个未归档 Session 各写一个文件，并汇总总数。对话保留会话日志自身的文本与角色，注入的上下文、推理与附件都不进入导出。除组合或调用另行指定目录外，导出落在 `$DSH_HOME` 之下，永不写入项目内。没有可采纳消息的 Session 导出空数组而不是失败。

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

挂载本插件，单个 Session 调用 `ctx.evolutionTrajectory.exportSession(sessionId)`，某个 Workspace 作用域的全部未归档 Session 调用 `exportScope(scopeId)`。两个动词都报告写入路径、对话数与 UTF-8 字节数；`exportScope` 给出的路径是它写入的目录，数值是其各文件的总和。

`toShareGpt({ sessionId, events })` 是两个动词背后的纯整形函数：传入某个 Session 的已提交事件，得到每个回合一个对话。

### 何时选用

当已结束的 Session 应变成 harness 之外的训练或评测数据时选用它。它是外循环的导出半边；对照夹具度量 Session 的评分器属于它自己的包，轨迹查看器是同一批日志之上的浏览器界面。需要的答案是一次查询而不是一个文件时改用 `ctx.sessionQuery`；人想要 ZIP 下载而不是一个路径时改用 Web 导出。

### 配置

`outDir` 是可通过 `cordis.yml` 修改的、经过校验的 `Config` 成员。未设置时，在导出时读取 `$DSH_HOME`，导出落在 `$DSH_HOME/evolution-trajectories`。

```yaml
- name: '@deepseek-ai/dsh-evolution-trajectory'
  config:
    outDir: D:/trajectories
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `outDir` | `$DSH_HOME/evolution-trajectories` | 导出调用未指定目的地时使用的目录 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-trajectory)是每个可接受字段的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

导出通过持久化读取句柄读取某个 Session 的已提交事件——若该 Session 仍在运行则先冲刷——再用一个纯函数整形。对话先在内存中成形才会写盘，因此被拒绝的读取不会留下半个文件；作用域导出独立写每个 Session 的文件：一份读不了的日志只跳过并警告，不会作废其余部分。

### ShareGPT 形状

每个导出文件是一个对话 JSON 数组，每个产出可采纳消息的回合一个对话。对话标识为 `<sessionId>#<turn>`，消息使用 ShareGPT 角色词汇：`system/message` 成为 `system`，人类的 `user/message` 成为 `human`，`assistant/message` 成为 `gpt`，`tool/result` 成为 `tool`。助手的工具调用渲染为 `<tool_call>` 标签，内含调用名与模型原始参数 JSON，因此不可解析的参数也原样保留。采纳沿用审阅者的规则：只有来源为人类用户的 `user/message` 事件通过，注入的上下文与空渲染永不成为训练数据。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`EvolutionTrajectoryExporter` 服务、导出动词、默认目录与文件写入 |
| [`src/sharegpt.ts`](src/sharegpt.ts) | 纯整形：事件采纳与对话构造 |
| [`src/types.ts`](src/types.ts) | 公共 ShareGPT、导出选项与结果类型 |

### 失败与恢复

未知 Session 以 `session/not-found` 拒绝，未知作用域以 `workspace/not-found` 拒绝，其余任何存储失败原样向上传播。名册中指向没有存储日志的 Session 时，跳过该 Session 并警告。导出文件只是普通产物：再次导出会覆盖上一个文件，删除一个文件不会丢失 harness 另存于他处的任何东西。

不发布 invariant 伴生包，因为本包不持有持久状态：每次导出都是会话日志与 Workspace 名册的派生投影。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 规范](../../../specs/evolutionary-harness.spec.md)——本包实现的行为契约。
- [evolution 包导览](../README.zh.md)——本分组的软件包及其仓库位置。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-trajectory)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

### 导出的轨迹文件

#### 模型看到的内容

无。导出读取会话日志并在 `$DSH_HOME` 下写文件；它不注册任何提示、工具或模式，导出的对话也不会重新进入模型请求。

#### Token 影响

零。导出在任何模型回合之外运行，不消耗 token。

#### KV Cache 影响

无。文件落在宿主文件系统上，因此没有任何请求前缀改变，provider 缓存复用不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了导出不适用的场景。它们是当前包约束。

- **只有文本**——消息引用的图片与其他附件不会被写入；只有文本块进入对话。
- **推理被丢弃**——助手消息只贡献文本与工具调用，永不贡献推理块。
- **系统提示重复**——每个对话都以该回合携带的系统消息开头，因为一个对话就是一个回合。
- **每回合一个对话**——Session 永不导出为单个长对话，需要单对话的使用方必须自行拼接文件。
- **全局作用域没有名册**——`exportScope` 需要一个 Workspace 作用域；profile 级作用域没有可迭代的 Session 名单。
- **仅服务**——导出通过 `ctx.evolutionTrajectory` 及其 Remote 命名空间到达；目前还没有斜杠命令。
- **只覆盖不追加**——第二次导出会替换同一路径上的文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
