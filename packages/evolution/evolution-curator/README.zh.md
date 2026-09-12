---
description: "Idle-triggered skill lifecycle curation: automatic active/stale/archived transitions with dry-run previews (ctx.evolutionCurator), for hosts curating skills during use."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-curator

[English](README.md) | 中文

## 概述

`dsh-evolution-curator` 运行技能生命周期整理的自动、无模型一半——闲置技能沿技能遥测从 `active` 经 `stale` 到 `archived`，带试运行预览、首次运行递延与闲置门控——以及可选、由模型驱动的一半：把 agent 创建的技能归并为伞技能。置顶技能、受保护名称、随包与 hub 来源永不移动。本插件每个 host 只挂载一次，并自己拥有计划：它观测 host 范围的会话活动，运行一次启动时到期检查，随后按周期滴答。真实通过写一个 tarball 快照外加台账条目，整轮或单条目回滚失败关闭；手工认领 agent 创建的技能，TTL 清理删除归档技能及其目录。遥测缺席时，自动方法退化为记账或空报告。

挂载本身就是全部触发：`enabled: false` 不启动定时器，也不触碰记账。

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

Host 启动时挂载本插件一次。此后它自行拥有维护计划：自己观测 host 范围的 `session/event` 活动，运行一次启动时到期检查，并以 `unref()` 过的定时器每 `tickMinutes` 重复一次到期检查，定时器随插件处置。到期检查仅在 `lastRunAt` 起经过 `intervalHours`，且 `minIdleHours` 内没有会话事件到达时才运行一次通过；本进程观测到任何活动之前，host 视为闲置。首次检查只播种 `lastRunAt` 并递延一个周期，因此短命 CLI 运行只贡献其启动时刻，而不运行任何东西。`enabled: false` 不启动定时器，也不触碰记账。

调用 `maybeRun` 可自行运行同一次到期检查（闲置门控可用 `idleMs` 显式覆盖），调用 `run` 做无条件通过，以 `dryRun: true` 预览报告而不写入。一次通过检查每个被跟踪的技能：闲置时长从上次加载起算，从未加载则从播种起算。`active` 在超过 `staleAfterDays` 后进入 `stale`，`stale` 在超过 `archiveAfterDays` 后进入 `archived`。报告以理由列出每次移动，并给出置顶、受保护名称与被排除来源的跳过计数；写了快照时还携带通过标识与快照文件名。`lastRunAt` 读取上次通过时刻，供状态界面使用。

