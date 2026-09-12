# Agent Note: 演化族进入 web-app 组合包

Status: implemented

[English](2026-09-12-evolution-family-composition.md) | 中文

## Problem

演化族此前按包逐个交付——记忆存储、评审器、简报注入器、技能遥测与管理、策展器、治理命令——每个包都有自己的测试，却没有一个被任何 profile 挂载。`packages/bundle/web-app/cordis.patch.yml` 里没有任何 evolution 行，于是一个真实的 Web 会话不读记忆、不注入简报、不跑评审，也从不注册 `skill_manage` 工具。行为契约在 `specs/evolutionary-harness.spec.md` 中已固定顺序：行先落在 `web-app`，绝不落在 `base`，这样 `headless`、`sdk`、`acp` 的快照在这些 surface 显式采纳该族之前保持逐字节不变。

## Decision

七行加入 web-app 的 insert 列表、紧邻 workspace-memory 族：`evolution-memory`、`evolution-reviewer`、`evolution-memory-context`、`evolution-skill-telemetry`、`evolution-skill-manage`、`evolution-curator` 与 `command-evolution`。守卫与容错两行（`budgets`、`llm-fallback`）早已以关闭的休眠状态挂载于此。`packages/bundle/web-app/package.json` 增加这七个 workspace 依赖，因为 [`verify-cordis-config`](../../../../scripts/verify-cordis-config.ts) 要求 profile 树中每个裸插件都必须出现在解析清单里。

两处配置是刻意的。`evolution-memory` 以 `capacityBytes: 131072` 挂载，与 workspace-memory 行一致，让两个存储共用同一个上限。评审器与注入器都声明 `profile: default`，因为同一循环的两半必须指向同一条记录：注入器的作用域键写简报，评审器的作用域键写经验，部署方只改其中一个就会把循环劈成两半。

遥测行排在使用它的两行之前——`evolution-skill-manage` 在每次变更时解析它，`evolution-curator` 在生命周期判定时解析它——因此两者发问时该存储必定已存在。

该族中没有任何包具备 client face，因此这次挂载不新增 `dsh.client` 行，也不改动浏览器名册。Web journey 页面仍属于延后的第 4 阶段工作；在它落地之前，治理仍由 CLI 命令承担。

## Consequences

Web 会话从此会学习。作用域可解析时注入器追加简报，摘要变化时替换；评审器在每个回合索引产出的文件，并在冷却门限之后提取经验；模型看到 `skill_manage` 以及「经验转技能」提示；`/memory`、`/skills`、`/journey`、`/curator`、`/refine` 无需模型回合即可作答。策展器以启用状态挂载，但目前还没有任何调用方触发 `maybeRun`：它的「间隔 + 空闲」触发器（CLI 启动、网关 housekeeping、`serve` 维护计时器）是第 4 阶段尚未落地的所有者；在该所有者落地之前，`/curator status` 报告已存的 `lastRunAt`。关闭方式就是移除这七行：不读任何记录、不注入简报，也不改变任何会话事件或持久化格式。

挂载是模型可见的，因此已录制的 Web 语料会移动。每个 `snapshots/web/**` 用例都记录 `system-prompt.expected.md` 与 `tool-schemas.expected.json`，两者都会变化——提示段、`evolution_memory_usage` 变量，以及新增的工具。`snapshots/session`、`snapshots/sdk` 与 `snapshots/acp` 运行的 profile 从不挂载该族，因此保持逐字节不变。

## Verification

`pnpm run verify-cordis-config` 在全部 143 个配置文件中通过，`pnpm run verify-cordis-catalog` 在其 103 个生成区域上通过，重新生成 `docs/config-catalog.md` 后 `pnpm run verify-config-catalog` 通过。行为仍由该族各包测试覆盖——存储上限与暂存、评审器提取与产出索引、注入器渲染与 REAL-composition 注入、判策遥测与 `skill_manage`、策展器流转与台账、以及带 Loader 组合的命令面。

在随附 profile 上端到端证明该循环的 Web 用例——简报送达适配器、产出文件被索引、暂存写入可列出并批准——是第 6 阶段的 Web journey 场景加刷新后的语料，两者都在 POSIX 主机上以 `pnpm run test:snapshot:refresh` 重新生成。

## Alternatives considered

**挂在 `base`。** 所有 surface 会一次性继承该族，包括 `headless`、`sdk` 与 `acp`——而它们的录制快照正是本仓最便宜的回归信号。否决：这是部署方选择开启的能力，不是主干默认值，且规范已固定 web 先行。

**另立一个在 `dsh-web-app` 之后应用的 `evolution` 包。** 给不需要该循环的部署更好的粒度，代价是多一个 bundle，而它今天与现有 bundle 的唯一差别就是这组行。在出现真实的第二个使用方之前否决。

**让存储配置保持隐式。** 让各部署自行发明每行的 `capacityBytes` 与 `profile`。否决：两个 profile 值必须一致该循环才能工作，因此随附行声明同一命名空间与同一上限，任何分歧都会变成一次可见的编辑，而不是静默的裂缝。
