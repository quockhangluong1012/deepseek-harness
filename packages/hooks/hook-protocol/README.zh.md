---
description: "Claude Code 与 Codex 桥接背后的共享钩子规则——钩子能做什么、运行时会发生什么——供 hooks 子系统的用户与维护者阅读。"
kind: "package-library"
---

# @deepseek-ai/dsh-hook-protocol

[English](README.md) | 中文

## 概述

`dsh-hook-protocol` 让两个桥接以相同方式处理你的钩子：它定义钩子能做什么、运行时会发生什么。你无需自行安装或配置它——选择 `dsh-hooks-claude-code` 或 `dsh-hooks-codex`，把它指向你现有的 `hooks.json`，这些规则就会作用于你的钩子。通过任一桥接，钩子都可以带一条模型可见的消息阻塞提示词或工具调用、向对话附加额外上下文，或让运行停止。command 与 HTTP 钩子会运行；`mcp_tool`、`prompt` 与 `agent` handler 会被跳过并给出警告。

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

你无需直接安装或配置本包——挂载 `dsh-hooks-claude-code` 或 `dsh-hooks-codex` 就会把这些规则应用到你的 `hooks.json` 钩子上。用本页了解钩子能做什么、运行时会发生什么；两个桥接页面列出各方言支持的事件。

### 何时选择

当你持有现有的 Claude Code 或 Codex 钩子、希望它们在 agent（智能体）运行期间继续工作时，选择 `dsh-hooks-claude-code` 或 `dsh-hooks-codex`。你永远不会直接选择本包。没有参考工具对应物的定制行为请避开整个组：原生 Cordis 插件拥有完整的 harness API，无需中间的钩子协议。

### 钩子能做什么

- **带消息阻塞操作**——退出码为 2 的钩子会停止提示词或工具调用，其错误输出会作为原因展示。
- **工具运行前请求确认**——Claude Code 钩子可以请求确认而非直接阻塞；Codex 桥接不呈现此选项。
- **附加上下文**——钩子可以返回额外文本，模型会在下一次请求中看到。
- **在选定时刻运行**——钩子配置按名称或 pattern 选择触发的事件；缺失、空或 `'*'` pattern 表示该类的每个事件。
- **失败不停止运行**——除 2 以外的任何退出码都是非阻塞失败：操作继续，失败被记录；完全无法启动的钩子按同样方式处理。
- **请求运行停止**——钩子可以请求运行停止（`{"continue": false}`）：桥接会取消运行，运行随后以中止结束其轮次，并携带该钩子的 `stopReason`；该请求也会记录在 `hook/result` 事件中。若钩子运行的时刻早于运行存在，或晚于运行消失，则改为记录该请求并给出警告。
- **触达 HTTP 端点**——Claude Code 的 `{ "type": "http", "url": … }` 钩子会把同样的 JSON 载荷 POST 到其 URL，其响应体会与 command 钩子干净退出时的 stdout 完全同样地解码。

### 钩子运行时你会看到什么

- 钩子阻塞时，操作不会发生，钩子的消息会被展示。
- 钩子附加上下文时，模型会在下一次请求中看到该文本。
- 钩子停止运行时，轮次以中止结束，其原因就是该钩子的 `stopReason`（钩子未给出时则为 hook 点）。
- 失败的钩子——命令错误、崩溃或除 2 以外的任何退出码——会被记录，不会停止 agent。
- 失败的 HTTP 钩子传输是唯一的例外：它会失败关闭，以该失败为原因拒绝该操作，并把该决定记录为 `transport-error`。
- 如果某个配置层无法读取或解析，桥接会记录警告并跳过该层；其他层与 agent 仍会启动。
- 混合钩子类型的配置仍然可用：`mcp_tool`、`prompt` 与 `agent` handler 会被跳过并给出警告，其 command 与 HTTP 钩子照常运行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释本库背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 处理流水线

