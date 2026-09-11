# Agent Note: 桌面开发重载渲染窗口

Status: implemented

[English](2026-09-10-desktop-development-renderer-reload.md) | 中文

## Problem

Electron 桌面应用的工作区开发过去没有任何刷新回路。`dev:desktop` 会一次性构建 Host、客户端 bundle、Web 前端与 Electron 外壳，然后启动它们；Host 把组合出的客户端 bundle 与 Web 前端 `dist` 当作已安装产物从链接的工作区提供出去。浏览器的开发回路无法覆盖它：重载驱动的 node 半注入 `webServer` 以提供 `/plugins/events` SSE 通道，而桌面组合禁用了 `webserver` 行，因为请求经字节管道帧到达而不是经由监听套接字；负责页内 fiber 替换的浏览器半只为消费该通道而存在。因此，编辑客户端插件的开发者必须停止应用、重新构建并重新启动。即便是手动重载窗口也不够：模块表在不可变缓存头下从内存提供 bundle 字节，而桌面组合中没有任何东西调用 `clientModules.rebuilt`，所以重载仍会保留组合时刻的 revision。

## Decision

bundle 监视与传输无关，不含 SSE 通道的组合会单独挂载它并自行决定重建意味着什么。

- `packages/client/hmr/src/bundle-watch.ts` 拥有 stat 轮询、跟随图的监视集合以及 `clientModules.rebuilt(id)` 上报。两个 row 都挂载它，因此轮询只有一份实现与一套语义。
- `client-hmr` row 保持浏览器组合的形态：共享监视加上驱动页内替换的 `/plugins/events` 通道。
- `@deepseek-ai/dsh-client-hmr/watch`（`packages/client/hmr/src/watch.ts`）是仅监视 row。它只注入 `clientModules`，声明同一个 `pollIntervalMs` 字段，且没有浏览器半。
- 在工作区开发模式下，桌面宿主（`apps/desktop-host`，`--allow-linked-profile`）追加一层 patch，插入该 row。宿主还订阅 `clientModules.onRebuilt`，并轮询所提供的 shell index 文档，随后在 Node IPC 通道上通告 `{ type: 'renderer-rebuilt' }`。
- Electron 外壳为该事件注册监听器，并在最后一次通告 300 毫秒后重载主窗口，让一次源码编辑产生的产物写入突发先平息下来。

### 为什么桌面重载窗口而不是替换 fiber

对于这条传输而言，重载是诚实的响应：桌面渲染层是 Host 的客户端，其状态位于 Session 日志与 Host 服务中，重载窗口会重新连接并重放。要在字节管道上重新实现页内替换，首先需要桌面刻意不具备的事件通道，其次会复制一个其失败策略是针对浏览器模块表陈述的驱动。

### 开发者运行什么

与 `pnpm run dev:desktop` 并行运行 `pnpm run dev:web`。watcher 会重建客户端 bundle 与 Web 前端 dist；宿主感知到任一变化后，窗口随即重载。主进程与 preload 的改动仍需要 `pnpm run build:desktop` 并通过 `pnpm run start:desktop` 重新启动，因为 Electron 加载的是已构建的主进程。

## Alternatives considered

| 已否决 | 一句话理由 |
|---|---|
| 在桌面组合中启用 `client-hmr` row | 它的浏览器半用 `EventSource` 订阅 `/plugins/events`，而桌面传输无法承载该通道；渲染层会不断重试宿主并不提供的路由 |
| 让浏览器半检测桌面传输并保持静默 | 留下一个其半侧静默无作为的 row，把传输检测加进浏览器代码，而且仍需要仅监视 row 提供的宿主侧通告 |
| 在宿主进程中以库调用方式安装监视 | 行为相同却没有组合记录：该 row 只作为应用包内的调用点存在，对配置树与本包的不变式伴随项都不可见 |
| 在桌面字节管道上承载等价 SSE 的通道 | 为一次窗口刷新已能正确完成的动作引入第二套流式协议，并受浏览器重载驱动所驱使 |
| 在 Electron 主进程轮询产物 | 把一个进程无法看到的组合图，与其模块宿主的基线和 revision 知识重复一份；而宿主本就拥有两者 |
| 文件变化时自动重建（在开发回路内置打包器） | 让外壳与某一个构建器耦合；`pnpm run dev:web` 已是本仓库的 watcher，宿主只需观察产物 |

## Consequences

桌面与浏览器在同一个开发属性上会合：重建渲染产物无需手动重新构建即可到达运行中的应用。代价是 `dsh-client-hmr` 多出一个公开入口、开发组合多出一个 row，以及外壳必须处理的一个协议事件——桌面线路协议版本升到 4，因此不同发布版本的内置 Host 与外壳仍会彼此大声拒绝。

两条边界保持明确。已安装的应用不挂载监视 row，只提供不可变 bundle，因此工作区开发之外不会有任何进程轮询文件系统。主进程代码保留其构建加重启回路，因为重载窗口无法重载 Electron 进程。

生成的配置目录枚举的是包入口点，因此仅监视 row 的单个字段记录在包 README 而不是配置目录中；该 row 的配置与入口点声明的是同一个 `pollIntervalMs`。

## Testing

`apps/desktop/tests/desktop-host-development-reload.spec.ts` 固定开发 patch 层与产物监视：被重写的 shell 文档只上报一次并在 dispose 后停止，bundle 重建经订阅上报，而抛错的观察者不会终止轮询。`apps/desktop/tests/host-process.spec.ts` 通过真实的子进程 IPC 通道把 `renderer-rebuilt` 通告送达已注册的监听器。`packages/client/hmr/tests/node-half.client.spec.ts` 在没有任何 `webServer` 服务的上下文中挂载仅监视 row，并证明它会上报重建的 bundle 且在 dispose 后停止。
