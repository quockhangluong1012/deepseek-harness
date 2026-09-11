# Agent Note: Dashboard split — left-sidebar all-sessions overlay, right tab current-session only

Status: implemented

[English](2026-09-10-dashboard-split-current-and-all-sessions.md) | 中文

## 问题

用量仪表盘唯一的右侧 Sidebar tab 混了两种受众：当前会话的实时数字与跨会话台账总数共用一个正文、一个过滤器、一次拉取生命周期。问单个会话花了多少的操作员要越过窗口总数、图表与模型表；问全部花了多少的操作员在按会话的右侧栏之外没有入口，而右侧栏在 hero 视图下是收起的，且必须打开会话才能挂载。

## 决定

在 `@deepseek-ai/dsh-client-ui-usage-dashboard` 里拆分界面，台账不动（[前序记录](2026-09-09-usage-dashboard.zh.md)）：

- 右侧 Sidebar 的 `usage` tab 只保留当前会话。正文读会话自身的 `tokenUsage` 与 `sessionStats` 投影，绘出实时头部加累计统计卡片，无范围过滤、无 Remote 拉取。
- `sidebar.footer.action` 里的 `Dashboard` 入口（宽行与 56px rail 两种形态）打开全视口浮层，展示跨会话数字：today/近 7 天/近 30 天/全部过滤、窗口统计卡片、UTC+7 按天堆叠图、按模型表格，经 `usageDashboard` Remote 命名空间读取。浮层对话框是底部动作行的 fixed-position 后代（Settings 外壳的先例），因此改动只向 `sidebar.footer.action` 列表席位新增，不替换任何 occupant，keyed tab 席位保持原样。
- 共用渲染（计数格式化、柱状几何、汇总卡片/图表/表格）放在两处正文都导入的一个 `display.tsx` 里；仪表盘 store 与代际守卫的 face 改为服务浮层唯一的 root 作用域桶，不再按 tab 区分会话桶。

## 备选方案

- **中间列 `conversation.view` tab 放全会话。** 否决：视图 tab 是会话作用域，会和 Chat/Trajectory 争会话头部，而全会话数字与会话无关。浮层在没有会话挂载时也能展示。
- **对话框挂 `shell.overlay` 席位。** 否决：触发器与对话框将是两个注册，跨 apply 边界共用一个 store；Settings 的先例（浮层做触发器自身的 fixed-position 后代）把触发与对话框收在一个注册里，打开状态只用组件本地 state。
- **右侧 tab 保留过滤器并固定为 `all`。** 否决：过滤器选的是跨会话窗口，对累计的单会话投影没有意义——拿掉拉取，过滤器的唯一输入也不存在了。
- **会话 tab 与 root 浮层共用一个 store handle。** 被 slot core 的 one-handle-one-scope 规则否决；会话 tab 不再持有拉取状态，handle 只服务浮层。

## 后果

操作员无需导航即可得到两个答案：会话花销在会话旁边，总数在左侧 Sidebar 一个入口之后。右侧 tab 零 RPC；浮层每个选中范围拉取一次，重开复用已落定汇总。代价是底部多一行，以及打开时盖在框架上的一层浮层。

## 测试

客户端单测锁定会话面板（实时头部、累计卡片、无过滤、无拉取）与浮层（宽/rail 触发、打开拉取、过滤切换与落定复用、空框架、落定旁失败/重试、按钮/遮罩/Escape 关闭、重开不重拉）。apply 单测锁定两处注册与其卸载；store、face、辅助函数与 Host 委托单测不变。
