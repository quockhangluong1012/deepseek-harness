# Agent Note: 在演化评审器中接入 `skillCreationEvidence`

Status: implemented

[English](2026-09-12-skill-creation-evidence-in-reviewer.md) | 中文

## 问题

评审器会索引某个作用域的产出，却从不追问这些产出是否构成创建技能的证据。技能遥测包中的重复路径探测器 `skillCreationEvidence` 从未被 `indexOutputs` 调用，因此重复的产出路径不会在记忆库中暂存任何技能提案。

## 决策

在 `indexOutputs` 中 `recordOutputs` 成功之后，评审器回读该作用域记录，并对产出路径调用 `skillCreationEvidence`。当 ≥3 条路径归一到同一个键（大小写折叠、斜杠归一）时，经 `evolutionMemory.stageWrite(kind: 'skill')` 暂存一条技能提案。

接线只有一处导入、一处调用点，以及承载它们的依赖：

- `packages/evolution/evolution-reviewer/src/index.ts` —— 在 `indexOutputs` 中的导入与接线
- `packages/evolution/evolution-reviewer/package.json` —— 新增 `@deepseek-ai/dsh-evolution-skill-telemetry` 依赖
- `packages/evolution/evolution-reviewer/tsconfig.json` —— 指向 `../../skill/evolution-skill-telemetry` 的项目引用
- `packages/evolution/evolution-reviewer/tests/reviewer.spec.ts` —— 用 read spy 播种 3 条相同输出路径的测试

`mergeOutputs` 会对完全相同的路径去重，因此真实触发需要精确路径不同、却归一到同一个键的路径（例如大小写敏感文件系统上的大小写差异）。`stageWrite` 期间的错误会被捕获并以告警记录；它们绝不会从 `indexOutputs` 传播出去。

## 考虑过的替代方案

**以完全相同的产出路径作为触发。** 不可行：`mergeOutputs` 在回读之前就已经对完全相同的路径去重，因此触发只能是精确路径不同、却归一到同一个键的路径——大小写敏感文件系统上的大小写差异——而不是同一条路径的简单重复。

**在评审器本地另写一套归一规则。** 未采用：该检查所需的键归一（大小写折叠、斜杠归一）已经作为 `@deepseek-ai/dsh-evolution-skill-telemetry` 的 `skillCreationEvidence` 发布，因此评审器改为引入该依赖与项目引用，而不是复制第二份规则。

**让 `stageWrite` 失败从 `indexOutputs` 传播出去。** 拒绝：失败的提案会被捕获并记录为告警，索引通过因此仍能完成。

## 后果

重复产出这一证据现在会作为暂存的技能提案抵达记忆库，而索引通过并未新增失败模式：`stageWrite` 的错误会被捕获并记录为告警，绝不会从 `indexOutputs` 传播出去。代价是新增的依赖与项目引用，以及一个很窄的触发条件——需要精确路径不同却能归一到同一个键的路径；完全相同的重复路径会被 `mergeOutputs` 去重，永不触发。

## 测试

`reviewer.spec.ts` 中的 `'stages a skill proposal when skillCreationEvidence fires on output paths'` 用 `read` spy 播种三条相同的产出路径，并断言暂存的技能提案。
