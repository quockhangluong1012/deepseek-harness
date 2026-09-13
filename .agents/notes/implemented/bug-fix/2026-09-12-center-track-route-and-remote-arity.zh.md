# Agent Note：中心轨道同一时刻只有一条路由，且 Remote 调用与其 Host 契约一致

Status: implemented

[English](2026-09-12-center-track-route-and-remote-arity.md) | 中文

## Problem

[演进历程页面](../feature/2026-09-12-evolution-client-ui.zh.md)在真实 Host 而非客户端 fixture 上运行时暴露出两个缺陷。

页面的手写 Remote 面为 `evolution/timeline` 与 `evolutionCurator/status` 声明了尾部 `AbortSignal`，而这两个 Host 方法都不接受该参数。Client API 在发送之前会按生成的 Host 契约核对实参个数，因此两次调用都在调用点失败——`client api: evolutionCurator/status expected 0 argument(s), got 1`，`evolution/timeline` 同理失败：其只接受一个参数的 Host 方法收到了两个。页面只保留一个错误槽位，因此读者只看到两者中的最后一个，而时间线卡片回落到空状态，读起来像"没有记录到活动"，而不是"这次读取根本没有执行"。

历程面板与工作区页面还同时占据中心轨道。历程页以增量方式注册进 `main` 席位（一个 `sidebar.panellist` 行加上对应的 keyed 条目），而工作区页面占用 `shell.page`，框架把它绘制在中间列之上作为覆盖层。两条路由互不知情：选中历程面板会让已打开的工作区页面盖在它上面，而打开工作区页面又会把已选中的面板留在下面，同时挡住该页面期望会话停靠的输入条。

## Decision

**手写的客户端面与其生成的命名空间完全一致，取消能力也不例外。** `packages/client/ui-evolution/src/client/rpc.ts` 按 Host 自身的实参个数声明五个 `evolution` 动词与 `evolutionCurator/status`，页面调用它们时不再传入调用方信号。取消能力属于 Host 的声明：该 TypeScript 面是手写的，因此除了契约本身，没有任何东西会拒绝一个 Host 从未接受的参数。

**中心轨道同一时刻只显示一条路由。** 这条规则的两个方向都落在导航面上，而不是框架里：

- `UiWorkspace.showPanel(panelId)` 在选中面板之前关闭工作区页面，正如 `openSession` 与 `startSession` 已经会腾空它一样。侧边栏的面板行通过它们本就注入的 `uiWorkspace` 面抵达它。
- 工作区页面 opener——`ui-workspace` 基于 `workspacePage` 接缝的浏览器侧注入——在页面接管轨道之前用 `ctx.layout.selectPanel(null)` 清除面板选中项。

## Alternatives considered

**给 Host 的 `timeline` 与 `status` 方法补上尾部 `signal`。** 拒绝：这两个方法都无法中止任何东西——`timeline` 同步折叠已记录的作用域，`status` 读取整理器账本——因此该参数只是装饰，而契约是生成的面，不是调用方。

**在选中全局面板期间由 `AppFrame` 打断工作区页面。** 拒绝：页面的打开状态存放在 `workspacePage` 接缝中，因此隐藏页面层会让该状态声称持有一条框架拒绝绘制的路由；回到会话会复活一个读者并未重新打开的页面，而每次访问面板都会丢弃页面自身的控制器状态。

**给历程页分配它自己的 `shell.page` 席位。** 拒绝：`shell.page` 是单占的且由工作区页面持有，第二个条件性占用者会与兄弟组件自身的注册路径冲突（记录在[历程页面笔记](../feature/2026-09-12-evolution-client-ui.zh.md)中）。

**把互斥规则搬进 layout 服务。** 拒绝：`shell.page` 的占用是经由 `workspacePage` 接缝抵达的页面插件状态，而 layout 服务暴露的是面板动作而非面板选中项的可观察对象，为了一条特性路由让 shell 新增一个读取 API 并不划算。

## Consequences

选中任何全局面板现在都会关闭已打开的工作区页面，而进入中心的任何其他路由——工作区名称、会话行、新建会话——都会清除已选中的面板。两个席位对轨道显示哪条路由达成一致：侧边栏高亮跟随面板，而失去轨道的页面是被关闭，而不是仅仅被隐藏。

历程页不再开启一条 Host 并不兑现的取消通道。当读者切换作用域时仍在途的读取会照常完成，并由页面自身的世代守卫丢弃。

该规则在导航写入方而非席位处执行，因此未来若有调用方在 `uiWorkspace.showPanel` 之外直接调用 `ctx.layout.selectPanel`——或有一个绕过 `ui-workspace` 浏览器侧注入的页面 opener——会重新引入覆盖。目前这些写入方是侧边栏的面板行与工作区浏览器。

## Testing

`packages/client/ui-evolution/tests/rpc.client.spec.ts` 固定了每个绑定动词在 Host 实参个数下的请求形状。`packages/client/ui-workspace/tests/workspaces-service.client.spec.ts` 固定了 `showPanel` 在选中面板之前关闭页面，以及没有页面插件的组合仍会选中面板。`packages/client/ui-workspace/tests/workspace-page-opener.client.spec.tsx` 固定了工作区名称手势会腾空面板。
