---
description: "面向 agent-kernel 完成门禁的命令式验收判据验证器：每条已配置的判据都通过 ctx.shell 运行一条 shell 命令，并记录 pass、fail 或超时，供需要让任务的“完成”建立在证据之上的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-verifiers

[English](README.md) | 中文

## 概述

当任务必须凭证据而非模型声明来完成时，就使用这个包。agent kernel 不自带任何判据验证器，因此一条必需判据若没有任何验证器认领，就会保持 `unknown` 且永远无法完成。本插件按部署为判据 id 或验证器族声明的内容回答判据：通过 `ctx.shell` 运行的一条 shell 命令，其退出状态决定判据结果。`diff` 判据，或绑定到变更契约的判据，都不需要命令——任务改动的范围即可判定。未配置的判据保持未解析。

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

当任务声明了验收判据时，把本插件与 `@deepseek-ai/dsh-agent-kernel` 及一个 shell 执行器一起挂载。kernel 注入其注册表，因此挂载顺序无关紧要；shell 执行器在验证时查找，因为只配置 `diff` 判据的组合不需要任何执行器。

### Minimal composition

```yaml
- name: '@deepseek-ai/dsh-agent-kernel'
  config:
    acceptance:
      - id: unit-tests
        description: the package's tests pass
        verifier: test
        required: true
      - id: scope
        description: only the package's own sources changed
        verifier: diff
        required: true
- name: '@deepseek-ai/dsh-command-verifiers'
  config:
    verifiers:
      unit-tests:
        command: pnpm vitest run
        args: ['--config vitest.config.ts']
        cwd: packages/x
        timeoutMs: 600000
        expectedExitCodes: [0]
      diff:
        expectedPaths: ['packages/x/**']
```

### Configuration

| Field | Required | Meaning |
|---|---|---|
| `verifiers` | yes | 以验收判据 id 或验证器族为键的目标表。空表会让加载失败：此时插件无法回答任何判据。 |
| `verifiers.<claim>.command` | with a command target | 通过 `ctx.shell` 运行的 shell 命令行。 |
| `verifiers.<claim>.args` | no | 追加到 `command` 的 shell 文本，按顺序以单个空格分隔。当 shell 需要把某个参数当作字面量时，在此处加上引号。 |
| `verifiers.<claim>.cwd` | no | 命令的工作目录。缺省时使用执行器自身配置的目录。该值会作为判据结论的证据引用记录。 |
| `verifiers.<claim>.timeoutMs` | with a command target | 以毫秒计的墙钟上限；超时的运行会让该判据失败。shell 执行器可能将其收紧到自己的上限。 |
| `verifiers.<claim>.expectedExitCodes` | with a command target | 视为通过的退出码，取非空的整数列表。 |
| `verifiers.<claim>.expectedPaths` | with a scope target | `diff` 判据中每个改动范围都必须匹配的、相对于工作目录的 glob。 |
| `verifiers.<claim>.contract` | with a contract target | `true` 表示由任务改动的范围与任务自己声明的变更契约比对来判定该判据。边界来自任务而非本文档，因此一个条目覆盖所有声明了契约的任务。 |

若某个条目同时声明命令与期望路径、既没有命令、也没有非空的 `expectedPaths`、也没有 `contract: true`，或使用了其类别无法使用的字段（`expectedPaths` 旁的 `timeoutMs`、`contract` 旁的命令或范围字段、空命令或空键），插件加载会失败，而不是静默地加载成一个无效构件。所有被接受的字段都列在生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-command-verifiers)中。

### Which criterion a target claims

判据先由自身的 id 认领，其次才由它的 `verifier` 族认领。上面的 `unit-tests` 因此只覆盖那一条判据，而 `diff` 覆盖所有族为 `diff` 的判据。没有任何目标认领的判据保持未解析，kernel 会将其报告为 `unknown`，而不会判为通过。

### 本组回答哪些族

此表把 §8.1 的每个验证器族映射到为其提供验证器的插件。下表中任一族的判据仍可由命令判定：kernel 会询问第一个认领该判据的已注册验证器，因此部署可以为任何族声明命令目标，而当两个验证器回答同一族时，挂载顺序决定谁先。

