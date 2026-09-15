# Agent Note: 被取代的快照简报离开表层

Status: implemented

[English](2026-09-16-superseded-snapshot-briefs.md) | 中文

## Problem

v6 评审（`docs/superpowers/specs/2026-09-13-evolutionary-harness-review-v6.md`）的批次 2 要求演进记忆简报停止累积，而它自己的组合测试就把缺陷写在注释里：「变化会追加一份完整替换；被取代的简报留在表层，因此请求同时携带两帧。」每一次改变作用域摘要的记忆写入都会再注入一份简报，模型便一直把旧指令与新指令并排读——过期的 `# Workspace memory` 规则、过时的画像、被取代的用量数字——因为循环把每条前置步骤消息都以 `surfaceOp: 'append'` 提交，而没有任何机制撤回更早的那一条。

## Decision

来源声明了 `form: 'snapshot'` **且**声明了 `supersedes` 的前置步骤消息，会在表层取代其生产者此前的快照。

- **槽位是生产者**（`src/snapshot-injections.ts`）：plugin 来源按 `plugin` 取键，其他来源按 `kind` 取键，因此即便 sections、digest 或作用域变了，新简报仍会取代旧简报——会话迁移后残留的旧简报恰恰就是过期的那一份。
- **循环追加的是替换，而非改写**：`SnapshotInjectionProjection` 对恢复出的槽位向 `agent.ts` 交出 `{ surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: [previous] }` 意图，其余消息仍是追加。日志保留每一次注入，因此 transcript、重放与持久记录都不变；只有 `deriveMessages()` 与其构建的请求按这种方式折叠。
- **投影从日志恢复**（`restoreSnapshotSlots`）：每个槽位取最新且仍存活的快照，跳过已被后续替换遮蔽的那一条，因此恢复的会话会取代上一个进程注入的简报。落地的替换遮蔽了已保留节点时，该槽位被清空，生产者的下一次快照就以空槽位追加。
- **这是可选声明。** 未声明 `supersedes` 的来源照旧追加。`time-context` 与 `tmux-context` 正依赖这一点：后一条读数会相对前一条度量耗时，因此两条都必须留在模型历史中。循环自有的 runtime-context 快照同样继续追加——`RuntimeContextProjection` 已经拥有它的替换，而再次取代它会让循环开启一个并非它请求的请求系列（这是构建本改动时实测到的，也是该规则最终成为「生产者声明」而非「形式属性」的原因）。
- `ContextFormed` 的 snapshot 变体新增可选成员 `supersedes?: true`（`packages/llm/llm/src/message.ts`），契约就写在声明该形式的地方：陈述状态的快照会取代，时间线中的条目会累积。

## Alternatives considered

- **把每条 `form: 'snapshot'` 消息都当作取代。** 在它破坏 time-context 时间线后否决：后一条读数的「相对前一条步骤上下文的耗时」一行指向前一条读数，钉住累积行为的那个测试因真实原因失败，而不是因为过期预期。该形式命名的是消息如何呈现自己，而不是其生产者是否在陈述状态。
- **把规则放进 `packages/core/session` 的表层折叠而非循环。** 有吸引力——折叠规则不会递增 `replaceGeneration`，因此取代不会开启请求系列——但折叠也会取代循环自有的 runtime-context 快照，而它的投影会显式替换它；两者叠加会抛出 `surface replace: start seq not found in surface`。让循环做拥有者，才能保证每个快照只有一条替换路径。
- **让记忆插件改写先前的事件。** 否决：日志是只追加的，且模型可见内容必须能从日志重建。在表层替换节点同时保住这两个性质。
- **在循环里按插件名添加 `supersedes` 式的开关。** 以耦合为由否决：声明属于生产者自己的来源形态，插件已在那里说明它的消息是什么。

## Consequences

一个作用域的记忆简报现在无论携带哪个摘要都只到达模型一次；模型不再把被取代的指令与当前指令并排读。时间与 tmux 读数照旧累积。代价写在包 README 中：被取代的简报仍是一条可持久日志记录（transcript 仍会显示），在简报声明 `supersedes` 之前已累积重复简报的会话会一直保留到压缩遮蔽它们，以及替换会移动表层代次，因此携带它的那次尝试会记录一条全新的 `request/header`（原因 `series`）——提示文本本身未变，所以不会额外提交系统消息。

验证：8 个循环测试（取代后日志完整且表层只携带一帧、跨 attach 的恢复、落地替换清空槽位、第二个生产者不受影响、未声明任何东西的累积快照，以及槽位/恢复的单元用例）与更新后的 `evolution-memory-context` 组合测试（断言请求只携带一份简报——被取代的一帧留在日志中，永不抵达模型）。`packages/core/agent-loop/src/snapshot-injections.ts` 的语句、分支、函数与行覆盖率均为 100%；`time-context`、`tmux-context` 与 `agent-loop` 套件通过，且因为没有已录制夹具注入会取代的简报，没有任何快照夹具或 SDK 期望输出发生变化。
