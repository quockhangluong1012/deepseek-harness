# Agent Note: P2-P4 收尾批次 8

Status: implemented

[English](2026-09-13-p2p4-remainder-batch-8.md) | 中文

## Problem

全量清扫修复的第 8 批（`docs/superpowers/specs/2026-09-13-full-sweep-fixes-design.md`）覆盖剩余的 P2–P4 发现项。审查把它们拆成两类：可在 TDD 下立即落地的小型行为保持不变修复，以及本轮不去尝试、只量化其规模的工程级工作。

## Decision

五项修复已落地，凡涉及行为变更处均采用 TDD：

1. `llm-fallback/README.md`：删除了破坏 `verify-package-invariants` 原因句正则的多余 "yet"（`published` 必须紧随 `[.:;—]`）。门禁通过（39 项合规）。
2. `schedule/runtime.ts`：本地 `MAX_TIMER_DELAY_MS` 改为从 `@deepseek-ai/dsh-timeout` 重新导出（含依赖/tsconfig）；26/26 测试通过。
3. `skill/tool-skill`：`shell.timeoutMs`/`shell.outputMaxChars` 现在是经过校验的 `Config` 字段（schema 默认值即原常量）；`resolveShell`/`capShellOutput` 接收已解析的值，技能元数据优先。新增 4 项测试（2 项 shape 更新）；技能测试 71/71 通过；`verify-no-hardcoded-tunables` 门禁为绿。
4. `workspace`：按其 TODO 删除了无用的 `create(path, title?)` 参数（该能力通过 `entity.setTitle` 保留）；3 项测试改写为新契约；README 配对已更新，包括移除 Dev-Note/ToC。（`tsc` 证明没有其它调用方；套件仅因夹具初始化时的 Windows 符号链接 EPERM 而受阻——环境问题。）
5. `usage-ledger/aggregate.ts`：`addSample` 复用 `addModelOnly`（消除 22 行的自我克隆）；52/52 测试通过。

## Alternatives considered

- **直接删除约 197 个 `.d.ts` 孪生文件：** 已否决，改为后续工程。孪生文件（例如 `llm/types.d.ts` 与 `types.ts`，分号位置偏移的副本）没有任何 `src` 导入方，但程序归属（tsconfig `include: src`、Typert 分析）与逐文件语义同一性都需要逐个机械证明；安全做法是带孪生校验与允许清单门禁的删除脚本（存在 `css-modules.d.ts` 这类合法文件），而非盲目批量删除。
- **抽取 22 处 jscpd 克隆的共享契约：** 本批次已否决。其余各项需要跨包契约抽取并承担快照风险（ui-evolution/evolution 类型、api feed ↔ ui-workspace-memory、context renders、edit/write + token-meter/usage-ledger 的 tool-schema/累加器结构形态），抽取的成本高于收益；只修了唯一安全的同文件案例（usage-ledger）。
- **把 fs-text/sqlite-open/invariant-trace/agent-option 的抽取提升为共享包：** 已否决，列为延后。每一项都需要为 5–15 行代码新建共享归属包或依赖边，而工作流的 `DEFERRED_*` 文档字符串必须逐字保留（模型可见的固定契约）。
- **在 ui-evolution 单个包内修复 publint CSS 失败：** 已否决。`clientBundle` 内联 CSS（没有独立文件），而 `./types` 产物树导出会交付带悬空 css 导入的 `lib/types/client/Page.js`，因此修复应落在客户端构建预设策略中，而不是单包内的权宜之计。

## Consequences

五项聚焦的简化已落地，其测试与门禁均为绿；其余发现项现在带有实测规模而非开放式范围：约 197 个 `.d.ts` 孪生文件，以及在一棵干净 main 工作树上测得的 22/820 处 jscpd 克隆（先已存在，并非本工作树的脏状态所致）。这里没有任何变更触及模型可见契约；两项仍被外部状态阻塞，一处门禁抖动等待门禁运行器的所有者处理。

## Deferred

- **约 197 个 `.d.ts` 孪生文件：后续工程。** 孪生文件（例如 `llm/types.d.ts` 与 `types.ts`，分号位置偏移的副本）没有任何 `src` 导入方，但程序归属（tsconfig `include: src`、Typert 分析）与逐文件语义同一性都需要逐个机械证明——应是带孪生校验与允许清单门禁的删除脚本（存在 `css-modules.d.ts` 这类合法文件），而非盲目批量删除。证据已收集在审查报告中。
- **22 处 jscpd 克隆：基线为红，工程级规模。** 在一棵干净 main 工作树上测得 22/820——先已存在，并非本工作树的脏状态所致。只修了唯一安全的同文件案例（usage-ledger）。其余需要跨包契约抽取并承担快照风险：ui-evolution/evolution 类型（49）、api feed ↔ ui-workspace-memory（26）、context renders、edit/write + token-meter/usage-ledger（tool-schema/累加器结构形态——抽取的成本高于收益）、workspace-memory 的不对称（需要归属分析：存储路径会校验 source-kind，实时路径不会）。
- **fs-text/sqlite-open/invariant-trace/agent-option 抽取：延后。** 每一项都需要为 5–15 行代码新建共享归属包或依赖边；工作流的 `DEFERRED_*` 文档字符串必须逐字保留（模型可见的固定契约）。
- **locale 文案、客户端拖拽/计时器 hook：后续工程**（按包划分的字典；ui-primitives 的 hook 放置规则）。
- **rescope-vendor：被并发脏工作树阻塞**（其它 agent 对 vendor/README 与 AGENTS.md 的编辑破坏了它的精确编辑匹配；需在干净工作树/CI 上验证）。
- **Windows 上 run-gates 下的 FIXME 门禁：运行器级抖动。** 脚本单独运行通过（`EXIT:0`）；并行启动门禁时报 "system cannot find the path specified"。需要门禁运行器的所有者排查。
- **publint ui-evolution CSS：客户端构建的设计问题。** `clientBundle` 内联 CSS（没有独立文件），而 `./types` 产物树导出会交付带悬空 css 导入的 `lib/types/client/Page.js`。修复属于客户端构建预设策略，而非单包权宜之计。
- **node-next-types：被完整构建产物阻塞**（`pnpm run build` 正以作业 pwsh-26 运行；门禁稍后重跑）。

## Triaged without code change

- **可调项门禁范围（仅 `tool-*`）：已记录的意图**（模块文档中的 "model-facing tool packages"；util 零依赖包本来就无法持有 Config）。范围内的违规已修复（见 Decision 第 3 项）。
- **goal/change `@mode`、tool register 效果、identity memo：与先例一致。** 持久 map 成员在任何地方都不带 `@mode`（`llm/retry` 先例）；工具插件在全仓库范围内直接在 `apply` 中注册；identity 捕获处有注释，memo 有文档。
- **attachment/settings 双重默认值：被接受的惯用法**（loader 路径用 schema 默认值 + 直接构造用 `??`，与 catalogDescription 一致）。
- **budgets 说明文案、归档笔记：未改动**（属于决策历史，而非现行契约）。
