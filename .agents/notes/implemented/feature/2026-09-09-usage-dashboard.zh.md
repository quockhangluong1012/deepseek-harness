# Agent Note: Usage dashboard tab with Host usage ledger

Status: implemented

[English](2026-09-09-usage-dashboard.md) | 中文

## 问题

Web 与桌面端一直没有产品可见的用量统计：按会话的数字只存在于聊天输入框的 pills（`tokenUsage` 与 `sessionStats` 投影）里，没有任何东西按天、按模型汇总跨会话的已计费请求。Telemetry 导出是只向外的，回答不了本地问题；也没有存储 seam 拥有跨会话聚合。

## 决定

交付两个包，按 client/host 依赖政策切分：

- `@deepseek-ai/dsh-usage-ledger`（session 组）拥有折叠与持久化。其 `ctx.usageLedger` 服务把每个活跃会话的已计费 LLM 请求——`assistant/message` 或 `assistant/attempt` 上的一个 provider 用量样本，重试计入——折叠进 `usage_dashboard` 存储域上的持久台账，并提供按范围汇总。
- `@deepseek-ai/dsh-client-ui-usage-dashboard`（client 组）拥有产品界面。其 Host 一半（`ctx.usageDashboard`）只是台账之上的 `summary` Remote。界面按[仪表盘拆分记录](2026-09-10-dashboard-split-current-and-all-sessions.zh.md)拆分：浏览器一半在右侧 Sidebar 保留 `usage` 页面类型（含引导页入口），正文只展示当前会话的实时头部与累计统计卡片（读其投影，无过滤、无拉取）；同时在 `sidebar.footer.action` 增加 `Dashboard` 入口，其浮层展示跨会话总数——总请求数、拆分的输入/输出 token、总缓存命中、平均缓存命中率、按 UTC+7 天堆叠的输入/输出柱状图（today/近 7 天/近 30 天/全部过滤，默认为今天），以及按模型表格。
- 一次已计费请求是一个校验通过的用量样本；无法证明的样本跳过，绝不补零。输入 token 是已计费提示 token（`uncached + cacheRead + cacheWrite`）；平均缓存命中为 `cacheRead / billedInput`。天固定为 UTC+7。空窗口仍绘制图表框架与其无数据行。

台账以一个原子文档持久化（按天计数、按天按模型计数、按会话折叠游标），`single` 布局加 `backup-and-skip`，因此崩溃既不会只落计数不落游标，也不会只落游标不落计数。按步桶在 `step/end` 前持有样本，落定 message 到达时把早到的未知路由样本搬移过去；回填只折叠游标之后的子会话自有事件，且每个事件重新读一次游标，因此回填途中由实时路径折叠的事件绝不会被数两次，fork 也不会重复计数。写为 write-behind（计数/时间节流加强制 `turn/end`），且 fail-soft：丢一次写只意味着下次启动回填更长，因为内存计数永远领先。

## 无图表依赖的图表

堆叠柱状图是手绘 SVG。整棵树不存在任何图表依赖，而仪表盘只需要堆叠柱状图；引入一个等于用 client 包里的新第三方表面换掉一个小而全覆盖的渲染器。若未来需要更丰富的交互，换图表库也只是一文件的事，记在包的 Known Limitations 里。

## 备选方案

- **一个双面单包持有折叠。** 被 `verify-package-dependencies` 否决：client/host 包的 Host 入口只能 value-import 已分类的 workspace 导出（agent 不得新增分类），而 stream 样本读取与存储域声明都未分类。因此折叠放在无角色 session 包里，经 `ctx.usageLedger` 提供；仪表盘 Host 入口只经注入服务委托。
- **只用按会话投影，不要 Host 服务。** 否决：`useProjection` 只能读当前会话，跨会话天与模型表在浏览器侧不可达。折叠必须归 Host。
- **用 Telemetry/OTel 做仪表盘数据源。** 否决：telemetry seam 是尽力而为的向外上报，可能丢崩溃前数据，且没有本地查询面——持久性与方向都不对。
- **用 session-query SQLite 存聚合。** 否决：那个索引是搜索拥有的一次性全文物化视图，不是数值 rollup 存；共用会把两个无关消费者绑到同一 schema 上。
- **按天、按模型用 per-record 表。** 否决：三张表无法原子地同时更新计数与游标，崩溃顺序无论哪种都会在下次回填时多计或少计。KB 级台账用单个原子文档保持一致。
- **Recharts（或其他图表库）。** v1 否决，理由如上包体积与门禁成本；SVG 渲染器与其几何辅助函数另有完整单测覆盖。

## 后果

仪表盘在产品界面给出总数、天趋势与按模型拆分，代价是每次提交用量事件都多一条 Host 写路径（节流，不在模型请求路径上），以及家目录多一个存储域。计数从挂载开始：台账首次挂载前结束的持久会话没有贡献，包 README 已声明。总数按构造少计，是参考值，绝非账单记录。

## 测试

台账行为走真实组合（SessionStore、存储栈）：实时折叠与路由搬移、未知路由、重试计数、游标守卫的回填不重复、fork 排除、经存储文档跨重启保留、定时 flush、fail-soft 写且内存照常服务。纯覆盖锁定样本校验、UTC+7 分桶、保留期清扫与按范围汇总。仪表盘面单测锁定 Remote 委托；客户端单测锁定 store、代际守卫的 face、类型注册、Remote 绑定、展示辅助函数、纯会话面板，以及浮层在加载、失败/重试、空框架、过滤切换、打开/关闭各状态。
