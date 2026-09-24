---
description: "只读的 kernel 命令行：针对已存会话已有的 kernel 记录提供 dsh task 与 dsh policy 命令，外加基于已记录实验信封的 dsh evolution replay。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-kernel-ops

[English](README.md) | 中文

## 概述

通过 `dsh` 读取已记录的 kernel 状态，无需启动 agent。`dsh task show`、`verify`、`checkpoint`、`metrics`、`recover-scan` 与 `dsh policy explain` 分别报告某会话的契约、验证、检查点、计数器、恢复状态或策略决策。`dsh evolution replay` 读取一份已记录的实验。所有命令均只读。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`dsh` CLI 把 `task` 与 `policy` 两个命令族路由到这里：每次调用都会启动 `kernel-ops` profile——`dsh-base` 加本 bundle——并原样保留命令行。

```text
dsh task show <session-id> [--json]
dsh task verify <session-id> [--json]
dsh task checkpoint <session-id> [--json]
dsh task metrics <session-id> [--json]
dsh task recover-scan [--json]
dsh policy explain <session-id> <action-id> [--json]
dsh evolution replay <run-id> [--json]
```

按 id 指定的 `task` 或 `policy` 命令要求指定会话存在且已记录 kernel 事件。`dsh task recover-scan` 则报告 kernel 启动时一次性扫描发现的所有已存非终态或不可读 kernel 会话；它要求 profile 挂载 `@deepseek-ai/dsh-agent-kernel` 与 session persistence。`evolution replay` 从 lineage 存储读取 run id；若部署省略该存储，则报告 `the evolution lineage store is not mounted`。

`dsh task recover-scan` 在任一条目为可修复或受阻时以非零码退出；结果为空或条目均可继续时退出码为零。`dsh task verify` 在存储的门禁受阻或从未记录验证时以非零码退出。`dsh task checkpoint` 输出最新检查点；若未记录过，则以非零码退出。

### 你将得到

| 命令 | 输出内容 |
|---|---|
| `task show` | 目标、状态、修订号、profile、工作区、计划修订与步骤、步数与工具调用计数、未闭合动作、未解决失败、证据/断言/假设数量、最新检查点 |
| `task verify` | 最新记录的验证结果、每条验收准则的结果、未解决失败，以及完成闸门的判定 |
| `task checkpoint` | 最新检查点的标识、原因、状态、修订号、会话序号与创建时间 |
| `task metrics` | 该会话的 Kernel 事件所蕴含的计数器：任务与终态、验证次数与通过率、步数与工具调用、动作结果、策略拒绝与询问、被驳回的审批、按类别统计的失败、恢复决策、检查点与恢复次数 |
| `task recover-scan` | 每个非终态或不可读的已存 kernel 会话、其可继续/可修复/受阻分类及依据 |
| `policy explain` | 提案（`tool`、`source`、`trust`、任务修订号、参数）、合成决策（effect、是否强制执行、能力授予、sandbox 模式与根目录、依据）、审批结果，以及该动作是否仍未闭合 |
| `evolution replay` | 该实验的技能、结果、算子、候选、任务、实测三元组、回归项、依赖版本，以及它运行所用的种子，均来自 `ctx.evolutionLineage` |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

`task show`、`task verify`、`task checkpoint`、`task metrics` 与 `policy explain` 通过 `ctx.sessionPersistence` 以只读方式打开所选日志，再用 `readKernelRecord` 折叠。`task recover-scan` 等待 `ctx.agentKernel.startupRecovery`，即 session persistence 可用时启动的同一次扫描。`evolution replay` 读取 `ctx.evolutionLineage`。此折叠由 kernel 自己拥有，因此命令报告的就是 live kernel 从这些事件推导出的状态。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 命令行：每个命令一个 action，读取、折叠、输出，然后请求启动器退出 |
| [`src/report.ts`](src/report.ts) | 折叠记录的文本与 JSON 投影，两种界面读取同一形状 |
| [`src/internals.ts`](src/internals.ts) | 测试替换 stdout 与 stderr 所用的写入器 |
| [`cordis.patch.yml`](cordis.patch.yml) | 本 bundle 向其 profile 插入的行：命令行本身与 evolution-lineage 存储 |
| — | 未发布运行时不变式伴生插件；这些命令除 kernel 自身的不变式外不新增任何不变式，而那由 kernel 包拥有。 |

命令从不推断：日志无法判定的闸门就是 `unknown` 或 `never run`，缺失检查点则以非零码退出，而不是输出空内容。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent kernel](../../runtime/agent-kernel/README.zh.md)——这些命令读取的 ledger、完成闸门与事件族。
- [app-boot](../../boot/app-boot/README.zh.md)——`kernel-ops` profile 如何解析其 bundle。
- [dsh CLI](../../../apps/cli/README.zh.md)——把 `dsh task` 与 `dsh policy` 路由到这里的启动器。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这些命令在任何 agent 之外运行，不访问模型，也不写入任何会话事件。

#### KV Cache effect

无。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **按设计只读。** 暂停、恢复或对**正在运行**的运行打检查点，属于拥有该 agent 的进程；本命令行只报告已存会话的记录状态，不追加任何内容。
- **是记录，不是重新评估。** `task verify` 报告会话记录的准则结果；它不会重新运行验证器。
- **完整日志读取。** 单会话命令读取所选日志的全部内容；启动扫描会各读一次已存日志，因此成本随持久化会话库增长。
- **`evolution replay` 轮询而非注入其存储。** lineage 存储作为普通同级行挂载，而非硬性插件依赖，因此省略它的部署里 `task`/`policy` 命令仍能正常工作；该命令最多轮询 300ms 后才报告未挂载，以覆盖存储自身的异步启动，同时不让整条命令行都卡在它上面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
