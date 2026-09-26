---
description: "控制平面组合包层：带内置工具能力声明的 agent kernel 与 prompt 注入守卫，供组装或定制 dsh --profile 界面的用户阅读。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-agent-governance

[English](README.md) | 中文

## 概述

把本层加入需要记录每个会话决定、并在部署就绪后据其行动的组合包。它插入 shadow 模式的 agent kernel、让 kernel 能评估每个随包工具的内置声明、完成门禁所委派的判据验证器，以及一个记录不可信内容意图的 prompt 注入守卫。没有任何随包组合包包含它：由部署自行选择启用，先让权限文档对照真实流量度量，再把 `mode` 切到 enforce。它写入的一切都只入日志。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到组合包

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-agent-governance
dsh plugin --profile <name> remove @deepseek-ai/dsh-agent-governance
```

组合包从已安装的包解析该层，并把下面四行协调进组合；移除它则会去掉这四行。若组合包缺少某行所需的包，该行解析失败，组合包会报告未解析条目，而不是在缺行的情况下启动。

### 你会得到什么

四行，各行由它指名的包拥有。`agent-kernel` 为每个会话记录一份持久任务契约、针对其权限文档提议并裁决每次工具动作，并运行完成门禁——记录 `task/*`、`action/*`、`policy/decision`、`verification/*` 与 `failure/recorded` 事件。`agent-kernel-builtins` 声明每个随包产品工具需要什么，使 shadow 模式的 kernel 记录真实能力而非一律拒绝。`command-verifiers` 为声明了验收标准的任务回答完成门禁：每个判据 id（默认为 `typecheck`、`lint`、`test`）对应一条经由 `ctx.shell` 运行的 shell 命令，判据由该命令的退出状态决定。门禁在 `shadow` 模式下同样运行，因此让门禁生效的是为任务类别声明标准。`prompt-injection` 把工具结果与模型提议包进带污点标记的信封，命中已知规则时记录 `security/scan`，并在 `enforce` 下替换模型可见副本中的凭据。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

该组合包是覆盖在组合包其他层已组装内容之上的一份插入列表，因此其上的用户层或模式层可以按 id 改写任意一行。行顺序不承载加载语义：kernel 在自己 fiber 激活时挂上循环与工具瀑布，而内置声明伴生插件在被注入的 `agentKernel` 服务出现时即注册，与两行出现顺序无关。

除验证器外每一行都带 `shadow`。shadow 模式的 kernel 记录它本会做出的决定并放行执行，shadow 模式的守卫只记录发现、不改写内容，因此把本层加入运行中的组合包只会改变日志——绝不改变行为——直到运维编辑该行。验证器行只在任务声明了该命令所认领的判据时才运行命令，且它判定该判据，而非决定工具流水线。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 四行、它们的 `shadow` 默认值，以及每行为何独立 |
| [`src/index.ts`](src/index.ts) | 仅作文档的入口；该组合包没有运行时 API |
| — | 不发布运行时不变式伴生入口；本层加入的插件各自的不变式由其自身包拥有。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [bundle 分组映射](../README.zh.md)——所有随包层以及组合包如何叠加它们。
- [Agent Kernel](../../runtime/agent-kernel/README.zh.md)——本层使之生效的任务契约、权限文档与完成门禁。
- [内置声明](../../runtime/agent-kernel-builtins/README.zh.md)——逐工具能力表。
- [Prompt 注入守卫](../../guard/prompt-injection/README.zh.md)——规则表与它记录的信封。
- [app-boot](../../boot/app-boot/README.zh.md)——组合包如何解析并叠加其 bundle。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 kernel 与守卫各自的包，它们拥有本层可能产生的每个模型可见效果。

#### KV Cache 影响

无直接失效；被插入的各行拥有任何请求前缀变化。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

这些限制正是本层有意不做决定的部分。

- **它不随任何组合包提供**——启用控制平面是部署的选择，因此想要它的组合包需显式列出本 bundle。
- **不插入权限文档或验收标准**——权限规则、任务类别起始的标准与扫描上限属于部署自己的组合包补丁，而非本层。验证器行以工作区自己的 `typecheck`、`lint` 与 `test` 脚本作为命令，因此标准或命令不同的部署需改写该行。
- **守卫是模式匹配器**——其规则只识别已知形态，且 `enforce` 只替换凭据片段，并不证明结果安全。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

None.

</details>
