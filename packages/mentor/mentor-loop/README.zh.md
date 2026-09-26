---
description: "以插件形式实现 §20 导师质量控制循环：叠加在 agent loop、内核的断言与证据、误解引擎与学习者记录之上，从这些 seam 推导当前阶段，每步最多执行一个持久动作，并把每个阶段的指令注入导师 agent 的下一次请求（ctx.mentorLoop）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mentor-loop

[English](README.md) | 中文

## 概述

`dsh-mentor-loop` 让一次导师会话走完 §20 的质量循环。在每一次被接纳的 pre-step 上，它从会话日志、内核的断言与证据、误解流水线以及学习者记录推导学习者所处的状态；最多执行一个持久动作——记录一次检出、完成一个阶段，或计入一次复发错误；然后把当前阶段的指令作为一条注入消息追加到导师 agent 的下一次请求中。它不运行 agent loop，不调用模型，也不持有自己的状态，因此恢复后的会话会回到同一位置。

## 目录

- [使用本包](#use-this-package)
- [读取位置](#reading-the-position)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把循环与学习者记录、误解引擎一起挂载，并指定该上下文中每次会话所辅导的学习者。

```yaml
- name: '@deepseek-ai/dsh-mentor-loop'
  config:
    learnerId: user-1
    maxDirectiveChars: 2000
```

`ctx.mentorLoop.position(agent)` 读取会话所处的位置，不写入任何内容；`step(agent)` 执行该位置要求的唯一动作并返回下一个位置；已注册的 `agent/pre-step` 监听器在每一步被接纳时做同样的事，把欠下的指令追加到该步的消息里。只想要文本的调用方调用 `directiveMessage(agent)`。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `learnerId` | 必填 | 该上下文中每次会话所辅导的学习者；空白 id 会在加载时失败 |
| `maxDirectiveChars` | `2000` | 单条注入指令的 UTF-16 字符数上限 |

### 可观察行为与失败

循环选择等待而不是猜测：它无法推进的每个阶段都会指明自己在等什么，而这个名称就是调用方或监听者可以据以行动的事实。`step` 会抛出拥有方抛出的错误——没有任何模式命中的论点、当前阶段不接受的事实——而 pre-step 路径会容纳这类失败，以警告形式记录，并让该轮次的决定与其他监听器留下的一致。没有挂载 `agentKernel` 时循环停在 devil-advocate，因为会话没有任何可据以行动的断言或观察。每个不同的位置通过 `mentor/loop-position` 通告一次，该按会话保存的记忆在会话被释放时清除。

-----

<a id="reading-the-position"></a>
## 读取位置

位置在每次读取时推导，从不存储，因此恢复或回放的会话会到达同一阶段。学习者陈述的最新论点决定它；已经进行中的一次出现也会决定它，即使最新消息是对上一次教学的回应而不是重述的论点。

| §20 阶段 | 动作 | 位置停在这里的条件 |
|---|---|---|
| `observe` | `none` | 会话中还没有学习者消息 |
| `evaluate` | `none` | 最新论点没有命中目录中的任何模式 |
| `devil-advocate` | `none` | 会话中没有关于该论点的断言，或没有可反驳它的已记录观察 |
| `misconception-detection` | `detect` | 一个命中目录的论点，且带有导师的断言与已记录观察 |
| `teach`、`exercise`、`reassess` | 先 `deliver`，再 `advance` | 某个流水线阶段欠着它的指令，或学习者已在其后发言 |
| `learner-model-update` | `none` | 本循环刚刚结束的一个循环，记录尚未带上解决结果时处于等待 |

阶段只在学习者再次发言后推进，因此一轮对话无法跑完整个循环：`deliver` 把该阶段的指令放进请求，下一条学习者消息完成该阶段。`explain` 或 `counterexample` 阶段以 `delivered` 完成，`exercise` 阶段以 `attempted` 完成并带上学习者消息作为作答，`new-case` 阶段取学习者历史中本循环尚未用过的最新案例，`reassess` 阶段读取新论点：命中目录意味着误解复发，未命中意味着已解决。`repeated` 的重评还会在学习者记录上计入一次复发错误。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计要点

- **一个纯推导决定一切。** 位置是会话、内核视图、误解流水线与学习者记录已有内容的函数；循环的进度不存储，因此恢复后的会话从同一阶段继续。
- **教学文本由引擎拥有。** 本包只在引擎渲染出的指令上补上 §20 阶段的要求行、练习指引与上限，并在消息来源中写明产生该消息的阶段，因此日志可证投递过什么。
- **每步最多一个持久动作。** 一步只做检出、推进或投递之一，且一次只把一个阶段推出流水线，因此再长的对话也不会跳过一个学习者从未见过的阶段。
- **新案例来自学习者自己的案例历史。** 循环选取本循环尚未用过的最新案例，学习者没有案例时停在 new-case 阶段等待，而不是凭空造一个。
- **导师侧的故障绝不让学习者那一轮失败。** pre-step 监听器容纳该失败并记录它；由调用方自行驱动循环时，该步骤仍然照常抛出。
- **通告按会话去重。** 只有签名变化时才发出位置，记忆在释放时清空，因此监听者每个阶段和每个具名等待只看到一次。

### 源码导览

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`MentorLoop`、pre-step 监听器、`position`、`step` 与各 seam 读取 |
| [`src/position.ts`](src/position.ts) | §20 阶段清单、反证规则与纯位置推导 |
| [`src/observe.ts`](src/observe.ts) | 一次会话的派生消息所显示的内容：最新论点与最新投递的指令 |
| [`src/render.ts`](src/render.ts) | 一条注入消息的文本 |
| [`src/types.ts`](src/types.ts) | 阶段、动作、位置与注入消息的来源 |
| [`src/events.ts`](src/events.ts) | 位置通知 |

### 不发布 invariant 伴随包

本包不发布运行时 invariant 伴随包，因为循环不持有可检查的状态：它报告的每个值都在下一次读取时从会话日志、内核视图、引擎与学习者记录重新推导，而一次步骤所写内容的拥有方是引擎与学习者记录。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [`dsh-misconception`](../misconception/README.zh.md)——目录、流水线阶段，以及本循环所注入的指令。
- [`dsh-learner-model`](../learner-model/README.zh.md)——其案例历史决定下一个案例，并接收解决结果、复发与复发错误的学习者记录。
- [DeepSeek Harness 2.0 evolution spec](../../../specs/deepseek-harness-2.0-evolution-spec.md) §20——本循环所实现的 observe、evaluate、devil advocate、detection、teach、exercise、reassess、learner-model update 顺序。
- [Agent kernel 子系统](../../../docs/subsystems/agent-kernel.zh.md)——devil-advocate 阶段所等待的断言与证据。
- [Session 子系统](../../../docs/subsystems/session.zh.md)——位置所读取的派生消息，以及注入指令所记入的日志。

-----

<a id="model-experience"></a>
## 模型体验

### 注入的阶段指令

#### What the model sees

在每一次被接纳的 `agent/pre-step` 上，只要位置要求投递，循环就向该步的消息追加一条合成的用户消息，因此导师 agent 会在学习者自己的消息旁边读到它。文本以 `Mentor loop — ` 开头，后接该阶段的要求，即本包拥有的五句话之一：explain 阶段的 `correct this misconception in your next reply, in the learner's own terms`，counterexample 阶段的 `show the counterexample below and ask what it does to the learner's thesis`，exercise 阶段的 `assign the exercise below, then wait for the learner`，new-case 阶段的 `set the case below as the learner's next reading`，以及 reassess 阶段的 `read the learner's new work and reassess it against the objective below`。某阶段分配了练习时，随后是一行 `Exercise <exerciseId> targets: <objective>.`，然后是引擎为该阶段渲染的指令本身。消息来源带有 `kind: 'mentor-loop'` 与该阶段的摘要，因此日志能指出文本来自哪个阶段。

#### Token effect

有条件，且会保留。只有在位置的动作为 `deliver` 时才追加一条消息，每个阶段最多一条，因为摘要已在日志中的阶段不再要求投递。整段文本受 `maxDirectiveChars` 个 UTF-16 字符上限约束，且追加的消息留在会话日志中，因此会进入该会话后续的每一次请求。

#### KV Cache effect

仅追加。一次投递追加一条消息，不改写更早的任何消息，因此 provider 的缓存前缀在追加点之前仍然可用。回放与恢复不会重复注入日志里已有的内容：循环从会话的派生消息中读回已投递的摘要，因此已经带有某阶段指令的会话永远不会第二次投递它。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

这些限制说明循环无法为部署方观察或决定的内容。它们是本包当前的约束。

- **位置从不携带本次出现** —— `MentorLoopPosition` 声明了 `misconceptionId`，`mentor/loop-position` 也会报告它，但没有任何推导路径设置它，因此监听者只能从注入消息的来源或从引擎得知正在进行的是哪次出现。
- **完成事实随阶段而定，不随消息而定** —— `explain` 或 `counterexample` 阶段以 `delivered` 完成，`exercise` 阶段把学习者发送的任何文本记作作答，因此指令之后的任何学习者消息都会推进循环。
- **一个上下文一个学习者** —— `Config.learnerId` 就是该上下文上每次会话的学习者，因此要辅导多个学习者的上下文需要为每个学习者挂载一个实例。
- **每个会话一次只处理一次出现** —— 循环处理最新投递指令所指的那次出现，否则处理模式命中最新论点的那次出现，因此该学习者持有的其他流水线要排队。
- **推导只为案例历史读取学习者记录** —— 它从不读取误解的状态，因此由其他任何东西写入的解决结果或状态变化都不会移动位置。
- **没有内核就没有检出** —— 未挂载 `agentKernel` 时会话没有任何断言与观察，因此循环停在 devil-advocate。
- **失败的步骤只被记录，不会被上报** —— 经由 pre-step 路径，失败以警告形式进入 `ctx.logger`，该轮次在没有该指令的情况下继续。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

pre-step 监听器先运行 `next()`，当该步骤拒绝或信号已中止时原样返回决定，因此循环绝不会短路其他监听器的直接答复。结束循环的那一步报告它刚刚造成的学习者记录更新，而不是重新推导，因为已结束的流水线只会重新推导出一次新的检出或一个 evaluate 等待，而不是这一步实际执行的那次更新。通告记忆以会话 id 为键，在释放时与插件自身的 effect 中都会清除，因此丢弃会话的上下文不会保留其签名。

</details>
