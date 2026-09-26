# Agent Note: Auto 模式在 workspace 沙箱内由更便宜的审查模型裁决

Status: implemented

[English](2026-09-26-auto-mode-reviewer-scope.md) | 中文

取代[最初的 Auto review 决策](2026-08-28-auto-review.zh.md)中关于执行范围、路由与决策词汇的部分；该笔记定义的权威模型、来源角色与生命周期继续有效。

## Problem

最初的 Auto review 作为当前会话 preset 发布，沿用 Full access 的 `danger-full-access + never` 组合，并使用被审查会话自身的 provider 与模型进行分类。这使得 reviewer 的 full-access 授权成为会话与未审查破坏性操作之间唯一的屏障；把会话最昂贵的路由花在单对象判断上；并让有风险的动作只有两种结局：放行（当此前的指令看起来像授权时）或直接拒绝。用户即使想批准某个不可逆动作，也无从对 reviewer 的分类说“是”。

## Decision

[`dsh-experimental-auto-review`](../../../../packages/experimental/auto-review/README.zh.md) 保留其身份（`permission/preset:auto`）、固定 `REVIEW_POLICY`，以及对每次原生调用与已启动 PTC inner 调用审查一次的保证，并改变三件事。

### Auto 的组合会约束该会话

在 [`dsh-permission-presets`](../../../../packages/interaction/permission-presets/README.zh.md) 内部，`auto` 解析为 `sandbox: workspace-write`、`approval: ask`。常规操作是在该范围**之内**被 reviewer 放行，而不是在没有范围约束的情况下被放行；审批策略保持可询问，让中风险动作有去处。该组合固定在权限服务内部；reviewer 读取它来生成请求的沙箱范围分区，而不再自行声明一份副本。

记录于更早组合的 Session 会在发布时采用当前组合：若存储的 `auto` 身份的沙箱或审批旋钮与 Auto 组合不同，权限服务会将其对齐，使恢复的 Session 不会在含义已改变的身份下保留过时的更宽范围。卸载时会把每个存活的 Auto 会话迁移到与 Auto 组合匹配的已配置 preset，否则回退到部署中可询问的默认 preset。旧的固定迁移目标（`danger-full-access`、审批 `never`）在 Auto 不再等同于 full access 之后，会变成静默放宽。

### 分类使用更便宜的路由

reviewer 通过本插件经过校验的 `Config` 字段 `classifierProvider` 与 `classifierModel` 进行分类；未设置时使用部署默认模型——便宜档，而非被审查会话自身运行的模型；组合中没有该服务时回退到被审查会话自身的路由。该服务以可选方式读取（`ctx.get`）而非注入，因此即使组合未提供它，Auto 仍能加载。

### 有风险的操作转交用户

决策词汇与管线的三种结果一一对应：`low + allow`、`medium + ask`（或 `deny`）、`high + deny`；ask 与 deny 可带字符串 `reason`，allow 绝不允许。`ask` 会通过 `ctx.approval` 变成常规审批提示，并携带 `Auto review asked you to approve tool "<name>"` 与 reviewer 给出的理由。已废弃的 `medium + allow` 形态——把此前的人类指令当作中风险工作的长期授权——不再存在：由用户在看到 reviewer 说明后逐动作决定。

当 integration 存活且某 Session 解析为 `auto` 时，随附的权限门不再为其受门控工具（`bash`、`write`、`edit`、终端、subagent）发起询问。reviewer 已经裁决了同一次调用，再次询问会把同一个决定抛给用户两次；reviewer 的 ask 路径同样经由该审批服务，因此每次 Auto 批准仍会记录为一对 `approval/asked`/`approval/decided`。

## Alternatives considered

**保留 `danger-full-access + never`，只改分类路由。** 这是最小的改动，也保留随附的迁移目标。已否决：该模式的意义在于常规工作无需 full-access 授权，而[2.0 演进 spec](../../../../specs/deepseek-harness-2.0-evolution-spec.md) 中“沙箱内的常规动作”指明的正是一个必须真正生效的沙箱。

**只让 reviewer 升级到 `deny`，继续依赖既有的中风险加授权路径。** 已否决：以“此前的指令”作为授权，是 reviewer 必须从历史文本中做出的判断，而它会 fail closed 成用户针对该动作无法推翻的拒绝。

**把 allow/ask/deny 选择表达为 `PresetSpec.policy` 文档，而不是新的决策形态。** 已否决：该 policy 文档为工具管线约束能力规则，无法为单个动作询问用户。

**在 reviewer 词汇中加入 `ask`，但保留通用工具门同时询问。** 已否决：Auto 会话中每次受门控调用都会弹出两次提示，且第二次发生在 reviewer 已经裁决之后。

**把存活的 Auto 会话迁移到部署默认 preset，而不是匹配组合。** 已否决：若部署默认为 `danger-full-access + never`，卸载时会让每个 Auto 会话静默放宽。

## Consequences

Auto 现在对每次有风险的调用会用两个模型（先分类、再问用户），对常规调用用一个；分类器不再使用会话最强的模型——在细微情形上分类能力较弱，这是更便宜路由的代价，也正是 ask 路径存在的原因。Auto 会话失去完整主机访问权限：确实需要它的工作会先命中沙箱拒绝，走既有升级路径——这是 spec 所要求的取舍。

权限门的让行逻辑位于 `dsh-permission-presets`，以 integration 存活且会话解析为 `auto` 为条件，因此未挂载 Auto 或已卸载的组合仍会询问。此前固定 `medium + allow` 与 `danger-full-access` 组合的认证套件已重新对接到新词汇、新组合与 reviewer 路由，并记录每次 `ask` 产生的审批请求；其删除类用例需要与工作区共享文件系统的 POSIX shell，因此在 Windows 上跳过。
