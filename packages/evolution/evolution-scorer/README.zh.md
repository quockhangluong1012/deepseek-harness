---
description: "基于录制会话语料的度量式改进评分：工作区差异给出通过与否、计费 token 取自宿主 token 计量器、挂钟时间取多次全新进程尝试的中位数（ctx.evolutionScorer）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-scorer

[English](README.md) | 中文

## 概述

`dsh-evolution-scorer` 把一次录制场景换算成改进决策所需的三个数字：通过与否——把工作区与 `workspace.expected/` 或该次尝试自身的起始状态比较；计费 token——取自宿主 token 计量器；挂钟时间——N 次全新进程尝试的中位数。它只对磁盘上已有的夹具评分，运行在无密钥的回放层，因此不需要 API key、也不录制任何东西——未知场景、或缺少录制会话夹具的场景，报告诚实的跳过。用它把某项改动与基线比较；需要精确转录时仍用快照套件。

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

带上语料根目录挂载本插件，然后按名称评分：

```ts
const outcome = await ctx.evolutionScorer.score({
  scenario: 'text-turn',
  agent: { binScript, configPath, tsconfigPath, profile: 'acp' },
  run: processScenarioRunner,
})
if (outcome.status === 'scored') console.log(outcome.score.pass, outcome.score.tokens, outcome.score.wallTimeMs)
```

### 何时选用

当一项改动应当由度量而非逐字节转录来评判时选它：评分器在录制语料上给出可比较的三元组，并容忍语料中并不存在的场景。进程运行器是快照 harness 的 ACP 层，针对录制的模型输出启动真实 agent；以别的方式驱动的语料（headless 的 `snapshots/session` 套件）自行提供同形状的运行器。若问题是转录或归一化 stdout 是否变化，请改用 [`dsh-session-snapshot`](../../test-support/session-snapshot/README.zh.md)；若问题是吞吐预算而非单个场景的结果，请改用 `benchmarks/`。

### 配置

语料根目录必填；尝试次数是可在 `cordis.yml` 中修改的、经过校验的成员。

### 触发器与技能评估

`shouldOptimize(usage, thresholds)` 是纯触发器，决定一个技能的已记录结果是否值得运行一次优化：至少 `triggerMinUses` 次加载且失败占比超过 `triggerFailureRate`，其中占比为 `failureCount / (useCount + failureCount)`——正是遥测记录所记录的公式。`evaluateSkill({ skill, scenarios, agent, run })` 经由已有的 `score` 为每个具名场景评分，并聚合成优化器三元组：仅当每个场景都通过时 `pass` 才成立，token 与耗时取各场景中位数之和。一个场景被跳过则整个评估随之跳过并附上理由，因为基于不完整的评估做优化等于在不存在的证据上做选择；未指名任何场景的技能同样跳过。

```yaml
- name: '@deepseek-ai/dsh-evolution-scorer'
  config:
    corpusDir: /path/to/repo/snapshots/acp
    attempts: 3
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `corpusDir` | `required` | 语料根目录的绝对路径，每个录制场景一个子目录 |
| `attempts` | `3` | 每次评分的全新进程尝试次数；中位数取自这些样本 |
| `triggerMinUses` | `20` | 失败率据以触发优化前所需的已记录加载次数 |
| `triggerFailureRate` | `0.3` | 技能触发优化必须超过的失败占比 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-scorer)是每个可接受字段的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

评分由三部分组成：计划、N 次进程尝试、归约。`loadScenarioPlan` 只读取场景目录而不运行它：ACP 输入脚本、最高代的录制会话夹具（连同子夹具），以及可选的 `replay.override.json`、`workspace/` 与 `workspace.expected/` 伴随文件。随后每次尝试以 harness 的 `replay` 模式调用调用方提供的运行器，该模式永不写入夹具。归约是纯函数：`scoreRun` 把每次尝试的最终工作区与期望捕获比较，场景不提供期望时则与该次尝试自身的起始状态比较；全部尝试都一致时 `pass` 成立，失败时报告首个发生分歧的尝试所改动的路径。token 与挂钟时间取各次尝试的中位数，每条挂钟样本都随记录一起携带。

### token 记账

计费 token 只来自 `ctx.tokenMeter.measure`。每条采集到的会话日志由 `llm-replay` 的夹具读取器读取——正是校验其可作为回放来源的那个读取器——重建为 `Session` 并度量；一次运行的数值累加每条采集到的会话，因此嵌套运行会把子会话一并计费。

### 跳过语义

语料中不存在的场景目录、缺少录制会话夹具的场景、以及缺少 `input.json` 的场景，都报告带原因的 `{ status: 'skipped' }`，且不运行任何东西。只有不存在的 `corpusDir` 才大声失败：那是配置错误，而不是被豁免的录制阶段从未产出的场景。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`EvolutionScorer` 服务、配置与尝试循环 |
| [`src/scenario.ts`](src/scenario.ts) | 语料计划：输入脚本、夹具、伴随文件与跳过原因 |
| [`src/score.ts`](src/score.ts) | 把各次尝试归约为度量三元组的纯函数 |
| [`src/workspace.ts`](src/workspace.ts) | 对捕获条目做工作区比较 |
| [`src/sessions.ts`](src/sessions.ts) | 对采集到的会话日志做 token 计量 |
| [`src/statistics.ts`](src/statistics.ts) | 对每次尝试的样本取中位数 |
| [`src/runner.ts`](src/runner.ts) | 组合传入的进程级运行器 |
| [`src/types.ts`](src/types.ts) | 公共请求、计划、尝试与记录类型 |

不发布 invariant 伴生包：评分器不持有持久状态，不存在第二个可供核对的独立观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [演进式 Harness 规范](../../../specs/evolutionary-harness.spec.md)——本包实现的行为契约。
- [evolution 包导览](../README.zh.md)——本分组的软件包及其仓库位置。
- [快照 harness](../../test-support/session-snapshot/README.zh.md)——本包所要评分的语料计划、工作区捕获与 ACP 运行器。
- [无密钥 LLM 回放](../../test-support/llm-replay/README.zh.md)——每次尝试背后的夹具读取器与回放适配器。
- [token 计量器](../../llm/token-meter/README.zh.md)——本包作为计费 token 上报的度量。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-evolution-scorer)——每个可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

无：评分只读取录制夹具并给出数字，不注册任何提示词、模式或结果文本。

#### KV Cache 影响

此处没有任何东西进入模型请求，因此 provider 缓存复用不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了评分不适合的场景。它们是当前包约束。

- **仅回放层**——每次尝试都运行无密钥的录制会话层；真实 API 比较需要同形状的运行器，且此处不存在录制路径。
- **仅 ACP 运行器**——随包提供的运行器是快照 harness 的 ACP 层，因此以别的方式驱动的语料（headless 的 `snapshots/session` 套件）需要各自的运行器。
- **单机中位数**——挂钟时间是评分主机上的单进程挂钟，而非 CPU 预算；性能门禁由 `benchmarks/` 负责。
- **整轮 token**——token 数值累加每条采集到的会话，因此嵌套运行会在承载它的每个会话上重复计入上下文。
- **无 Pareto 与扇出**——成对变体排序与 GEPA 扇出仍按规范延期。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
