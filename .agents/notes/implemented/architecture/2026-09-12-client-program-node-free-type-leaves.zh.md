# Agent Note: 客户端程序只对无 Node 依赖的类型叶子做类型检查

Status: implemented

[English](2026-09-12-client-program-node-free-type-leaves.md) | 中文

## 问题

`pnpm run dev:desktop` 在启动 Electron 之前会先构建仓库，而该构建的两个 TypeScript 聚合单元带出约 2000 个错误，几乎全部位于 `tsconfig.client.json` 车道。

客户端聚合单元通过 [tsconfig.base.json](../../../../tsconfig.base.json) 的 `paths` 映射解析工作区包名，而该映射把每个包指向其 `src` 目录。客户端程序一旦导入某个命名了此类包的已构建声明文件，就会把该包的源码拉进客户端程序：`@deepseek-ai/dsh-api-remotes/client` 命名了每个 Remote 包生成的 `typert.remote-client.d.ts`，而 [evolution-controller](../../../../packages/evolution/evolution-controller/src/types.ts) 又把它自己的线上协议词汇从两个宿主实现包再导出。于是客户端程序在客户端面的 `types: ["client-build-environment"]`（该处刻意不含 Node 类型）下对 `node:crypto`、`Buffer` 和 `process.env` 读取做类型检查；同时宿主的 `sessions: SessionStore` Context 合并与客户端的 `sessions: ISessions` 合并落入同一个程序，导致 `ctx.sessions.binding(...)` 这类客户端调用点按宿主服务解析而报错。

同一车道里还藏着两处更小的缺陷。客户端面为 DOM 显式列出了 `lib`，这丢失了 `Disposable`；宿主程序由 Node 类型提供该全局的兼容声明，因此只有客户端程序报告该全局缺失。另外，`apps/web/tsconfig.json` 排除了宿主面的 e2e 辅助文件，却让一个新加入的、需要启动宿主的 e2e 文件留在 `include` 中，把 `tests/scaffold.ts` 与整个宿主主干拉进了该客户端注册的项目。

## 决策

共享的线上协议词汇存放在无 Node 依赖的 `types.ts` 叶子模块中，该模块提供 `./types` 导出；凡是生成声明中命名了 `/types` 子路径的包，都配有对应的 `paths` 条目，因此客户端程序访问该子路径时读到的是叶子模块，而不是实现模块。

[packages/evolution/command-evolution/src/types.ts](../../../../packages/evolution/command-evolution/src/types.ts) 就是 `/journey` 时间线词汇的这样一个叶子：delta、日历分桶、累计和待批准类型从 `journey.ts` 移出，后者再导出它们，因此自身对外接口不变。该包的 `./types` 导出指向 `lib/types/types.{d.ts,js}`，这正是 typert 生成的 Remote 客户端本就在导入的路径。

[evolution-controller/src/types.ts](../../../../packages/evolution/evolution-controller/src/types.ts) 改为导入 `@deepseek-ai/dsh-command-evolution/types`、`@deepseek-ai/dsh-evolution-memory/types` 和 `@deepseek-ai/dsh-usage-ledger/types`，而不再导入这些包的根入口。每个根入口都是宿主实现——用量账本会打开 storage domain 并读取 `@deepseek-ai/dsh-session`，后者的 Context 合并正是宿主那一个——因此该控制器的线上协议面如今只触及既不访问 Node 全局、也不合并任何 Context 键的模块。

`tsconfig.base.json` 为线上协议面点名的子路径新增五条 `paths` 条目：`dsh-command-evolution/types`、`dsh-evolution-memory/types`、`dsh-evolution-controller/types`、`dsh-client-ui-evolution/types` 和 `dsh-client-ui-workspace-memory/types`。后两条的存在原因，是生成的 Remote 客户端会引用客户端包自身的 `./types`；没有别名时它会解析到同一个包自己产出的已构建声明，`tsc` 于是拒绝写入一个同时作为输入读取的文件。

[tsconfig.base.client.json](../../../../tsconfig.base.client.json) 在客户端 `lib` 列表中新增 `ESNext.Disposable`：[PromptFileBinding](../../../../packages/client/file-upload/src/index.ts) 继承 `Disposable`，而宿主程序声明该全局的是 Node 类型。

[apps/web/tsconfig.json](../../../../apps/web/tsconfig.json) 排除 `tests/evolution-journey.e2e.ts`，[tsconfig.host.json](../../../../tsconfig.host.json) 纳入该文件：该场景通过 `tests/scaffold.ts` 启动宿主主干，因此属于宿主聚合单元，其他启动宿主的 Web e2e 也都在那里。

vendored 的 `hmr` 与 `include` 源码仅在类型层面被纳入仓库的 `exactOptionalPropertyTypes` 与 `noUncheckedIndexedAccess` 标志；[vendor/README.md](../../../../vendor/README.md) 第 20 条逐项记录了这些差异。