| §8.1 族 | 由谁回答 | 方式 |
|---|---|---|
| `build`、`test`、`lint`、`typecheck`、`assertion` | 本插件 | 部署为判据的 id 或族声明的命令 |
| `diff` | 本插件 | 改动范围与 `expectedPaths` 或任务声明的变更契约比对 |
| `security`、`browser`、`review` | [`agent-verifiers`](../agent-verifiers/README.zh.md) | 每条判据一个独立的审查者子代理 |
| `human`、`research` | 本处不提供验证器 | 拥有人类证据与已记录研究主张的插件 |

### What you get

| Criterion outcome | Verdict |
|---|---|
| 命令以被接受的退出码结束 | `pass` |
| 命令以其他退出码结束 | `fail`，并带上结束状态行与被保留的输出尾部 |
| 命令超过 `timeoutMs` | `fail`，并指出被超过的上限 |
| 命令无法启动、工作目录不可用，或没有挂载 shell 执行器 | `fail`，并说明未运行的原因 |
| 每个改动范围都匹配 `expectedPaths` | `pass`，并带上它检查过的范围 |
| 有改动范围落在 `expectedPaths` 之外 | `fail`，并恰好带上落在范围之外的那些路径 |
| 每个改动范围都留在任务所声明的契约之内 | `pass`，并带上它检查过的范围 |
| 改动破坏了某条已声明的边界 | `fail`，并指出每条被破坏的边界以及破坏它的范围 |
| 契约目标认领了该判据，而任务没有声明契约 | `fail`，并指出该目标：被认领的判据绝不静默地保持未解析 |

每个命令判据的结论都会记录命令行、被保留的输出与可接受的退出码集合，因此会话日志的读者能够重建当时运行了什么、以及它为何如此判定。

---

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

本节说明一条判据如何变成结论；可观察到的行为已在 [Use this package](#use-this-package) 中完整覆盖。

### Design concept

配置在加载时一次性解析成一张完整指定的目标认领表：`resolveTargets` 会拒绝每个永远无法判定判据的条目，验证器随后在这张表中查找判据，而不是每次调用都重新读取部署文档。这里没有隐藏的默认值——`timeoutMs` 与 `expectedExitCodes` 必须声明，绝不假定——因此已配置的目标不可能悄悄运行与部署所写不同的东西。命令以一份 `ShellExecRequest` 运行，并带 `onExpiry: 'kill'`，因此执行器自身的截止时间、输出上限、溢出文件与中止处理都原样生效；被中断的运行会把 `timedOut`、`aborted` 与退出状态作为彼此独立的事实报告，仅凭一个被接受的退出码绝不会把其中任何一种变成通过。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`name`、`agentKernel` 注入、`Config` 与注册 effect |
| [`src/targets.ts`](src/targets.ts) | 配置解析与期望路径的 glob 匹配 |
| [`src/contract.ts`](src/contract.ts) | 变更契约比对：哪些改动范围破坏了哪条已声明的边界 |
| [`src/verifier.ts`](src/verifier.ts) | `CriterionVerifier` 本体：认领查找、命令运行与结论 |
| [`src/types.ts`](src/types.ts) | 配置与已解析目标的词汇 |
| — | 不发布运行时不变式伴随包；验证器除自身配置外不持有状态，每个结论都由入参推导，因此第二种观测不可能与之分歧。 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

当包级契约不够用时，请阅读以下页面。它们从目标表走向消费其结论的门禁，以及运行其命令的执行器。

- [Agent kernel 子系统参考](../../../docs/subsystems/agent-kernel.zh.md) — 完成门禁、`CriterionVerifier`，以及注册表对已注册验证器施加的顺序与超时。
- [Shell 子系统参考](../../../docs/subsystems/shell.zh.md) — request/spec 拆分、`ShellRunResult`，以及判据详情所取自的输出上限与溢出文件。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-command-verifiers) — 本插件接受的每个字段。
- [runtime 组索引](../../runtime/README.zh.md) — 本插件所服务的 kernel 与 context 包。

-----

<a id="model-experience"></a>
## Model Experience

### Failed required criterion

#### What the model sees