本库是一串单一用途的步骤，每个步骤一个函数：校验 matcher pattern、通过其传输运行 handler（command 用 `dsh-shell` 执行器，HTTP 端点用一次带超时的 POST）、解码结果、读取一层已解析的钩子配置作为下一个优先级层、把每个匹配 hook 的结果合并为最严格的一个结果、把折叠出的停止应用到活动运行，并记录持久的 `hook/*` 事件对。matcher 的 `mode` 参数是两个方言唯一的差异轴——`claude-code` 把 pattern 解释为字面量备选或正则，`codex` 始终解释为未锚定正则。每个步骤都会降级为受控结果而不是抛异常，因此钩子永远不会使调用轮次崩溃：无效正则是运行时的不匹配，执行器拒绝会变成没有退出码的 `HookOutput`，退出码 2 以 stderr 作为原因阻塞，其他失败均不阻塞。合并应用 `deny > ask > allow` 优先级，保持首个 `continue: false` 停止的粘性，并按 hook 顺序累积上下文。脱离运行会被跟踪，因此 `fiber.dispose()` 能达到完全停稳；不变式伴生插件会拒绝位于尚未结束的轮次之外的 `hook/*` 记录。这些步骤位于 [`src/matcher.ts`](src/matcher.ts)、[`src/runner.ts`](src/runner.ts)、[`src/codec.ts`](src/codec.ts)、[`src/merge.ts`](src/merge.ts)、[`src/events.ts`](src/events.ts)、[`src/layers.ts`](src/layers.ts)、[`src/halt.ts`](src/halt.ts)、[`src/detached.ts`](src/detached.ts) 与 [`src/invariant.ts`](src/invariant.ts)。

### 分层配置发现

`readHookConfigLayers` 会按最低优先级在前的顺序读取桥接指定的各层路径，并对每一层做 JSON 解析。缺失的层会被静默跳过——未配置的层是正常的——而存在却无法读取或解析的层会被跳过并给出诊断信息，因此一个损坏的文件无法掩盖它周围的层。被两层同时指定的路径只会在其最高优先级位置读取一次，因此重复某个已发现层的 `configPath` 无法使其钩子运行两次。`mergeMatcherGroups` 随后按该顺序拼接各已解析层的逐事件配置组：第一层的钩子先运行，后续层追加，且没有任何层会移除另一层的钩子。

### 运行级停止

`mergeHookOutputs` 把 `continue: false` 折叠为粘性 `stop`，外加首个钩子的 `stopReason`。`applyRunHalt` 把该折叠出的请求变成两个桥接共同应用的唯一持久停止：它用 agent 取消 cause `{ kind: 'hook', reason }` 取消活动运行，因此循环自身的中止路径会把轮次结束原因 `{ kind: 'aborted', reason: { kind: 'hook', reason } }` 写在请求停止的那个 `hook/result` 旁边，于是这次停止可以从日志重建。没有活动运行的时刻——脱离生命周期的时刻，或运行尚不存在之前的会话开始——无法停止，因此 `applyRunHalt` 通过桥接的警告 sink 报告该请求，只留下 `hook/result` 记录。

### `hook/*` 会话事件

`hook/invoked` 与 `hook/result` 事件通过 declaration merging 合并进 `SessionEventMap`，作为仅日志记录：与 `compaction/*` 相同，它们不是 surface 事件，也不携带 `surfaceOp`。`hook/result` 按 `handlerId` 与其 `hook/invoked` 配对，决策规则由 `appendHookResult` 负责。载荷与逐事件 JSDoc 位于生成的[持久化日志事件目录](../../../docs/persistence-catalog.zh.md)中。

调用与结果记录必须位于尚未结束的轮次内：`UserPromptSubmit`、`PreToolUse`、`PostToolUse` 与 `Stop` 按构造满足该关系，而 `SessionStart` 在轮次 1 之前运行、没有 `hook/*` 记录——改为投递其注入的上下文。不变式伴生插件注册到 `ctx.invariants`，拒绝在尚未结束的轮次之外追加的 `hook/*` 事件、没有匹配 invoked 的结果、未知方言或非有限时长。

### 带类型的 hook 贡献

每个匹配 hook 的输出会且仅会被归类为一种贡献类型：`observe`、`annotate`、`inject-untrusted-context`、`request-policy-change` 或 `veto`（`classifyHookOutput`，以及按 hook 顺序的 `MergedHookOutcome.contributions`）。这些类型有强弱次序，但都不携带能力：hook 可以否决某个动作、请求策略所有者裁决，或把上下文作为不可信数据注入；只有内核或策略所有者才会把这种请求变成授权。因此 hook 的 `allow` 只是建议——两个桥接都只消费 `deny` 与 `ask`，策略所有者之外的任何代码都不得把 hook 的同意当作授权。凡是把 `inject-untrusted-context` 输出转成模型消息的桥接，都会在其前面加上共享的 `UNTRUSTED_HOOK_CONTEXT_NOTICE`，因此无论这段内容落在哪里，都会读作不可信的外部数据，而不是一条指令。

### 设计理念

