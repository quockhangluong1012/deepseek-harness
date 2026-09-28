---
description: "完整的 V5 到 V6 Session 转换：事件归属重命名、新增必需的预算与证据成员、保留项，以及具名拒绝。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v5-to-v6

[English](README.md) | 中文

## 概述

在不伪造来源或证据的前提下，将受支持的已发布 V5 Session 恢复为 V6。本页是此相邻迁移的唯一规范：说明它转换、保留和拒绝什么，随后单独说明原生 V6 准入。该库重命名一个事件归属成员，接受 V6 新增的可选成员与联合分支，并拒绝那些必须伪造 V6 含义的历史情形。持久化通过静态目录消费它；本库不读取也不发布文件。

## 目录

- [使用本包](#use-this-package)
- [V5 到 V6 规范](#v5-to-v6-specification)
  - [头部转换](#header-conversion)
  - [归属重命名](#attribution-rename)
  - [新增必需成员](#newly-required-members)
  - [V6 的新增内容与词汇](#additive-v6-members-and-vocabulary)
  - [保留的值](#preserved-values)
  - [继承切点](#inherited-cut)
  - [拒绝族](#refusal-families)
  - [外部前置条件](#external-prerequisites)
- [原生 V6 准入](#native-v6-admission)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和待办工作](#known-limitations-and-deferred-work)
- [开发者备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

要恢复 Session，请使用[目录](../session-format-catalog/README.md)。直接导入用于组装目录和测试；本库没有 Cordis 挂载配置。[公共导出](src/index.ts)提供迁移声明、已发布的 V5 源编解码器、V6 目标编解码器、目标头部校验器和目标恢复器。

### 入口

仅头部的操作不会转换或校验事件体：

```text
const targetHeader = sessionFormatV5ToV6.migrateHeader(sourceHeader)
```

完整恢复会把解码后的事件送入一个全新的阶段，并校验目标产物。调用方不得把部分阶段输出当作恢复成功：错误可能出现在更晚的事件上或出现在 `finish()` 中。[格式协议](../session-format/README.md)负责阶段调度与目录错误处理；[JSONL 持久化](../session-persistence-jsonl/README.md)负责读取准备和不可变后继发布。

-----

<a id="v5-to-v6-specification"></a>
## V5 到 V6 规范

源形状是 [V5 格式参考](../../../docs/persistence-changes/historical-formats/v5.md) 和[已定稿的 V5 检查点](../../../docs/persistence-changes/finalized/v5.json)中记录的已接受 V5 基线，而不是之后某次检出的写入结果。该迁移保留事件数量、顺序、时间戳、序列坐标、标识和引用。它不插入事件、不删除事件，也绝不以零替代未知切点。除下列成员外一切都保持不变；保留规则适用于已准入的输入，而非任意未经审计的扩展。

<a id="header-conversion"></a>
### 头部转换

逻辑头部把 `version: 5` 改为 `version: 6`。V6 的头部形状与 V5 相同，因此 `id`、`createdAt`、`isSeeded`、`delegationDepth` 以及已准入的可选 `cwd`、`parentSession`、`origin`、`agentPreset` 都保持原值。`migrateHeader` 拒绝不是已发布 V5 头部的输入；`assertReleasedV6Header` 拒绝不满足同样规则的 V6 头部。物理行布局未变，因此 V6 编解码器沿用已发布的 V5 分帧，仅更换版本判别式；运行标签、信封成员和打包行表示都不改变。

<a id="attribution-rename"></a>
### 归属重命名

在每个携带事件元数据的事件上，`data.metadata.provenance` 变为 `data.metadata.sourceRef`。携带它的十七个已发布 V5 根是 `action/committed`、`action/decided`、`checkpoint/created`、`checkpoint/resumed`、`claim/updated`、`delegation/issued`、`delegation/received`、`evidence/recorded`、`failure/recorded`、`hypothesis/updated`、`recovery/decided`、`recovery/started`、`task/created`、`task/plan`、`task/transitioned`、`verification/requested` 和 `verification/result`。该规则按位置表述而非按上述清单表述，因此把元数据附到其他事件上的产出方也会得到同样的转换。

`evidence/recorded.data.provenance` 同时变为 `evidence/recorded.data.sourceRef`。值形状 `{ source, locator?, digest? }` 及其九个 `source` 字面量（`policy`、`user`、`model`、`tool`、`kernel`、`repo`、`subagent`、`web`、`mcp`）均不变，因此该重命名是全覆盖且无损的：同一个值对象被移动，没有任何字面量被翻译、默认或丢弃。

当目标成员已存在时拒绝该重命名，因为同一位置存在两个归属没有已定义的 V6 含义。诊断信息会指出事件类型、其序列号以及两个成员路径。

<a id="newly-required-members"></a>
### 新增必需成员

V6 要求了 V5 记录无法提供的成员。此迁移拒绝这些记录，而不是凭空合成取值：

| 事件 | V6 必需成员 | 无法合成的原因 |
|---|---|---|
| `budget/exceeded` | `data.ceilings` | V5 从未记录该次运行所依据的限值集合。 |
| `budget/exceeded` | `data.scope` | 仅凭限值名称无法还原它所适用的范围。 |
| `task/created` | `data.dependencies` | 空列表会断言“没有依赖”，而记录并非如此陈述。 |
| `task/created` | `data.evidence` | 空列表会断言“没有证据”，而记录并非如此陈述。 |
| `task/transitioned` | `data.evidence` | 空列表会断言“没有证据”，而记录并非如此陈述。 |
| `verification/requested` | `data.repositoryDigest` | 摘要标识被验证的仓库状态；编造一个等于伪造证据。 |
| `hypothesis/updated` | `data.tests[].repositoryDigest` | 同上，按每条已记录测试分别要求。 |

每条诊断都会指出事件类型、其序列号和确切的点分路径，因此缺少多个成员的记录会报告第一个缺失的成员。拒绝按产物进行：遇到第一个此类事件即终止转换，且不发布任何部分后继。

<a id="additive-v6-members-and-vocabulary"></a>
### V6 的新增内容与词汇

以下 V6 变化不需要转换，因为 V5 记录不可能包含它们，而 V6 接受它们缺失。它们被原样接受，不构成拒绝：

- 可选成员：`budget/exceeded.data.runId`、`checkpoint/created.data.budgets.background`、`task/created.data.changeContract`、`verification/requested.data.changeContract`、`hypothesis/updated.data.tests[].changeContract`、`goal/change.data.goal.maxGoalTokens` 和 `goal/change.data.tokensUsed`。
- 新增联合字面量：`action/committed.data.governance.approvalOutcome` 与 `approval/decided.data.outcome` 新增 `allowed-always` 和 `allowed-session`；`budget/exceeded.data.name` 新增九个限值名称；`checkpoint/created.data.unresolvedFailures[].kind`、`failure/recorded.data.kind` 和 `recovery/started.data.kind` 新增 `plan-drift` 和 `verification-regressed`；`task/created.data.acceptance[].verifier`、`verification/requested.data.criteria[].verifier` 和 `hypothesis/updated.data.tests[].criteria[].verifier` 新增 `lint`、`review`、`security`、`typecheck` 和 `browser`；`task/transitioned.data.trigger.kind` 新增 `approval-decided`；Message `source` 联合新增 `repo-map`、`working-set`、`lsp-post-edit-diagnostics`、`mentor-loop` 和 `routine`。
- V5 记录本就不可能携带的被移除联合分支不构成拒绝。`session/title-llm-request.data.messages` 重新排列了它的五个角色分支，但成员集合不变。
- V6 新增的六个事件根，以及上面列出的成员，都是载荷模型中的同版本常规增长；之所以需要版本提升，是因为它们无法相对已接受的 V5 基线单独记录，而不是因为此迁移会转换它们。

<a id="preserved-values"></a>
### 保留的值

其余一切逐字节保留：

- 事件顺序、数量、密集的 `seq`、`time`、`ignorable`、`surfaceOp` 和 `sourceEventSeqs`。
- 标识与引用：`header.id`、`parentSession`、任务、目标、假设、证据、失败、委派和消息标识；`contentRef`；`evidenceId`；`retryId`；`transitionId`；`sourceEventSeqs[]`；`messageSeqs[]`；`shadowedRange`；`shadowedSeqs[]`。
- 不透明的嵌套数据：消息内容块、工具参数与结果、`replayState`、附件、预算数值以及任何产出方扩展。不透明嵌套数据中名为 `provenance` 的成员不是事件归属，不会被重命名；该规则只适用于 `data.metadata` 对象和 `evidence/recorded.data`。
- 上述映射未涉及的数字、字符串和字面量保持取值不变，包括 V6 联合仍然接受的 `source` 字面量。

<a id="inherited-cut"></a>
### 继承切点

此迁移不改变基数，因此继承切点保持不变。未播种的 Session 暴露 `headerInheritedEventCount: 0` 并返回 `0`；已播种的 Session 在链路已知时暴露传入的源计数，否则在 `finish()` 时从最后一个携带 `data.inherited: true` 的 `session/end-seed` 推导出精确切点。传入计数与标记不一致、已播种但无标记、未播种却有标记的情形一律拒绝。每次 `createStage` 调用都拥有自己的标记状态，因此并发的 Session 之间不共享切点。

<a id="refusal-families"></a>
### 拒绝族

被移除的归属类型是 V5 联合中 V6 唯一删除的分支：

| 族 | 位置 | 原因 |
|---|---|---|
| 被移除的来源类型 `workspace-memory-llm` | `user/message.data.source` | V6 从 Message 来源联合中移除了该类型；替换归属会造成虚假来源。 |
| 被移除的来源类型 `workspace-memory-llm` | `developer/message.data.message.source` | 同一联合，同一原因。 |
| 被移除的来源类型 `workspace-memory-llm` | `agent/inbox/spliced.data.inserted[].source` | 同一联合，同一原因。 |
| 被移除的来源类型 `workspace-memory-llm` | `session/title-llm-request.data.messages[].source` | 同一联合，同一原因。 |
| 缺失新增必需成员 | [新增必需成员](#newly-required-members)中的载荷 | 该值从未被记录；合成它等于伪造证据。 |
| 重命名冲突 | `data.metadata`、`evidence/recorded.data` | 同一位置存在两个归属没有已定义的 V6 含义。 |

这四个被移除类型的位置，正是 V5 中 `source` 联合接受 `workspace-memory-llm` 的全部位置；该联合是共享的，因此规则按位置表述。迁移阶段的拒绝抛出 `SessionFormatUnsupportedMigrationError`，目录将其报告为不支持的迁移。源字节、源路径和源世代永不改变，也不会尝试回退到前一个世代。

<a id="external-prerequisites"></a>
### 外部前置条件

只有当每个更早的迁移都接受时，V5 记录才能到达 V6。已发布的 V0 到 V4 词汇、V3 系统头与规范信封规则、PTC 与预设重命名、交付水位线以及历史子目录事实都在此迁移运行之前照常生效；本包既不放宽也不重复它们。被更早迁移拒绝的 V5 记录会在那里被拒绝，而不是在这里。世代之间的父子关系由目录层和持久化层负责。

-----

<a id="native-v6-admission"></a>
## 原生 V6 准入

已标记为 V6 的输入不会运行 V5 到 V6 迁移。以下检查属于原生准入，由 `restoreReleasedV6Artifact` 执行，目录对解码得到的 V6 产物和链式产生产物都会调用它：

- 先校验 V6 头部，然后在同一产物的 V5 版本判别式下运行 V5 未变的词汇与关系规则。`restoreReleasedV6Artifact` 返回原产物；它绝不改写或修复产物。
- 仍携带 `data.metadata.provenance` 或 `evidence/recorded.data.provenance` 的事件被拒绝：这些成员在 V6 中不存在。
- 缺失的[必需成员](#newly-required-members)被拒绝，被移除的 `workspace-memory-llm` 来源类型也被拒绝。
- 已安装的 Session 包负责完整的 V6 事件形状、词汇、关系与表面校验。目录以 `validation: 'current'` 恢复时在本恢复器之后运行它；`validation: 'transformed'` 只运行本恢复器。本恢复器有意窄于已声明的 V6 模式，不重复已安装的校验器。
- 任何迁移路径都无法提供的记录都不会被部分发布：转换期间的拒绝会让已提交的 V5 世代保持原样。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节——点击展开</summary>

[阶段](src/migration.ts)只拥有继承标记切点；每次转换都是纯粹的逐事件函数，因此两个并发 Session 不共享任何可变状态。打包运行会被逐事件重新展开并通过 `context.emitEvent` 重新发出，因为被转换的事件无法留在编解码器自有的运行内。[编解码器](src/codec.ts)通过前一个边包导出的已发布 V5 分帧复用它，只更改版本判别式。[恢复器](src/validation.ts)检查 V6 增量，然后把产物交给冻结的 V5 规则。源编解码器是重新导出而非重新定义：本包中的 `releasedV5SessionFormatCodec` 与 `@deepseek-ai/dsh-session-format-v4-to-v5` 导出的是同一个对象，测试以同一性断言这一点。

[迁移测试](tests/migration.spec.ts)锁定重命名、每一个拒绝族、切点纪律和阶段独立性。[目录测试](tests/catalog-restore.spec.ts)通过 `sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })`证明严格恢复，包括来自已发布 V0 形状的已播种多跳切点，以及不存在任何前代回退。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [V4 到 V5 迁移](../session-format-v4-to-v5/README.md)——前一个编解码器与迁移，本包复用其源编解码器。
- [V5 格式参考](../../../docs/persistence-changes/historical-formats/v5.md)——此迁移读取的已接受 V5 模式。
- [Session 格式状态](../../../docs/session-format-status.md)——写入方、已接受基线和发布记录。
- [Session 格式版本手册](../../../docs/cookbook/adding-a-session-format-version.md)——版本过渡与不可变世代。

-----

<a id="model-experience"></a>
## 模型体验

### 历史恢复

#### 模型看到什么

模型看到的正是 V5 记录所包含的消息。被重命名的归属属于审计元数据，新增成员不是提示内容。

#### Token 影响

该迁移不改变任何模型消息或与 token 相关的字段。

#### KV 缓存影响

该迁移保留已记录的请求前缀，且不新增提示文本。

## 已知限制和待办工作

<a id="known-limitations-and-deferred-work"></a>

- **没有仓库摘要的记录不可迁移**——早于仓库摘要的 V5 `verification/requested`、`verification/result` 或 `hypothesis/updated` 记录没有已实现的 V6 映射，因此被拒绝。未来的迁移可以从可复现的语料中映射它；它绝不能凭空编造摘要。
- **携带 `workspace-memory-llm` 归属的记录不可迁移**——该类型没有 V6 联合分支，任何替换都会错误归属内容。这是有意的拒绝，而不是等待推断填补的空缺。
- **没有降级路径**——V6 世代绝不会被改写或作为 V5 打开；当最新世代更新或无效时也不会选择前代。参见[兼容性义务](../../../docs/session-format-status.md)。
- **较窄的原生恢复器**——`restoreReleasedV6Artifact` 校验 V6 增量以及冻结的 V5 规则；完整的 V6 校验属于已安装的 Session 包，通过目录的 `validation: 'current'` 到达。

<a id="dev-note"></a>
### 开发者备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
