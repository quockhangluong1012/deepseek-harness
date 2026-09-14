---
description: "Evolution background review with per-turn output indexing, gated lessons extraction, and on-demand rebuild (ctx.evolutionReviewer), for hosts composing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-reviewer

[English](README.md) | 中文

## 概述

`dsh-evolution-reviewer` 从实时会话提炼演进经验，且永不阻塞回合：它在事件到达时缓冲当前回合的事件，在 `turn/end` 索引产出文件，把按目录限定范围的排序既往工作召回进简报，并将受门控的确定性提取排入队列，重写作用域的经验文档——直接写入，或在 `writeApproval` 开启时暂存待批。`rebuild` 经由异步会话查询从历史再生经验。当作用域的经验需要跟随其会话的实际行为时，选择本包。

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

与记忆存储和 workspace 注册表一起挂载本插件。作用域按回合从 workspace 归属解析（注册表会话 id，退回规范化 `cwd` 匹配），归属到配置的 `profile` 之下；作用域之外的回合既不索引也不提取。

### 配置

```yaml
- name: '@deepseek-ai/dsh-evolution-reviewer'
  config:
    profile: default
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 完成的回合触发提取；产出索引始终运行 |
| `profile` | `default` | 作用域标识命名空间，置于 workspace 键之前 |
| `minTurnTextBytes` | `200` | 承认文本低于此字节数的琐碎回合跳过提取 |
| `cooldownMs` | `60000` | 同一作用域两次提取的最小间隔 |
| `defer` | `auto` | `auto` 把受门控的回合排队稍后提取；`never` 在回合结束时立即提取 |
| `deferMaxAgeMs` | `1800000` | 排队回合的年龄上限，从该会话的第一份快照起算 |
| `maxInputBytes` | `131072` | 每次调用的笔录预算，优先丢弃最旧 |
| `maxOutputTokens` | `1024` | 每次调用的输出 token 上限 |
| `timeoutMs` | `60000` | 调用截止时间 |
| `rebuildSessionLimit` | `20` | 重建扫描的会话数 |
| `recallLimit` | `20` | 每次搜索选出的排序召回结果数（会话与事件各一档） |
| `recallQueryChars` | `160` | 由回合最新人类消息导出的召回查询长度上限 |
| `squeezeBytes` | `65536` | 挤压后的经验文档必须容纳的字节预算；保持在存储 `maxAgentBytes` 及以下 |
| `squeezeOrder` | `References, Decisions, Preferences, Purpose` | 压力顺序：列在前面的标题其正文最先清空 |
| `outputTools` | `write,edit,str_replace_editor` | 计为产出的成功工具调用 |
| `provider`/`model` | 未设 | 路由覆盖；要么成对出现，否则沿用会话路由 |
| `writeApproval` | `false` | 后台提取暂存待批而不直接写入 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-reviewer)是每个可接受字段的详尽来源。

### 写入与审批

回合提取把整份经验文档存为一个粗粒度工件——其 statement 即挤压后的文本——来源为 `background_review`。在 `writeApproval` 下，同一文档改为以 `replaceArtifacts` 操作暂存，等待 `/memory approve`；只有显式 `rebuild`（来源 `rebuild`）保持直接写入。失败的提取告警并保留旧文档； teardown 与会话释放会中止在途调用。

### 精简挤压

在提取器与存储之间，`squeezeLessons` 把模型输出归约为四个记忆标题：首个标题之前的散文与任何其他标题之下的行都会被丢弃。结果仍超出 `squeezeBytes` 时，按 `squeezeOrder` 逐标题整体清空正文——列在最前的标题最先清空——最后一个仍在的正文在 UTF-8 边界处裁剪。只要由此丢失了材料，存储的文档就标记 `truncated`。若 `squeezeBytes` 配得高于存储自身的 `maxAgentBytes`，也过不了该上限：上限度量的是序列化后的工件数组，其中 statement 出现两次——一次作为 `statement`，一次作为给它命名的规范化标识——并包在固定外壳里。因此重试求解的是「工件能容纳的最长 statement 前缀」，用存储自己报告的度量去搜索前缀长度，而不是假定文本预算等于上限。

### 排序召回

后台评审开启时，每个被观测的回合都会由其最新人类消息导出召回查询，向按目录限定范围的排序搜索 seam 请求候选会话，并跳过提问会话自身。候选会被解析为其事件，并通过与笔录相同的承认规则，因此注入的简报与指令消息永不会被召回回来。最强的被承认命中会作为该作用域唯一的上下文条目落地，标签为 `Recall: <sessionId>`——内容变化时替换，未变化时不动——而简报把它渲染在最后，因此在压力下最先被丢弃。没有搜索 seam 就没有召回条目。

### 重建与延迟

重建以同样的方式选取材料：作用域最新观测到的人类请求驱动一次按目录限定范围的排序 `searchSessions`，每个排序会话的事件再经 `searchEvents` 取回，每个被选事件在组帧前都要通过共享的承认规则。行按最不相关优先累积，因此笔录字节上限丢弃的是召回而非最强命中。seam 缺席或不完整、排序结果为空、搜索失败，或作用域尚无被观测回合时，都回退到精确的 `readSurface` 扫描。

在默认的 `defer: auto` 下，受门控的回合不再于 `turn/end` 立即提取，而是进入按会话的内存队列。刷出之前结束的回合会合并：新快照替换已排队的快照，而第一份快照的 `deferMaxAgeMs` 截止时间与计时器保持不变，因此繁忙会话无法无限推迟自己的提取。会话释放与 teardown 会丢弃排队回合而不提取；`defer: never` 恢复回合结束时的即时提取。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

评审器观察 `session/event`，按会话缓冲当前回合的承认行与工具结果，在 `turn/end` 刷出缓冲。没有任何逻辑同步扫描会话历史：恢复后的会话贡献其被观测到的后缀，而重建经 `sessionQuery` 的排序搜索选取材料，排序 seam 缺席或为空时回退到精确的 `readSurface` 扫描。`admittedRow` 是唯一的承认规则：即时缓冲、精确重建扫描与每一个排序召回候选都经过它，因此注入的简报或指令消息永不会成为笔录或召回材料。同一作用域永不并发两次提取：即时路径与到期的延迟刷出都排入按作用域的 promise 链，回合重叠时该链丢弃被取代的条目。延迟队列本身按会话各持一份合并后的快照，以该会话第一份快照的截止时间为准。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`EvolutionReviewer` 服务、回合缓冲、门控、排序召回、重建 |
| [`src/prompt.ts`](src/prompt.ts) | 提取系统提示、JSON 输入组帧、UTF-8 裁剪 |
| [`src/squeeze.ts`](src/squeeze.ts) | 精简挤压：标题收集、压力顺序、UTF-8 裁剪 |

### 失败与恢复

提取路由来自配置的 pair，否则取会话最近请求头；两者皆无的回合告警并跳过，无路由的重建直接拒绝。`error` 与 `aborted` 收尾抛入告警路径；`max-tokens` 以 `truncated` 容忍；工具调用块与其他收尾一律拒绝。模型调用使用 `temperature: 0` 与 `purpose: 'evolution-review'`，因此推理保持关闭，用量归属评审任务。召回失败与召回条目被存储拒绝时只告警，不让回合失败，原上下文保持不动。

不发布 invariant 伴生包，因为评审器不拥有自己的持久状态：缓冲与链是内存中的调度，存储的域表是唯一的持久副本。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 规范](../../../specs/evolutionary-harness.spec.md)——本包实现的行为契约。
- [evolution 包导览](../README.zh.md)——本分组的软件包及其仓库位置。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-reviewer)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型所见

提取调用把组帧后的笔录加当前经验文档，作为一条辅助用户消息连同经验系统提示一起发送。

##### 本字段原文（如需）

```markdown
You distill durable lessons for an agent scope from one turn of conversation.
```

#### Token 影响

带上限：每个受门控的回合一次辅助请求，受 `maxInputBytes` 笔录加经验文档、`maxOutputTokens` 补全约束。召回为每个被观测回合增加一次索引搜索，并至多向作用域记录添加一个上下文条目；其材料只经下一份简报抵达模型。

#### KV Cache effect

与实时请求独立：提取是拥有独立前缀的一次性调用，不会使会话的 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了评审器不适用的场景。它们是当前包约束。

- **仅经验**——提取重写 `agentLessons`；用户画像保持手工维护，直到控制面切片到来。
- **无 subagent 评审分支**——提取在按作用域链上进程内运行；带工具白名单的委派后台 agent 延期。
- **排队回合只在内存中**——在 `deferMaxAgeMs` 截止之前发生重启或 teardown 会丢弃排队回合，而不持久化快照。
- **挂载时正在进行的回合**——评审器加载时已在进行中的回合，只从其被观测到的后缀提取。
- **召回需要排序面**——没有 `sessionQuery` 时，重建直接拒绝；缺少其排序读取能力时，召回不写入任何内容，重建回退到精确表层扫描。
- **每个作用域一个召回条目**——命中变化时替换旧条目并改变记录摘要，因此下一份简报是全新的；命中未变化时什么都不重写。
- **召回查询是字面短语**——搜索后端把导出的查询当作数据匹配，因此从未在已索引会话中逐字出现的查询不会返回候选。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