- **把唯一差异轴收拢进 `mode`。** 两个方言只在 matcher pattern 的解读方式上不同，因此 matcher 把 mode 作为参数，而不是复制引擎。
- **执行器拥有进程控制。** 命令通过 `dsh-shell` 执行器运行，而非自建 spawn：执行器已经提供了协议所需的已清理但可覆盖的环境、进程组取消与超时。
- **两种传输，一套解码规则。** HTTP 钩子的响应体与 command 钩子干净退出时的 stdout 由同一个例程解码，因此两种形态只产出同一种 `HookOutput`，差异仅在传输。传输故障是唯一失败关闭的路径，因为无法作答的端点绝不能静默放行该操作。
- **一个停止原语。** 两个桥接都通过同一个 `applyRunHalt` 折叠 `continue: false`，因此无论哪个桥接触发钩子，持久证据（`hook/result` 旁的中止原因）都完全相同。
- **绝不向循环抛异常。** 每种失败模式——格式错误的 JSON、无效正则、执行器拒绝——都会降级为受控的结果或不匹配，因此钩子永远不能使调用轮次崩溃。
- **仅日志、轮次内的事件。** `hook/*` 记录是「运行了什么、决定了什么」的持久证据；它们不是 surface 事件，不变式伴生插件会拒绝尚未结束的轮次之外的记录。

[hook-protocol-lib Agent Note](../../../.agents/notes/archived/feature/2026-06-30-hook-protocol-lib.md) 记录了共享与逐方言的划分以及备选方案。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 每个原语与事件辅助函数的公开导出 |
| [`src/matcher.ts`](src/matcher.ts) | 匹配全部哨兵、字面量或正则模式、校验与运行时匹配 |
| [`src/runner.ts`](src/runner.ts) | 通过 `ctx.shell` 的 `runHook` 执行与 `DEFAULT_HOOK_TIMEOUT_MS` |
| [`src/codec.ts`](src/codec.ts) | 退出码与结构化 stdout 解码为 `HookOutput` |
| [`src/merge.ts`](src/merge.ts) | 最严格合并与 `MergedHookOutcome` 类型 |
| [`src/contribution.ts`](src/contribution.ts) | `classifyHookOutput` 与五种 `HookContributionKind` |
| [`src/events.ts`](src/events.ts) | `hook/*` 事件声明、追加辅助函数、stderr 摘要 |
| [`src/detached.ts`](src/detached.ts) | 脱离运行的完全停稳跟踪 |
| [`src/types.ts`](src/types.ts) | `HookOutput`、`MatcherGroup`、`CommandHook` 与 `hook/*` 载荷类型 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：配对、轮次包裹、方言与时长检查 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享规则进入应用这些规则的桥接，以及它们所面向的扩展点。

- [hooks 组地图](../README.zh.md)——同级组页面及其包表。
- [hook-protocol-lib Agent Note](../../../.agents/notes/archived/feature/2026-06-30-hook-protocol-lib.md)——协议核心为何共享、各桥接负责什么。
- [钩子桥接 Agent Note](../../../.agents/notes/archived/feature/2026-06-30-hook-bridges.md)——两个桥接如何使用这些原语。
- [拦截扩展点 Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-interception-extension-points.zh.md)——桥接所映射的类型化 Decision 接口面。
- [生成的持久化日志事件目录](../../../docs/persistence-catalog.zh.md)——`hook/*` 事件载荷与逐事件 JSDoc。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-hooks-claude-code` 与 `dsh-hooks-codex` 间接影响；它们是将解码后的 hook 输出渲染为模型上下文的唯一消费方。

#### KV Cache 影响

不会直接失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制描述钩子目前还无法通过共享引擎做到的事情。它们是当前包约束，而非任务积压。

- **`HookOutput.updatedInput` 会被解析但不会应用**——输入改写是已延期的一致性设计问题（见 [pre-tool-input-rewrite Agent Note](../../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.zh.md)）；当 hook 设置它时，桥接会记录并警告。
- **停止会被上报，但在没有活动运行之处无法生效**——`mergeHookOutputs` 把 `continue: false` 折叠为粘性 `stop`，桥接会通过 `applyRunHalt` 取消运行；但在脱离生命周期的时刻，或运行尚不存在之前的会话开始，没有可取消的运行，因此桥接只给出警告并留下 `hook/result` 记录。
- **只有 command 与 HTTP handler 会运行**——协议通过 `dsh-shell` 执行 `{ type: 'command', command, timeout? }`，并以一次带超时的 POST 执行 `{ type: 'http', url, headers?, timeout? }`；桥接会解析并跳过其方言定义的其他形态（`mcp_tool`、`prompt`、`agent`）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

无。

</details>
