---
description: "窗口失焦时，为回合完成、审批、提问和后台任务结束发送原生 OS 通知，点击可聚焦对应会话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-desktop-notifications

[English](README.md) | 中文

## 概述

当某个会话的回合完成、某个工具请求审批、某个计划或问题等待回答，或某个后台任务结束时，弹出原生 OS 通知——但仅在 Desktop 窗口失去焦点时触发，避免与用户正在查看的应用内状态重复。点击通知会将窗口带到前台并打开对应会话。本包仅用于 Desktop：它从 `window.dshDesktop.notifications` 读取桥接，缺失时什么也不做，因此在 Web 构建中处于静默状态。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与遗留工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Desktop 组合中挂载本包的 `dsh.client` 条目；除 OS 通知权限外无需任何用户操作（各受支持平台的原生应用均不会为此弹出提示）。挂载后，通知会自动触发：

- **回合完成** — 某会话从运行中变为空闲。
- **需要审批** — 某个工具调用正在等待审批面板。
- **有新问题** — 计划审阅或提问正在等待输入框。
- **后台任务已结束** — 任一当前列出的会话所拥有的任务，从 `running`/`stopping` 转为终止状态。

每个事件在状态转变的那一刻仅触发一次，且仅在 `document.hasFocus()` 为 false 时触发。若某个待处理的审批或问题在别处（例如另一个窗口）被回答，对应的通知会自行撤回。

### 何时选择它

本包是唯一的 OS 通知入口，并非通用的 toast 或应用内提醒系统——那些已按领域各自存在（审批面板、未读会话圆点、任务列表）。没有其他可供选择的对象。

### 最小配置

本包没有插件配置。Desktop 的 `cordis.patch.yml` 直接挂载它：

```yaml
- id: ui-desktop-notifications
  disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

`src/client/index.ts` 读取 `window.dshDesktop.notifications`（一个 `DesktopNotificationBridge`，在 `src/types.ts` 中仅作类型声明），缺失时立即返回。它在每次发布时对两个实时数据源做差分：`ctx.uiSession.sessionStatus`（每个会话的 `running` 与 `pendingInteraction`，由 `@deepseek-ai/dsh-client-ui-session` 维护）用于回合/审批/提问通知，`ctx.jobs.state`（`@deepseek-ai/dsh-api-job-controller`）用于任务结束通知。任务名册的监听覆盖 `ctx.sessions.list` 中当前列出的每一个会话，而非仅可见会话：对每个会话调用 `ctx.jobs.watchRows(sessionId)`，并随会话的加入或离开进行调节。

每个通知携带一个确定性 id（`turn:<sessionId>`、`pending:<sessionId>`、`job:<sessionId>:<jobId>`），因此同一 id 的后续调用会替换前一个；点击时从以冒号分隔的第二段解码出会话 id，调用 `ctx.uiWorkspace.openSession(sessionId)`。

Desktop 端的桥接实现在 `apps/desktop/src/desktop-notifications.ts`（一个原生 `electron.Notification` 代理，每个存活 id 对应一个实例）、`apps/desktop/src/preload-notifications.ts`（`contextBridge` 暴露面）以及 `apps/desktop/src/main.ts`（`ipcMain` 处理器，以及点击行为：先 `mainWindow.show()` 加 `mainWindow.focus()`，再把 id 转发给渲染进程）。这与既有的 `apps/desktop/src/update-attention.ts` 原生通知模式相同，只是驱动源是 Client 观察到的会话与任务状态，而非更新器。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [会话 UI 状态](../ui-session/README.zh.md) — 本包差分的 `running`/`pendingInteraction`/`completionUnread` 事实。
- [后台任务](../ui-jobs/README.zh.md) — 本包跨会话监听的会话内任务列表。
- [审批](../ui-approval/README.zh.md) 与 [提问](../ui-user-questions/README.zh.md) — 本包以通知形式映射其待处理状态的输入框。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md) — 本包遵循的 Desktop 桥接模式。

-----

<a id="model-experience"></a>
## Model Experience

无，因为 OS 通知是面向用户的呈现状态，不注册任何工具、提示词片段或 Session 事件。

#### KV Cache effect

无；通知不进入模型请求。

## 已知限制与遗留工作

<a id="known-limitations-and-deferred-work"></a>

- 仅限 Desktop：Web 构建不会为这些事件显示 OS 通知。
- 通知触发是边沿触发的，仅发生在状态转变的那一刻。窗口重新获得再失去焦点，不会补发错过的通知。
- 若会话在用户点击"回合完成"通知前重新开始运行，该通知不会被撤回，只会变得过时。
- 任务名册仅监听当前在会话列表（侧边栏目录）中的会话，不包括已归档或未列出的会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 未发布配套包。该插件不拥有任何持久状态；它读取的每一项事实都由 `ui-session` 与 `ui-jobs` 重新发布。
