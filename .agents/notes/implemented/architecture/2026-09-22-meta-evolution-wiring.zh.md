# Agent Note：元演化的接线

Status: implemented

[English](2026-09-22-meta-evolution-wiring.md) | 中文

## 问题

`specs/evolutionary-harness-v11-deep-research.md` §26 的第 3–5 层与 §51 第 29–33 项定义了元演化：引擎自行学习自己的变异算子、评估器、预算与路由，而不是永远运行同一套。五个软件包实现了该机制——`evolution-operators`、`evolution-evaluator-strategy`、`evolution-budget`、`evolution-router` 与 `evolution-meta`——各自都有源码、测试与 README，且每个模块文档都点名了读取它的命令动词（`/operators`、`/evaluator-strategy`、`/budget`、`/router`、`/meta`）。

这五个包都没有被挂载到任何 profile。因此 `ctx.get('evolutionMeta')` 及其四个同级读取恒为 `undefined`，优化器的五个记录接缝在记录任何东西之前就短路，该组内每一个 `recommend()` 与 `rankOperators()` 都是死代码，而这五个被承诺的动词一个都不存在。§54 的 Phase 10 一行在代码树里看起来已经实现，却在出厂产品中缺席；这五个包同时也不在软件包分组表与生成的子系统页面里。

## 决策

让这五个存储真正上线、可读，并成为组合产品的一部分：

1. **把五个存储全部挂载到产品 profile**，排在向它们记录的 `evolution-scorer`/`evolution-optimizer` 行之前，且不带 `config` 块——每个存储的默认值就是预期取值。
2. **在 `dsh-command-evolution` 注册五个读取命令**，各自通过 `ctx.get` 读取自己的接缝，缺席时报告 `The evolution <name> store is not mounted.`，与其他可选接缝命令保持一致。
3. **在两个拥有该数据的生成器门禁中登记这五个服务及其类型**：在 `scripts/gen-cordis-catalog.ts` 中为每个服务加一条 `SERVICE_PAGE` 条目、为每个导出类型加一条类型链接豁免，并在 `scripts/gen-doc-graphs.ts` 中加一行服务角色。
4. **把五行加入软件包分组表**（双语），并记录该双语配对。

## 考虑过的替代方案

- **只挂载到可选的优化器覆盖层**（`apps/cli/config/examples/evolution-optimize/cordis.yml`），也就是它们唯一的写入方所在之处——否决：九个同级「仅记录」存储（population、novelty、stagnation、islands、self-model、uncertainty、adversary、lineage、sleeptime）早已挂载在产品 profile 中，尽管优化器在其中是禁用的。正是 profile 挂载让这些存储在出厂产品中可被检视，而优化器那行 `disabled: true` 才是决定它们是否被填充的唯一开关。
- **让优化器应用推荐而不只是记录**——推迟，而非否决：§26 把第 3–5 层限定在强治理之后，而这五个 README 每一个都声明该存储是记录而非策略。应用推荐会改变引擎实际运行的内容，那是一个需要自行承担证据负担的独立决策。
- **把 `/evaluator-strategy` 并入 `/evaluators`**——否决：两个存储回答不同问题（实测判定健康度与习得的评估器信任度），一个命令的帮助文本无法同时描述两者。
- **扩展现有命令的用法字符串而不是新增命令**——否决：每个存储的文法都是多动词的（`recommend`、`rank`、`spends`、`effectiveness` 等）；把五套文法塞进四个外来命令名下，会让 `/routes` 与 `/router` 对用户而言无法区分。

## 影响

- 优化器的五个记录接缝如今能到达已挂载的存储，因此一次运行会记录它实际使用的算子组合、评估器印证、预算配额与结算、评估路由以及引擎配置，而这些存储由此推导出的推荐也变得可读。
- 这五个存储在出厂产品中都无需开启任何东西即可检视：各动词会报告空状态，并指明是哪次运行会填充它。
- 目录门禁现在携带这五个包的词汇表，因此日后向其中任一包新增类型时，生成器会像对待其他演进包一样，在完成分类之前报错。
- 五份双语配对记录不再被截断，因此 `verify-translation-pairing` 会真正校验它们，而不再报告其格式错误。

## 与计划的偏差

本次变更的计划来自对规范 §51 优先级地图的缺口审计，而非来自 §58（后者当时已经完成）。该审计把这一个区块排在最前，因为四位独立审计者分别得出了同一结论；工作遵循的是该排序，而不是继续按 §51 的条目顺序推进。

## 过程中发现的修复

- `verify-translation-pairing` 报告这五个包的 `README.i18n.yaml` 全部格式错误：这些文件被提交时只有说明注释，没有哈希行。它们的英文与中文两侧逐行、逐个标题完全一致，因此写入的是记录，而不是修补配对。
- `/routes` 的 `evidence` 分支把 `rest[0]`（`string | undefined`）传给了要求 `EvolutionRole | undefined` 的位置。现在守卫先绑定角色，参数在调用处即可收窄。
- `gen-cordis-catalog` 要求每个服务方法的类型都被分类、每个入目录的服务都指明其子系统页面，而 `gen-doc-graphs` 要求每个服务有一行角色。这五个包在任一生成器可运行之前，需要 31 条类型豁免、五条页面条目与五行角色。

## 测试

`packages/evolution/command-evolution/tests/command-evolution.spec.ts` 新增五个桩存储与五组测试，每个命令覆盖：未挂载错误、每一条用法拒绝、空状态，以及填充后的渲染——包括由存储自身拥有的算术（一个在配额内的批次与一个超出配额的批次、证据不足的推荐、有统计但无排名的产物类别、不可用的角色参数、排名与其统计的合并）。注册测试断言每个定义的 id、name、description 与 input hint，拆卸测试断言每个命令都会注销。该包 199 个测试通过。`verify-cordis-config` 通过 144 个配置文件，四个生成器（`gen-config-catalog`、`gen-cordis-catalog`、`gen-doc-graphs`、`gen-module-graph`）均干净运行。

## 未触及

这五条推荐是记录而非策略：`/meta recommend`、`/operators`、`/evaluator-strategy`、`/budget` 与 `/router` 报告各存储学到的东西，且都不改变引擎实际运行的内容。这些存储只在可选优化器启用时才被填充。command-evolution 的 README 命令表仍缺少本次变更之前落地的十五个报告命令，因此本次变更只为自己新增的五个命令补了行，而没有补全整张表。