`consolidate: true` 时，该通过随后对 agent 创建的技能运行一次 LLM 归并（见[归并](#consolidation)）。

### 配置

周期、阈值、保留期与归并路由是可通过 `cordis.yml` 修改的、经过校验的 `Config` 成员。归档阈值低于过期阈值时大声失败；`provider`/`model` 只设一半，或开启归并却缺少二者，同样大声失败。

```yaml
- name: '@deepseek-ai/dsh-evolution-curator'
  config:
    staleAfterDays: 30
    consolidate: true
    provider: deepseek
    model: deepseek-chat
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭时跳过一切通过、不启动定时器、不触碰记账 |
| `intervalHours` | `168` | 两次通过之间的最小小时数 |
| `minIdleHours` | `2` | 通过运行前所需的最小观测闲置小时数 |
| `tickMinutes` | `15` | host 范围到期检查之间的小时数 |
| `staleAfterDays` | `30` | `active` 进入 `stale` 的闲置天数 |
| `archiveAfterDays` | `90` | `stale` 进入 `archived` 的闲置天数 |
| `protectedNames` | `[]` | 豁免自动流转的技能名，如计划引用 |
| `pruneBuiltins` | `true` | 从通过中剪除随包内置技能；hub 来源始终豁免 |
| `backup.enabled` | `true` | 快照与台账写入的总开关 |
| `backup.keep` | `5` | 修剪后保留的快照 tarball 数 |
| `archiveTtlDays` | `0` | 归档技能等待清理的闲置天数；零表示永不清理 |
| `consolidate` | `false` | 可选的、对 agent 创建技能的 LLM 归并 |
| `provider` | 未设 | 归并的 provider 路由；与 `model` 一同设置 |
| `model` | 未设 | 归并的模型 id；开启 `consolidate` 时必需 |
| `maxInputBytes` | `65536` | 归并调查框定的字节预算 |
| `maxOutputTokens` | `2048` | 每次归并请求的输出 token 上限 |
| `maxSteps` | `4` | 有界工具循环可花费的归并请求数 |
| `timeoutMs` | `60000` | 一次归并运行的截止时间 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-curator)是每个可接受字段的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

存储域 `evolution_curator`（版本 `1`、布局 `per-record`、表 `meta`）中单个键 `state` 下的一行记账。流转经由 `ctx.get` 通过技能遥测应用，因此存储未挂载时整理退化为记账而不是失败；目录中未知的名称记入 `custom` 来源，而不是逃出整理。时钟与闲置观测以 `run`/`maybeRun` 的调用参数到达，而挂载后的插件补上 host 范围的部分：一个保存最新活动时刻的 `session/event` 监听、一次被 await 的启动时到期检查，以及一个经 `ctx.effect` 处置的 `unref()` 定时器。规格用假定时器驱动到期与闲置转换，因此插件不携带任何仅测试用的时钟接缝。

### 归并

`consolidate` 默认关闭，且产生真实模型调用。开启时，真实通过调查处于 `active` 或 `stale` 状态的 agent 创建技能，在 `maxInputBytes` 内框定它们，并在 fork 启动前追加一条 `cost` 台账行 `{inputBytes, maxOutputTokens, provider, model, truncated}`。fork 是 `ctx.llm` 之上的有界进程内工具循环，白名单只有两个工具：`skill_view` 读取一个候选包，`skill_apply` 为每个候选记录一条裁决（`keep`、`patch`、`consolidate`、`archive`）。循环至多花 `maxSteps` 次请求，并在首个纯文本回答处结束；请求失败会抛出，运行的截止时间在 `timeoutMs` 处中止它，插件处置时同样中止。

所有写入都由整理器执行，因此无论模型要求什么，整包规则都成立。`patch` 就地重写 `SKILL.md`。`consolidate` 裁决把候选的整个目录搬到伞技能之下（`<umbrella>/<name>/`），把被搬移树中每一处 `${DSH_SKILL_DIR}` 引用改写为新的相对根，并向伞技能的 `SKILL.md` 追加一条引用——随包携带 `references/`、`templates/`、`scripts/` 或 `assets/` 的包绝不会被压平成只剩 `SKILL.md`。`archive` 裁决把整个目录搬入技能旁边的 `.archive/`。伞技能缺失、不可写，或已占用同名目录时，包原地不动，该裁决计入跳过。归并记一条携带两端点的 `move` 台账条目；生命周期移动与自动通过走同一套快照、`pass` 与 `transition` 机制；`rollbackPass` 把每个被搬移的包搬回并恢复生命周期状态。

host 插件无法无头 fork subagent 接缝——进程内 provider 从活跃的父会话继承路由，而整理器没有会话——因此循环在进程内运行。

### 通过安全

有移动的真实通过在整理器家目录下写一个 tarball（`snapshots/pass-<时间戳>-<id>.tar.gz`，修剪到 `backup.keep`）：暂存的前后记录对、可解析的技能目录与清单。不可解析的名称进入通过证据，而不是失败。一条 `pass` 台账条目加每次移动一条 `transition` 条目追加到只增 JSONL 台账，前后记录 blob 按内容寻址存储。`rollbackPass` 与 `rollbackEntry` 恢复生命周期状态——永不恢复被补丁过的正文——先验证全部记录、blob 与已记录的包搬移，先快照当前记录使每次回滚可逆，并为每个技能或每次反向搬移记一条 `rollback` 条目。未知标识、缺失 blob、未跟踪技能、记录路径已消失或原始路径已被占用的被搬移包，以及缺失存储，都在一切写入之前失败。归并在运行后的布局上对包做快照，因此其 `move` 条目就是运行前路径的记录。

### 认领与清理

`adopt` 经由遥测 `markAdopted` 写入，把一个 agent 创建的技能认领为用户主导，并记一条操作者台账条目；非后台作者身份一律拒绝，且该移动单向。`purge` 删除超过 `archiveTtlDays` 的归档技能：先删技能目录（不可解析时仅删记录），再遗忘记录，再为每个技能记一条操作者台账条目。置顶技能保留，零 TTL 什么都不删，`dryRun` 只预览删除名单而不写入。`passes` 按新到旧列出已记录的通过，供状态界面与回滚选择使用。`surveyCandidates` 列出 agent 创建的技能及其裁决证据——路由、状态、闲置时长与使用计数，按名称排序——不写入；保留/补丁/归并的裁决另行到来。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`EvolutionCurator` 服务、通过逻辑、host 范围触发、回滚与记账 |
| [`src/consolidate.ts`](src/consolidate.ts) | 归并 fork：调查框定、有界工具循环与整包规则应用器 |
| [`src/safety.ts`](src/safety.ts) | 快照、台账、blob、修剪、包搬移与回滚读取路径 |
| [`src/spec.ts`](src/spec.ts) | 域声明：记账模式与 `defineDomain` 规范 |
| [`src/types.ts`](src/types.ts) | 公共运行选项、流转、报告、回滚与通过类型 |

### 失败与恢复

失败的流转向上传播并停止本次通过：此前的移动有效，报告丢弃，记账保持未盖戳，因此下次通过重新检查每个技能。计划触发的失败被捕获并告警，定时器与记账保持完好以便下次滴答。非法记账会导致域打开时大声失败：丢失的 `lastRunAt` 会重跑首次递延并推移整个计划。启动前读取抛错。处置时会中止进行中的归并运行。

不发布 invariant 伴生包，因为域表是该状态的唯一副本，不存在第二个可供核对的独立观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 规范](../../../specs/evolutionary-harness.spec.md)——本包实现的行为契约。
- [evolution 包导览](../README.zh.md)——本分组的软件包及其仓库位置。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-curator)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

自动流转不注册任何面向模型的内容。只有可选的归并会调用模型。

### 归并 fork

#### 模型看到什么

一条辅助 user 消息，携带固定指令加 JSON 候选调查；随后是 assistant 工具调用与整理器的工具结果。请求恰好声明两个工具：

##### 工具白名单

```text
skill_view(name, file?)                 — read one candidate package
skill_apply(name, action, into?, body?) — record one verdict
```

#### Token 影响

有上限：每次运行至多 `maxSteps` 次请求，每次受 `maxInputBytes` 的框定调查加上先前工具结果，以及 `maxOutputTokens` 的补全约束。

#### KV Cache 影响

与活跃请求无关：归并是带自有前缀的独立一次性交换，因此不会使会话上的 provider 缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本整理器不适用的场景。它们是当前包约束。

- **归档包会搬文件，处置生命周期状态不会**——自动的 `stale → archived` 流转只是遥测，而归并的 `archive` 裁决会把整个目录搬入 `.archive/`。
- **回滚恢复状态与搬移，不恢复被补丁的正文**——`patch` 裁决仅为审计记账；`rollbackPass` 恢复生命周期状态与被搬移的包，永不恢复先前的 `SKILL.md` 文本。
- **归并在进程内运行**——host 插件无法无头 fork subagent 接缝，因此工具循环跑在 `ctx.llm` 上而非子 agent 上。
- **归并改写目录引用，不改写计划条目**——归并改写被搬移包内的 `${DSH_SKILL_DIR}` 路径；目前没有任何计划条目引用技能，因此 `protectedNames` 仍是计划引用的护栏。
- **认领单向**——被认领的技能保持用户主导来源；没有任何操作能将其送回 agent 创建。
- **清理默认关闭**——`archiveTtlDays` 默认为零，因此归档技能会一直累积，直到选定 TTL。
- **受保护名称是显式的**——计划引用经由 `protectedNames` 进入，直到出现计划到技能的接缝将其自动接线。
- **仅限本机**——记账位于 `$DSH_HOME` 之下，永不写入项目目录内。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