同一对包还缺两处运行时声明，二者都会让桌面宿主无法加载插件树。[evolution-controller](../../../../packages/evolution/evolution-controller/package.json) 与 [ui-evolution](../../../../packages/client/ui-evolution/package.json) 会随包发布生成的 `typert.host.js`，其中导入 `zod`，而两者的 manifest 都没有声明它，于是 loader 导入 `./typert` 失败并报 `Cannot find package 'zod'`；现在两者都像其他导出 `./typert` 的包一样声明 `zod: ^4.4.3`。web-app bundle 挂载 `command-evolution` 时未提供其 Config 必填的 `profile`，该条目因此报 `$.profile missing required value`；该条目现在带上本族的 `default` 命名空间，而描述共享命名空间的注释也移到它所描述的控制器上。

## 考虑过的替代方案

**给客户端聚合单元单独一份省略宿主包的 `paths` 映射。** 客户端面同样需要对自己所属包做源码级解析，而报错的导入来自已构建的声明文件而非客户端源码，因此手工维护的子集会在每次新增 Remote 时被重新推导。叶子导出把这条边界一次性声明在拥有该词汇的包里。

**放宽受影响项目的 `rootDir`。** `apps/web` 的 `rootDir` 正是其产出布局可预测的原因，而进入其程序的宿主源码是导入图的症状，不是该目录设置的产物。放宽它只会为那些本就不属于该程序的文件生成产出路径。

**在客户端包中保留重复的时间线类型。** [packages/client/ui-evolution/src/types.ts](../../../../packages/client/ui-evolution/src/types.ts) 这一客户端镜像会作为浏览器侧对该线上协议形状的有意副本保留；删除它会让浏览器产物无谓地依赖宿主包的产出顺序。

**把 `ESNext.Disposable` 加到宿主基础配置而非客户端面。** 这是客户端独有的需求，而且仓库的宿主程序已经从 `@types/node/compatibility/disposable.d.ts` 获得该全局。在宿主基础配置上显式声明 `lib` 还会让宿主程序失去默认 DOM 库，从而破坏无关的包。

## 后果

当线上协议类型伸手去够宿主实现时，客户端程序现在会直接报错，而不是在错误的编译器面下对该实现做类型检查；`dsh-usage-ledger/types`、`dsh-evolution-memory/types` 和 `dsh-command-evolution/types` 是未来 Remote 词汇需要扩展的具名叶子。新增一个其类型文件需要新叶子的 Remote，成本是一条 `paths` 条目加一个 `./types` 导出。

包的对外表面发生变化：`@deepseek-ai/dsh-command-evolution` 的 `./types` 子路径现在解析到 `lib/types/types.{d.ts,js}`，而不是编译后的 `journey` 模块。`JourneyTimeline` 及其同类类型的消费方保持相同的类型身份，因为 `journey.ts` 再导出了这些被移走的声明。

`pnpm run build` 全程通过，两个聚合单元类型检查均为零错误：`tsc -b tsconfig.host.json` 与 `tsc -b tsconfig.client.json`。覆盖受影响包的聚焦测试通过——七个 evolution 包、`ui-evolution`、`context/evolution-memory-context`、此前把 `ctx.sessions` 解析到宿主合并的客户端 spec，以及 `test-support/client-runtime` 的组装检查（30 个文件共 401 个测试；另在负载下出现 forks worker 超时后，单独重跑 `ui-evolution` 的 36 个测试）。`pnpm run dev:desktop` 完成构建、准备开发项目、启动 Electron 并让宿主完成启动：运行中的渲染进程提供 `dsh-app://app/index.html` 并带有一个 Session 标题，而不是启动错误文档，宿主在其配置端口上的 inspector 也有响应。`pnpm run verify-tsconfig-paths` 通过，这正是那五条手写子路径别名保持正确的原因——生成区域会自我重写，且只映射裸包名。

有三项事实不属于本次改动。Web e2e 的录制 golden `snapshots/web/evolution-journey/ui.expected.md` 中带有 `background_review · p/model`，而 fixture 现在种入的是 `deepseek-official/deepseek-v4-flash`，因此该场景需要先刷新，`pnpm run test:web` 才可能变绿。`pnpm run publint` 仍会对 `ui-evolution`、`ui-workspace-memory` 以及既有的 `ui-usage-dashboard` 报告其 `files` 未发布的 `Page.module.css` 导入。而 `pnpm run doc-sync` 的失败来自 evolutionary-harness 合并遗留的破坏，而非本次改动：`evolution-trajectory/src/index.ts:123` 给 Remote 参数设了默认值，被 typert 分析器拒绝（`verify-cordis-catalog` 因此中止）；同一次合并引入的 `.agents/notes/implemented/feature/` 下若干 Agent Note 缺少双语对照与有效引用；配置目录与持久化目录已过期；`verify-export-jsdoc` 仍在列举无关的包。
