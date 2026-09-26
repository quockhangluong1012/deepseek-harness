---
description: "以证据为准的误解引擎：把学习者陈述的论点与部署方的模式目录比对，把发现写入学习者记录、流水线表与内核断言台账，并驱动每次出现走完 explain、counterexample、exercise、new-case、reassess（ctx.misconception）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-misconception

[English](README.md) | 中文

## 概述

`dsh-misconception` 判断一个陈述的论点是否命中部署方声明的某个误解，并返回该误解、其背后的设计错误，以及用于纠正它的学习目标，而这些都以调用方引用的观察证据为据。发现会落到三处：学习者记录、该学习者与该模式的持久流水线，以及内核断言台账中一条 `contradicted` 断言。随后每个阶段渲染一条供导师投递的指令。匹配是字面匹配，所有纠正文本都来自部署方自己的模式，因此这里不调用模型。

## 目录

- [使用本包](#use-this-package)
- [循环及其事实](#the-cycle-and-its-facts)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把引擎与存储域、学习者记录一起挂载，声明该部署能够检出的每一个模式，然后把学习者的论点连同与之矛盾的观察交给它。

```yaml
- name: '@deepseek-ai/dsh-misconception'
  config:
    patterns:
      - id: mss-standalone-entry
        misconception: MSS treated as a standalone entry criterion
        designError: MSS confirms structure; it is not an entry trigger until a PD-array test follows it
        objective: Place MSS inside a full entry model before taking an entry
        triggers:
          - MSS happened
          - therefore the entry is valid
        explanation: An MSS marks a shift in delivery, not permission to enter.
        counterexample: EURUSD H1 printed an MSS into a supply zone and reversed from it.
        exercise: Mark the last three MSS on EURUSD H1 and name the PD-array test that followed each.
```

`ctx.misconception.detect({ agent, learnerId, thesis, evidence, caseId? })` 返回已记录的发现，`advance({ misconceptionId, fact })` 完成当前阶段并进入下一个阶段，`directive(learnerId, misconceptionId, caseId?)` 为本次出现所停留的阶段渲染指令。读取是同步的：`match(thesis)` 指出论点命中的模式，`pipeline` 与 `pipelines` 读取该学习者的一次出现或全部出现，最近写入的在前。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `patterns` | 必填 | 该部署能够检出的误解模式，按首个命中者决定匹配的顺序排列；目录缺失或为空会在加载时失败 |
| `maxTextChars` | `2000` | 对引擎存储或发出的每一段学习者原话或引擎渲染文本的 UTF-16 字符数上限 |

### 可观察行为与失败

域打开之前，读取与写入都会抛错；已存流水线所引用的模式若已不在目录中，会明确失败，而不是按照没人声明过的模式去教学。`detect` 拒绝目录中没有任何模式命中的论点，也拒绝没有矛盾观察的检出，因为一个无人能反驳的发现算不上发现。`advance` 拒绝当前阶段不接受的事实，并在错误中指明该阶段需要的事实；循环结束后则拒绝任何事实。`directive` 在学习者不持有该次出现时抛错，对已完成的循环返回空，并且拒绝在没有学习者必须处理的案例时渲染 new-case 阶段。

-----

<a id="the-cycle-and-its-facts"></a>
## 循环及其事实

每个阶段渲染一条指令，并且恰好由一个观察到的事实完成：

| 阶段 | 该阶段渲染的内容 | 完成它的事实 |
|---|---|---|
| `explain` | 针对学习者本人论点的设计错误，随后是模式的解释 | `delivered` |
| `counterexample` | 针对该论点指出的模式反例 | `delivered` |
| `exercise` | 模式的练习，带上派生的练习身份与学习目标 | `attempted`，携带学习者的作答文本 |
| `new-case` | 在一个指定案例上重做解读的指令 | `case-selected`，携带案例引用 |
| `reassess` | 依据学习目标解读学习者新论点的指令 | `reassessed`，携带 `repeated` 或 `resolved` |
| `complete` | 无；循环已经结束 | 无——任何事实都会被拒绝 |

`repeated` 的重评会回到 `explain`，并像第二次检出那样在学习者记录上计入复发。`resolved` 的重评结束循环：学习者记录中该误解变为 `resolved`，本次出现提出的目标被撤销。流水线离开的每个阶段都以 `mentor/misconception-stage` 通告，每条已记录的发现都以 `mentor/misconception-detected` 通告；两者都是宿主侧通知，本身不被任何模型读取。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计要点

- **目录就是部署配置。** 模式以经过校验的 `Config` 传入；空目录、重复或空白的 id、没有任何触发词的模式，以及空白触发词（它会命中每一个论点）都在加载时失败，因为处于这种状态的目录要么什么都检不出，要么检出错误的东西。
- **身份是派生的，不是生成的。** 一次出现是 `<learnerId>/<patternId>`，其练习是 `<misconceptionId>:exercise`，其目标是 `<misconceptionId>:objective`，因此同一模式的再次出现会更新同一条流水线，学习者记录计入的是复发而不是第二个误解。
- **一次检出写三处。** 学习者记录计入复发并获得该目标，`mentor_misconception` 域的 `pipelines` 表保存持久阶段，挂载了内核时内核记录一条状态为 `contradicted`、置信度为 `0` 的断言。断言是可选的；另外两处不是。
- **按学习者与模式持久保存。** 域以 `layout: 'per-record'` 打开，每条已存行都在打开时解析，因此不再匹配 schema 的行会让打开明确失败，而不是左右下一课的内容。
- **文本两端都有上限。** 论点、作答以及每一条渲染出的指令都经过配置的上限，因此再长的学习者陈述也无法无限制地撑大已存行或指令。
- **每个阶段一条指令。** 摘要由本次出现、阶段与案例哈希得到，因此调用方可以只投递一次某个阶段的指令，而不是每步投递一次。

### 源码导览

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`MisconceptionEngine`、检出、流水线读取与阶段推进 |
| [`src/patterns.ts`](src/patterns.ts) | 目录 schema、其加载期校验、论点匹配与文本上限 |
| [`src/pipeline.ts`](src/pipeline.ts) | 阶段清单、派生身份、阶段状态机，以及每个阶段命名的等待 |
| [`src/directive.ts`](src/directive.ts) | 指令渲染与阶段摘要 |
| [`src/spec.ts`](src/spec.ts) | `mentor_misconception` 域、其 `pipelines` 表与持久行 schema |
| [`src/types.ts`](src/types.ts) | 模式、阶段、事实、流水线、指令与检出类型 |
| [`src/events.ts`](src/events.ts) | 两条宿主侧通知 |

### 不发布 invariant 伴随包

本包不发布运行时 invariant 伴随包，因为流水线行与学习者记录就是这份状态的两份副本，而引擎在写入它们的操作内部就由一份推导出另一份：断言二者一致只会复述刚刚执行的那次写入。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [DeepSeek Harness 2.0 evolution spec](../../../specs/deepseek-harness-2.0-evolution-spec.md) §20 与 §21——导师质量控制循环，以及为误解检出提供输入的案例产物。
- [`dsh-learner-model`](../learner-model/README.zh.md)——写入发现复发次数与目标的学习者记录。
- [`dsh-mentor-loop`](../mentor-loop/README.zh.md)——决定何时检出、并投递本引擎所渲染指令的插件。
- [存储子系统](../../../docs/subsystems/storage.zh.md)——每个学习者的流水线所经由的域形式。
- [`dsh-storage-domain`](../../storage/storage-domain/README.zh.md)——这里每次写入都依赖的表、写链与 schema 校验语义。
- [Agent kernel 子系统](../../../docs/subsystems/agent-kernel.zh.md)——检出所引用的断言与证据记录，以及它所主张的矛盾。
- [`dsh-case-store`](../../research/case-store/README.zh.md)——其自身的检出读取路径为论点提供观察证据的已评审案例产物。

-----

<a id="model-experience"></a>
## 模型体验

间接进入，经由导师循环投递本引擎在每个阶段渲染的指令。

#### KV Cache effect

这里没有任何内容自行进入模型请求，因此在导师循环把渲染出的指令追加到后续请求之前，provider 的缓存复用不受影响。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

这些限制说明引擎在什么情况下会判断失当，或持有一份部署方必须接受的持久状态。它们是本包当前的约束。

- **匹配是字面的** —— 触发词按不区分大小写的子串匹配，因此一个引用触发词恰恰为了否定它的论点仍会命中，且只报告目录顺序中的首个模式，不给备选。
- **每个学习者与每个模式只有一条流水线** —— 第二次出现被计为同一次出现的复发，因此一个学习者永远无法同时持有同一模式的两个循环。
- **目录 id 是持久键** —— 重命名或删除某个模式 id 会让已存行引用一个没人声明的模式，在目录再次声明该 id 之前，对这些行的每次读取都会抛错；这里没有迁移。
- **只保留最新的作答** —— `attempt` 会被下一个 `attempted` 事实替换，因此同一个练习此前的作答无法从引擎中还原。
- **截断是静默的** —— 超过 `maxTextChars` 的论点、作答或渲染指令会被直接截断，无论已存行还是指令里都没有标记。
- **证据由调用方负责** —— 引擎引用交给它的任何证据身份，从不检查该会话是否记录过它们。
- **已结束的循环会丢弃其目标** —— 该目标会从学习者记录中移除，不留曾被提出的痕迹，因此学习者被教过什么的历史保存在流水线行里，而不是目标列表里。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

一次检出先写学习者记录，再写流水线行，然后写内核断言，最后才通告，因此监听者观察到的发现一定已经在每一个拥有它的地方持久化。一次推进在触碰学习者记录之前先写行：行是阶段的真源，学习者记录是复发次数的真源，二者互不推导。`view()` 在读取时解析模式自身的文本，因此已存行保存的是调用方的论点与各种身份，而不是目录散文的副本。

</details>
