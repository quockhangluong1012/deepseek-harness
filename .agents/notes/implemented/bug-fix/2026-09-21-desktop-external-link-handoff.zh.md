# Agent Note: Desktop shell opens outbound links in the system browser

Status: implemented

[English](2026-09-21-desktop-external-link-handoff.md) | 中文

## Problem

桌面 shell 拒绝了渲染进程发起的一切新窗口，以及一切离开 `dsh-app://` 的导航：`setWindowOpenHandler` 对所有 URL 返回 `{ action: 'deny' }`，而 `will-navigate` 对任何非应用协议调用 `preventDefault()`，却不把目标交给任何地方。因此必须离开应用的链接完全没有任何反应——不开窗口、不开浏览器、也不报错。第一个可见的受害者是 Models 页的登录对话框：OAuth 流程唯一的入口是通往 `claude.ai` 的「打开登录页面」链接，点击后静默无反应，流程根本无法开始。在桌面应用中经 web 客户端渲染的每个模型可见链接或设置链接都同样静默失效。

## Decision

两个拦截点都把 `http`/`https` 目标交给 `shell.openExternal`，同时继续拒绝窗口内动作：

- `setWindowOpenHandler` 在外部打开该 URL，仍返回 `{ action: 'deny' }`，因此永远不会创建第二个应用窗口。
- `will-navigate` 阻止窗口内导航，并在外部打开该 URL。

只有 `http` 与 `https` 会到达 shell。任何其他协议——`file:`、自定义 scheme、应急文档使用的 `dsh-recovery:` 链接——都被丢弃；渲染进程无法解析的 URL 也被丢弃而不是抛错。同一个 `will-navigate` 监听器之后的恢复处理保持不变：那些链接既非 `http` 也非 `https`，仍会继续走到拥有它们的代码。

## Alternatives considered

**在应用窗口内打开链接。** 否决：该窗口以自定义协议承载应用文档，把它导航到第三方页面会用无法返回的页面取代正在运行的应用，破坏 shell 对自身文档的所有权。

**让 `target="_blank"` 创建 Electron 窗口。** 否决：第二个 BrowserWindow 需要与主窗口相同的 preload、沙箱与生命周期处理，而它承载的并不属于产品；用户浏览器里已经有登录流程所需的账号会话。

**只修登录卡片。** 否决：是 shell 在拒绝链接，而且它以同样方式拒绝了每一个链接。在卡片里修会把同一个缺陷留给 web 客户端渲染的所有其他外部链接。

**通过 OS 打开任意 scheme。** 否决：`openExternal` 会转发给该 scheme 注册的处理器，因此不受信任的页面可以要求 shell 启动本地应用；`http`/`https` 白名单把页面的触达范围限制在浏览器。

## Consequences

桌面应用中每个界面的外部链接都能工作，包括登录对话框，而应用窗口仍只承载一个文档。代价是链接在用户浏览器中打开而非应用内，这正是对 shell 不拥有的页面的预期行为。希望某个链接留在应用内的部署目前没有可声明的入口。

## Verification

[`main-startup.spec.ts`](../../../../apps/desktop/tests/main-startup.spec.ts) 驱动两个拦截点：window-open 处理器与一次 https `will-navigate` 都会以完全相同的 URL 到达 `shell.openExternal`；自定义 scheme、无法解析的目标以及 `file:` 导航既不会到达 shell，也不会创建窗口。`pnpm --filter @deepseek-ai/dsh-desktop run test` 运行它们；真实浏览器行为由打包后的应用负责验证。
