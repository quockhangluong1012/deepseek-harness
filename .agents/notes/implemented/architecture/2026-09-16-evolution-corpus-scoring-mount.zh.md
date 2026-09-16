# Agent Note: 挂载语料评分与离线优化

Status: implemented

[English](2026-09-16-evolution-corpus-scoring-mount.md) | 中文

## Problem

演化家族中有两个包没有任何 profile 挂载：`evolution-scorer`（把一条录制语料场景变成一个优化器用于选择的三元组）与 `evolution-optimizer`（改写技能正文并分选优胜者）。`/curator optimize <skill> <scenario...>` 与 `/curator experiments [skill]` 由 `command-evolution` 提供，两者都以 `ctx.get('evolutionOptimizer')` 为门，因此在产品里它们只能回答「The evolution optimizer is not mounted.」。这个缺口不是缺一行：评分器需要语料目录，优化器需要每次评分尝试所启动的 agent 组合，而这两个值在任何已发布的 profile 里都不存在。

追查一次评分尝试究竟需要什么，暴露了第二个更尖锐的缺陷。优化器把变体正文分选进临时 `DSH_HOME`，并靠把它传进子进程环境来完成评分——但录制回放 runner 会在叠加调用方环境**之后**自行构造环境，于是 `DSH_HOME` 被覆盖，每次尝试都启动工作区 home：一次运行会去评用户线上的技能，并据此晋级优胜者。尝试也没有办法指定它启动的 profile，因此只能启动自带配置语法的假 bin，永远无法启动真正的 `dsh` 入口。

## Decision

1. **两行随 Web 组合发布，但默认关闭。** `packages/bundle/web-app/cordis.patch.yml` 与家族其余行一起带上 `evolution-scorer` 与 `evolution-optimizer`，均 `disabled: true`。它们需要的是部署数据——存在哪些录制场景，以及一次尝试启动哪个 profile、哪份补丁、哪个源 bin 与哪份 tsconfig——已发布的 profile 无法凭空给出；而没有这些值它们同样无用，因为不存在的语料根会让每一次评估都响亮失败。
2. **示例覆盖层是受支持的开启方式。** `apps/cli/config/examples/evolution-optimize/cordis.yml` 用检出自身的值把两行打开，与教同一种 opt-in 形态的 `schedule`、`mcp-memory` 示例并列。应用它之后 `/curator experiments` 变成一次台账读取，`/curator optimize` 变成一次完整运行；行上方的注释点名了该动词随后需要的凭据与触发条件。
3. **`agent.profile` 成为受校验的优化器字段。** `AgentUnderTest` 本就带 `profile`，启动器用它来启动 `--profile <name> --patch <path>`；没有它时启动器传 `--config <path>`，而那只被测试 bin 自带的语法接受。优化器的 `agent` 配置现在把它暴露出来，因此真实部署能启动真实尝试。
4. **尝试的 home 是 harness 选项，而不是环境条目。** `RunOptions.homeDir`（以及 `AcpTestLaunchOptions.homeDir`）指定子进程的 `DSH_HOME`，默认 `<cwd>/.dsh`，`overlayRunner` 通过它传入已分选的 home。harness 也不再从调用方的 `env` 设置 `DSH_HOME`：该值只有一个所有者，覆盖层无法被静默覆盖。
5. **一个组合测试固定这套接线。** `apps/cli/tests/evolution-optimize-composition.spec.ts` 经启动自身的补丁算法组合真实 bundle 层与覆盖层，断言两行默认关闭、被覆盖层打开，并且（在桩 `process` 下求值 `!!js` 后）解析为它记录的语料、bin、补丁、profile 与 tsconfig。

## Alternatives considered

- **把两行以仓库路径直接开启挂载。** 否决：已发布 profile 服务的是安装后的产品而不是检出，`snapshots/acp` 只存在于本仓库。开启的行要么在第一次 `optimize` 时响亮失败，要么更糟——看起来已配置，实际指向虚无。
- **从正在运行的应用推导尝试组合**（它自己的 bin 路径、profile、补丁层）。否决：这会让被评分的进程成为「宿主恰好在哪运行」的隐式函数，违背仓库规则——包边界应暴露它所需的东西，而不是替它兜底。
- **给优化器在 `$DSH_HOME` 下配一份自己的语料。** 否决：语料是在别处产生的录制证据（由快照套件，或部署自己的 harness），默认目录最好情况是空的，最坏情况是误导。
- **让覆盖层只插入这两行，而不翻转已发布的行。** 否决：家族的清单应集中在一份可审计的组合文件里，而 `disabled: true` 行正是仓库既有的休眠能力发布方式（`budgets`、`ui-schedule`、`skill-badge`）。
- **以 `pathPrependedEnv` 式的配置传覆盖层 home，而不是 harness 选项。** 否决：home 是 harness 拥有的生命周期输入——它创建同级的目录、固定 sessions 根、并在捕获工作区时忽略 `.dsh`——一个随后会被 harness 替换掉的环境覆盖，正是本记录修掉的 bug。
- **把一次评分尝试记录为场景级回放。** 延后：语料本就以 keyless 方式回放，评分器从不录制，因此没有任何东西需要新的录制路径；想要更多场景的部署只需往语料里加目录。

## Consequences

当部署选择加入时，家族的动词便能触达真实的优化器，而这套接线与它解析出的值都由测试固定。代价写在包 README 中：行在被 profile 打开之前一直不可见；一次尝试会为每条场景启动一整个 profile（慢，且变异路由需要凭据）；变体在非用户自己的 home 中评分，因此依赖 SKILL.md 之外同级文件的技能仍会误评；语料根必须在首次评估前存在，而不能退化成「没有场景」。

验证：上述组合测试（默认关闭、覆盖层打开、解析出的值），79 个优化器测试（覆盖层 home 抵达 runner），以及 session-snapshot 套件中驱动**真实** spawn 路径、并从子进程 env 探针读回 `DSH_HOME` 的尝试 home 测试。
