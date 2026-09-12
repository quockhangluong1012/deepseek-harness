# Agent Note：演进评分器 —— 录制场景上的度量三元组

Status: implemented

[English](2026-09-12-evolution-scorer.md) | 中文

## 问题

外层循环需要一种说法来判断某项改动是否让 harness 变得更好，而仓库里没有可比较的度量归属者。快照套件逐字节比较转录——这对"输出是否变了？"是正确的问题，对"agent 现在是不是更好了？"则是错误的问题：它们断言，然后停止；而每个必须被评分的场景也都必须带着 API key 重新录制。与此同时，规范点名的三个数字（通过、计费 token、挂钟时间）各自都已另有归属：工作区捕获、`ctx.tokenMeter`、以及尝试自身的时钟。缺的是一个把这些组合到既有语料之上的包。

## 决策

在 `evolution/` 分组中交付 `@deepseek-ai/dsh-evolution-scorer`，包含一个服务与一个纯函数。

`EvolutionScorer`（`ctx.evolutionScorer`，`inject = ['tokenMeter']`）接受 `corpusDir` 与尝试次数；`score({ scenario, agent, run })` 从磁盘规划场景，以快照 harness 的 `replay` 模式经调用方的运行器运行 `attempts` 次，并返回 `{ status: 'scored', score }`，其中是度量三元组：`pass` 及改动路径、`tokens`、`wallTimeMs`，以及每条挂钟样本。`loadScenarioPlan` 通过 harness 自带的夹具读取器解析 ACP 输入脚本、最高代的录制会话夹具（及其子夹具），以及可选的 `replay.override.json`、`workspace/` 与 `workspace.expected/` 伴随文件。

归约是纯函数并单独导出：`scoreRun` 把每次尝试的最终工作区与期望捕获比较——场景不提供期望时则与该次尝试自身的起始状态比较——只有全部尝试一致时才算通过，并报告首个发生分歧的尝试所改动的路径，因此失败给出的是文件名而不是一句裁决。`diffWorkspace`、`medianOf`、`measureRunTokens` 与 `loadScenarioPlan` 一并导出，使 spec 无需派生进程即可驱动这套算术。

计费 token 只来自 `ctx.tokenMeter.measure`：每条采集到的会话日志由 `llm-replay` 的夹具读取器读取、重建为 `Session` 并度量，一次运行的数值累加每条采集到的会话。进程运行器就是 harness 自己的 `runScenario`，以 `processScenarioRunner` 重新导出；评分器不自行添加任何子进程机制。

回放本身也仍归 harness：计划经由 harness 自己的环境接线转发 `replay.override.json` 与录制的子夹具，因此首调用顺序的脚本绑定、覆盖伴随文件与运行结束时的 `assertConsumed` 检查都在被启动的子进程内运行，与快照套件完全一致——评分器既不重新实现也不复制它们。

跳过语义是豁免中诚实的那一半：语料中不存在的场景目录、缺少录制会话夹具的场景、缺少 `input.json` 的场景，各自在不运行任何东西的情况下返回 `{ status: 'skipped', reason }`。只有不存在的 `corpusDir` 才抛错，因为那是配置错误，而不是录制阶段从未产出的场景。本包不写入任何东西：运行器只会以 `mode: 'replay'` 被调用，因此没有任何代码路径会录制夹具，也没有任何地方查询 API key。

语料计划通过 `workspace.expected/` 目录是否存在来推断工作区期望，而不读取 `snapshot.yml`，因为快照夹具守卫已经强制该目录恰好只在清单声明最终工作区时存在，两个判断不可能不一致。

## 考虑过的替代方案

- **改在快照套件里断言，而不是新建包。** 已否决：套件的 `expect(...).toEqual(...)` 比较会丢掉被测的数字。评分必须是调用方可以跨运行比较的值，而不是一个中止执行的断言。
- **从 `snapshot.yml` 的 `workspace.final` 标志打分。** 已否决：套件的夹具守卫把该标志与 `workspace.expected/` 目录绑定，因此读取该目录是同一个判断，却少一个解析器和一种失败模式。
- **重新数文本得到 token。** 直接否决：规范点名 `tokenMeter.measure`，而计量器已经持有路由定价、provider 用量锚点与图像定价。把每条采集到的日志重建为 `Session` 让那套折叠保持权威；覆盖 `text-turn` 夹具的 spec 断言的是录制到的 provider 用量（3091 输入 + 23 输出），而非文本长度的代理值。
- **在本包自己的 spec 里启动 ACP 子进程。** 已否决：那是快照套件的层级，在覆盖率门禁下运行它只会用数分钟的 Windows 启动时间换不到额外信号。服务 spec 提供录制的运行器，仍然走真实的计划、真实的工作区捕获与真实的计量器；`processScenarioRunner` 保持为对 harness 的一行绑定。
- **让 `ctx.evolutionScorer` 只持有语料配置。** 已否决：agent 组合无法用 `cordis.yml` 表达（它点名脚本路径与 tsconfig），因此运行器与组合按请求到达，这也让 headless 语料无需第二个评分器即可提供自己的运行器。
- **复用 harness 的规范日志归一化与脱敏来打分。** 已否决：度量三元组不含转录成分。归一化 stdout、重新脱敏标识并比较规范日志回答的是"转录是否变了？"，那是快照套件已经负责的问题；工作区差异是本包的全部通过判据，因此它只捕获夹具清单、捕获结果与计量器。
- **在此处提供 Pareto 或 GEPA 表面。** 规范已延期；三元组是那些层次将要消费的单元。

## 后果

改进主张现在是一个数字：同一场景的两次运行给出可比较的 `pass`、`tokens` 与 `wallTimeMs`，样本留在记录上，读者能看到中位数背后的离散程度。语料未覆盖的场景不产生成本——它们带原因跳过，而不是让运行失败或索要密钥。代价是耦合：这是第一个依赖 `@deepseek-ai/dsh-session-snapshot` 与 `@deepseek-ai/dsh-llm-replay` 的产品包，这是有意为之（语料、夹具读取器与 ACP 运行器正是被评分的表面），但也确实意味着评分器的运行时依赖图包含快照 harness。挂钟时间是单机挂钟，因此它是比较信号而非性能门禁；那个角色由 `benchmarks/` 保留。

## 测试

`tests/workspace.spec.ts` 覆盖每种捕获条目的差异、路径排序，以及同一路径上的种类变化。`tests/score.spec.ts` 覆盖相对期望捕获的通过与失败、按次尝试起始状态的回退、首个分歧的报告，以及注入时序与 token 样本的中位数。`tests/statistics.spec.ts` 覆盖奇数、偶数、单个与空样本。`tests/scenario.spec.ts` 覆盖缺失的语料、未知场景、无夹具场景、无脚本场景，以及带最高夹具代与子夹具的完整计划解析。`tests/scorer.spec.ts` 在写入磁盘的语料上驱动服务，每次尝试都在 `replay` 模式，并断言录制夹具的 provider 用量（3114 token）即该运行的计费数字。逐文件 100% 覆盖在语句、分支、函数与行上成立。
