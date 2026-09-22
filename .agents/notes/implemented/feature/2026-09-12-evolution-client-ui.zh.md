# Agent Note：演进历程页面（双面客户端）

Status: implemented

[English](2026-09-12-evolution-client-ui.md) | 中文

## Problem

本家族的 Phase 6 切片——其行为由[演进式 Harness 子系统](../../../../docs/subsystems/evolutionary-harness.zh.md)描述——交付了 `evolutionController` Remote 服务、`/journey` 读模型与治理命令，但 Web 一侧仍在计划中：浏览器无法展示某个作用域记录到的演进、无法决定待审写入，也读不到整理器记录到的运行。浏览器同样无法访问 Host 的 Cordis 服务，因此建立在 `ctx.evolutionCurator` 之上的整理器卡片无法做到诚实——它只能宣称一个从未读取过的状态。

## Decision

**一个包，两个面。** `@deepseek-ai/dsh-client-ui-evolution` 同时承载浏览器页面与自己的 Host Remote 命名空间。作用域动词仍留在已落地的 `ctx.evolutionController`（`evolution` 命名空间：`read`、`setInstructions`、`setLessons`、`setProfile`、`addContextItem`、`removeContextItem`、`rebuildMemory`、`listStaged`、`approveStaged`、`rejectStaged`、`timeline({ scopeId, range })` 以及 `follow` 流）；没有动词被改名，也没有读模型被搬动。本包自己的 Host 面只新增一个命名空间、一个动词——基于 `ctx.evolutionCurator.lastRunAt()` 与 `passes()` 的 `evolutionCurator/status`——因为这是浏览器读取真实运行记录、而不是猜测它的唯一方式。未挂载的整理器会被如实报告为未挂载，绝不会被报告成一次从未发生的运行。

**页面是增量式 shell 面板，而不是第二个 `shell.page`。** `shell.page` 声明为 `{ kind: 'single' }`，并且已被工作区页面占用——后者只在打开期间注册其占用者。第二个条件性占用者会双向冲突：后打开的一方向已占用的单占席位注册，而失败会落在兄弟插件自身的注册路径里，它只知道 `ctx.get('workspacePage')`。文档化的增量扩展点是 `sidebar.panellist` 列表 id 加上对应的 `main` keyed 条目，因此历程页同时在两处注册 `evolution-journey`，并从侧边栏导航栏进入。波次计划中命名的 `journeyPage` opener 服务随该放置方案一并取消：行本身就是 opener，而一个服务也不会有人消费。

**待审行读取记录投影，而不是时间线的副本。** 页面的 `read()` 投影携带 `staged`，并由 follow 流保持实时，因此一次批准会在控制器应答的同一步清除对应行。决定之后重新拉取时间线，只为拿到记录本身不保存的每日计数（`stagedApproved` / `stagedRejected`），别无他用。

**容量来自记录自身的计量。** 已用/上限条读取 `read().usage`，两条文档条读取时间线的 `cumulative.lessonsBytes` / `profileBytes`——两者都是同一次存储调用在服务端的投影，因此浏览器中不会重新推导任何字节数。上限为零时渲染零宽条，而不是除以零。

**空状态在构造上就是诚实的。** 有界范围内被零填充的某一天是日历事实，而不是事件，因此它永远不会成为一行：页面只列出携带 delta 或决策的日期，并在旁边说明该范围的日数。没有整理器记录、没有时间线、没有待审写入各自渲染自己的一行，而一个安静的作用域会渲染这三行，而不是伪造一行。

## Alternatives considered

**按波次计划冻结的方案把页面注册到 `shell.page`。** 拒绝：该席位是单占的，而工作区页面持有它；冲突路径如上所述，且失败会表现为兄弟组件损坏，而不是页面缺失。

**提供由 `ui-workspace` 消费的 `journeyPage` opener 服务。** 拒绝：`ui-workspace` 只读取一个写死的接缝名（`workspacePage`），第二个 opener 需要修改本切片并不拥有的包，而侧边栏面板根本不需要跨包约定。

**用 `timeline.pending` 渲染待审行。** 拒绝：时间线是拉取时刻的快照，一秒后暂存的写入要到下次切换范围或刷新才会出现。

**只展示 journal 的 `memoryUpdatedAt` 作为经验/画像的唯一事实。** 拒绝：存储现已为每个家族分别打时间戳，读模型也发出彼此区分的 `instructions`、`lessons`、`profile` delta；页面渲染这些种类，而不是再次把它们合并。

**用 reviewer 的 `lastExtraction` 伪造整理器卡片。** 拒绝：reviewer 与整理器是不同的角色——一个抽取经验，另一个推动技能生命周期——混为一谈会展示一次从未发生的运行。

## Consequences

Web composition 现在可以展示历程、决定待审写入、读取记录到的整理器运行，并读取简报容量，使用的动词与 CLI 完全相同。页面每个打开的作用域需要一次 `read`、一次 `timeline`、一次整理器状态读取与一个 follow 世代；一次决定需要一次写入加上一次时间线重取。整理器卡片只与账本摘要一样丰富（`passId`、`at`、`snapshot`、变更计数），因此变更明细与回滚仍属 CLI 界面。规范中的 ZIP 历程导出与 `snapshots/web/evolution-journey` scenario 刻意不包含在本次变更内：用户已豁免快照工作，而 scenario 需要录制期望值。页面改为在真实界面上验证。

## Testing

`packages/client/ui-evolution/tests/` 覆盖 Host 面（已挂载与未挂载的整理器）、Remote 面（每个绑定动词的请求形状、失败解包、每个世代一份基线、双基线守卫、流失败、空闲至中止）、页面（包含全部 delta 种类与两类决策计数的桶、决定清除对应行、容量条、范围切换、follow 基线/upsert/失败、无作用域/加载/空状态）、席位与插件注册。`packages/client/connection/tests/evolution-fixture.client.spec.ts` 覆盖 fixture transport：每个控制器动词、整理器状态面、四个时间线窗口，以及带空闲中止的 follow 基线。本包 `src` 树的逐文件覆盖率为 100%。
