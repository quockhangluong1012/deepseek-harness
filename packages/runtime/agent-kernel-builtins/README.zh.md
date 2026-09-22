---
description: "Agent Kernel 的内置工具能力声明：为每个已发布产品工具提供一份声明，让 enforce 模式治理真实流量，供组合受治理运行时的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-kernel-builtins

[English](README.md) | 中文

## 概述

在 agent kernel 旁边挂载本包，让 `mode: 'enforce'` 治理真实流量。它声明每个已发布产品工具的能力，以及每项能力所适用的资源投影；一旦 kernel 服务存在便向其注册，与挂载顺序无关。它不拥有策略也不拥有执行：Kernel 的权限文档仍然决定每个动作，卸载本插件只移除它添加的声明。

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

部署打开 `mode: 'enforce'` 时，在 `@deepseek-ai/dsh-agent-kernel` 旁边加载本插件。本插件无需配置、不注入服务，只注册声明。挂载顺序永远无关紧要：注册等待被注入的 `agentKernel` 服务。

### 最小组合

```yaml
- name: '@deepseek-ai/dsh-agent-kernel'
  config:
    mode: enforce
    policy:
      defaults:
        effect: ask
      rules:
        - action: read
          resource: 'workspace/**'
          effect: allow
- name: '@deepseek-ai/dsh-agent-kernel-builtins'
```

### 何时选择它

enforce 模式必须治理已发布工具时选择它：每次工具调用都需要留档决策的无人值守运行，或权限文档按动作族而非按工具命名的部署。部署声明自己的调用面时避开它——重命名过的工具、私有工具包，或动态铸造的 `mcp__*` 名字各自需要自己的声明，未被声明的工具保持拒绝。

### 你会得到什么

每个已发布产品工具一份声明，各自指明一次调用需要的能力，并把调用的解析参数投影到每项能力所适用的资源。文件系统工具投影路径，shell 工具投影命令，网络工具投影查询与 URL，委派工具投影描述与 agent id，其余工具投影其族所治理的标识符。每份投影都是全函数且永不为空：缺失或畸形的参数回退到命名该工具领域的常量，因此未知资源只匹配宽泛规则，绝不可能滑过窄规则。完整表格在 [`src/declarations.ts`](src/declarations.ts)；一份 spec 断言它恰好命名了生成的[工具目录](../../../docs/tool-catalog.zh.md)所列的工具——新发布的工具在被声明之前会让那份 spec 失败。

### 声明属于哪里

声明放在这里而不在工具包里，因为只有策略平面可以扩展权能词汇，且工具包必须在没有 Kernel 时也可挂载。工具的 schema 留在自己的包里；一次调用*需要*什么是策略知识，并用工具包自己生成的目录来验证。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节解释声明如何到达 Kernel；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计概念

Kernel 的注册表初始为空并按失败关闭。本插件只为已发布调用面填充它：`apply()` 通过一个 Cordis effect 注册整张表，因此卸载本插件会释放它做出的每一份注册，不动外来的声明。被注入的 `agentKernel` 服务让挂载顺序无关紧要——组合可以把本插件列在 Kernel 之前或之后。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`name`、`agentKernel` 注入与注册 effect |
| [`src/declarations.ts`](src/declarations.ts) | 声明表与全函数资源投影 |
| — | 不发布运行时 invariant 伴生件；该表是静态注册，其覆盖 spec 从生成的目录重新推导工具清单，因此第二份观察不可能与之分叉。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

本包契约不够时读这些。它们从声明走向它喂给的策略与它命名的工具。

- [Agent kernel 子系统参考](../../../docs/subsystems/agent-kernel.zh.md)——权限文档、能力注册表，以及声明喂给的授权。
- [生成的工具目录](../../../docs/tool-catalog.zh.md)——每个已发布产品工具，以及每份投影读取参数的 schema。
- [runtime 分组地图](../README.zh.md)——同族的 runtime 包。

-----

<a id="model-experience"></a>
## 模型体验

### 已声明的工具调用

#### 模型看到什么

什么都不增加。声明到达不了提示词、工具 schema 或对话：它们只让 Kernel 的权限文档去求值一次调用，而不是以未声明为由拒绝它。`enforce` 模式下文档放行的调用与没有 Kernel 时一模一样地运行；文档拒绝的调用返回以 `agent-kernel denied "<tool>": ` 开头的工具错误。

#### Token 影响

零 Token 增加。声明不改变任何请求内容；它只改变一次已定价的调用是运行还是被一行简短原因替代。

#### KV 缓存影响

相互独立：本插件不注册提示词段落也不注册 schema，因此从不改变请求前缀，也不可能让可复用的条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本包何时是糟糕的选择。它们是本包当前的约束，而不是任务清单。

- **重命名过的工具需要自己的声明**——该表声明默认名字外加已发布的 `subagent_fork` 别名。通过加载时配置重命名了工具的部署自行声明多出的名字。
- **动态铸造的名字超出范围**——`mcp__<server>__<tool>` 名字与按次铸造的 `structured_output` 工具在运行时之前不存在，因此任何静态表都声明不了它们；使用它们的部署逐个声明名字，或接受失败关闭的拒绝。
- **一个工具，一份声明**——`bash` 与 `pwsh` 各以一名发布两次（单次与持久变体）；单份声明覆盖该名字，因此两个变体共享 `process.exec` 能力。
- **混合命令共享一份声明**——`str_replace_editor` 为每条命令声明 `fs.read` 与 `fs.edit`，因此一次 `view` 也携带它从不使用的 edit 请求。`edit` 族上的拒绝会同时拒绝该路径的查看与修改。
- **有些映射是就近拟合，而非精确**——固定词汇没有读取技能体、会话记录或后台任务输出的成员（由 `fs.read` 与 `memory.read` 充任），也没有排期与团队任务的成员（由 `workflow.start` 与任务记忆充任）。每族注释记录了取舍理由。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作背景——点击展开</summary>

本开发备注是面向维护者的工作背景：尚未决定的开放问题与方向。它明确非权威——已发布行为、限制与既定理由以上面的章节、包代码与关联的 Agent Note 为准。

备选设计是在每个工具包里放声明，或在工具注册表里放中央表。逐包声明倒置了分层——产品工具包将依赖策略平面；而注册表所有的中央表把策略知识放进 Kernel 被禁止复制的执行平面。独立的可选插件把词汇、注册表与已发布声明收拢在一个平面，同时让每个工具包在没有 Kernel 时也可挂载。

</details>