不新增任何提示词段落，也不新增任何工具 schema。本验证器自身的文本——判据 id、结束状态行、被保留的输出尾部与证据引用——都停留在持久的 `verification/result` 记录中。唯一可见于模型的结果是间接的：kernel 在失败回合后转向的修复消息会以 `required criterion "<id>" is fail` 的形式指出该判据。

#### Token effect

不直接增加任何 token。每条命令的输出都保留在会话日志与验证器的结论里，绝不进入请求；紧随其后的修复消息为每条失败判据只支付一行短项目符号，无论该命令打印了多少内容。

#### KV Cache effect

独立：不注册提示词段落，也不注册 schema，因此请求前缀永不改变；修复消息是追加到失败回合之后的对话，而不是改写它。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本插件在哪些情况下并不合适。它们是当前的包约束，不是待办清单。

- **验证接缝不携带 `AbortSignal`** — `VerificationRequest` 没有取消通道，因此正在运行的命令只能由其 `timeoutMs` 或组合拆卸来停止。不要把上限配置得超过它不应越过的那个回合。
- **kernel 的验证器上限仍然生效** — `CriterionVerifierRegistry` 会以 `verifierTimeoutMs`（默认 60 秒）包住本验证器，因此 `timeoutMs` 更长的命令会先被报告为超限，而不是运行完成。与长命令搭配时请同时提高 `verifierTimeoutMs`。
- **每条判据一条命令** — 同时需要 typecheck、lint 与 test 的判据要么声明三条判据，要么自行组合 shell 命令行；多命令目标未实现。
- **期望路径相对于工作目录** — `request.changedScopes` 携带相对于会话工作目录的路径（工作目录之外则是绝对路径），因此 glob 只能匹配相对形式：工作目录之外的绝对改动路径永远无法匹配。
- **保留输出的边界由执行器决定** — 判据详情携带执行器收集到的 stdout 与 stderr 尾部，各自受该执行器自身输出配置约束（`bash-local` 每个流默认 64 KiB），发生截断时完整流位于溢出路径。本包不额外增加上限，也无法比持有输出的执行器收得更紧。
- **没有结果缓存** — S6 中按判据 id 与仓库摘要索引的 `CriterionResult` 缓存属于门禁而非本包；重新验证会再次运行命令。
- **契约比对的是范围，不是文件内容** — 每条边界都针对 `request.changedScopes` 求值，也就是 `workspace/changes` 记录器为该轮发布的路径。比对不读取任何文件、也不需要工作树，因此被保留的文件即便被改写为完全相同的字节，仍算作被改动；而针对记录器从不报告的路径声明的边界则永远不会被破坏。
- **声明了却没有任何边界的契约会放行一切改动** — 五个列表全为空的契约会让该判据通过，并在详情中说明这一点。完全不声明契约目标的部署则不会认领任何判据，这正是该目标类别所保持不变的既有行为。
- **边界由任务声明，而不是由本文档声明** — 契约随验证请求抵达验证器，因此部署可以认领该判据，却不能写下边界；调用方未在任务上声明契约时，被认领的判据会失败而不是通过。
- **命令以执行器的权限运行** — 本插件不额外施加任何隔离：沙箱执行器会约束它们，本地执行器不会，判据的可信度只能等同于运行它的组合。
- **真实组合测试需要 POSIX shell** — 其 `cordis.yml` 挂载 `dsh-bash-local`，因此 `vitest.config.ts` 在 win32 上排除该套件；单元测试套件在所有平台上覆盖本包的源码。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

本 Dev Note 是维护者的工作上下文：是尚未决定的开放问题与方向。它明确不具权威性——已发布的行为、限制与被接受的取舍都在上面的章节、包代码与所链接的 Agent Note 中。

曾考虑过的替代方案是一个 `ctx.criterionVerifierRunner` 服务，由它持有已配置命令供任意验证器调用，以及按判据拆分的插件。那个服务会成为与 kernel 已拥有的注册表并列的第二张注册表，而按判据拆分则把部署的 shell 行散落到组合中而非集中在一份文档里。一个插件配一张已解析的认领表，把配置、配置校验以及由此得到的结论放在同一处，并让 kernel 继续作为门禁顺序、超时与完成判定的唯一所有者。

</details>
