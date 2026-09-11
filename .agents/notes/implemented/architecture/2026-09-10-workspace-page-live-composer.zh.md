# Agent Note: Workspace page hosts the resident composer

Status: implemented

[English](2026-09-10-workspace-page-live-composer.md) | 中文

## 问题

Workspace 页面的提问框此前是首页 composer 的手写仿制品：一个 textarea 加一个发送圆钮，没有加号/菜单按钮、回形针、模型席位、权限 chip 或 plan 席位。仅靠改样式无法填平这一差距。功能包不能引用另一个功能包的组件；而 composer 的 slot 子树只属于一个声明方：`ui-conversation` 的 `conversation` 入口渲染 `conversation.composer.bar`，该 bar 声明了七个子洞（`conversation.input.attachments`、`.overlay`、`.left`、`.plan`、`.right`、`.model`、`conversation.composer.dock`），由 `ui-attachment`、`ui-commands`、`ui-input-trigger`、`ui-model-selection`、`ui-plan` 与 `ui-chat` 填充。模型与权限席位读取的是活的 Session 状态——逐 Session 的模型目录、`permissions` 投影以及命令面——而 `InputBar` 特意在未绑定 Session 时不渲染它们。

## 决定

Workspace 页面打开在一个活的 Session 上，并与会话自身的 composer 共用中栏轨道，而不是自己绘制输入框。

- **打开页面即解析 Session。** `workspacePage.open(workspaceId)` 调用 `uiWorkspace.connectWorkspace`，复用该 Workspace 已有的空白 Session 或新建一个，然后把页面锚定到该 id 并通过 `sessions.open` 选中它。此后每次访问页面都复用同一个空白 Session，直到发出提示词。页面自有的输入已完全移除：注入的 `sendPrompt` 动词、其提示词状态、`grow` 辅助函数、提问框标记、提问框 CSS、曾短暂替代提问框的新会话入口卡片，以及全部四个 `composer.*` 词典键（`composer.title`、`.placeholder`、`.hint`、`.aria`）。
- **页面层不规定 composer 几何。** `ConversationRoot` 的 seat observer 把 composer seat 的实时高度以 `--dsh-composer-height` 发布到文档根元素（此前已为浮动 View 装饰发布到滚动容器上）。占用轨道的页面现在在自己的布局里留出该 band，并把 band box 以 `--dsh-page-composer-top`、`--dsh-page-composer-left`、`--dsh-page-composer-right` 发布；该落位由[composer band 笔记](2026-09-10-workspace-page-composer-band.zh.md)承载。文档根元素是这两棵子树唯一共有的祖先。
- **frame 告知会话页面已打开。** `ui-layout` 的 root 注册暴露一个基于 `slots.entries('shell.page')` 的注册方私有 hook；`AppFrame` 读取它、据此渲染页面层，并把同一布尔值作为 `conversation` 的 owner prop `ConvOwnerProps.pageOccupied` 传给会话。
- **轨道被占用时 composer 停靠进页面的 band。** `ConversationRoot` 以 `!pageOccupied && (…)` 计算 `hero`，因此页面存在时不渲染空白 Session 的 Hero 装饰（品牌标记、标语、Workspace chip），并让 bar 以 `composer` 变体渲染。root 自身标记 `data-page-occupied`，composer seat 在其下把发布的 band 偏移作为自身外边距——即页面在自身名称与描述下方留出的 band，正是它把这唯一的编辑器放在页面产出与会话列表之上，且不宽于它们所在的那一栏（[composer band 笔记](2026-09-10-workspace-page-composer-band.zh.md)）。
- **让位规则覆盖新的 Session。** 当页面自己的 Session 被真正对话（客户端在首次发送时、任何 Host 帧到达之前清除 summary 的 `blank` 位）、当别处打开任一其它 Session、以及侧边栏调用 `close` 时，页面让出中栏。选择被清空时页面保留。

因此页面只展示一个控件——常驻 composer——两个界面读取同一个组件、同一组席位与同一套 Session 词汇。

## 备选方案

- **保留提问框，为页面重新注册 composer。** 即由 `ui-conversation` 在页面自有键下注册第二个 bar，并让每个控件包向页面自有的洞再注册一次。否决：没有绑定的 Session 时，模型目录、权限投影、附件栏与命令菜单都会渲染为空，结果仍不是同一个 chatbox——代价却是六个包各增加一次注册，外加每个席位的暂存逻辑。
- **把共享的 composer 卡片提升到 `ui-primitives`。** 卡片（胶囊、工具行、加号/回形针、自适应高度的 textarea、发送圆钮）属于表现层，可以迁移；席位是活的 Session 状态，无法迁移。否决：这只能换来页面本就具备的外框与发送圆钮，需求点名的控件一个都没有。
- **把真正的 composer 渲染进页面层。** 一个 slot 键只有一个声明方，且只有该声明入口可以合法渲染它，因此 `shell.page` 的占用方永远无法渲染 `conversation.composer.bar`；而把 bar 注册到页面自有的键下，意味着要在那里重新声明它整张子表。
- **沿用发送时才创建 Session 的行为。** 否决：逐提示词创建的 Session 在存在之前没有可用于展示模型目录或权限的绑定，投递失败时还必须把读者带进一个空 Session。
- **把占用状态发布为全局标准 prop。** 否决：该事实是 frame 自身的渲染输入，因此它作为 owner prop 传给受其影响的子级、作为入口私有 hook 传给 frame 自身；全局标准 prop 会把它通告给所有作用域。

## 影响

Workspace 页面成为一个对话界面：每次访问对应一个会话，且首次访问某个 Workspace 会创建 composer 所需的空白 Session（后续访问复用，与 Workspace picker 自身的 connect 完全一致）。打开页面还会选中该 Session，因此页面打开的是该 Workspace 的新会话，而不是读者原先所在的会话。页面自己的提问框、其错误提示条及相应文案均已移除。

band 的几何依赖由两棵同级子树发布到文档根元素上的 CSS 变量——这是唯一可用的公共祖先；两棵子树都不直接测量对方。会话从未挂载时 band 高度未设置、band 折叠为零，这与没有页面占用轨道时的表现一致。

## 测试

`ui-workspace-memory` 固定页面入口的注册生命周期，以及打开时解析的 Workspace-Session 连接；`ui-conversation` 固定轨道被占用时的形态（Hero 装饰消失、composer seat 仍挂载在滚动容器中、`data-page-occupied` 已设置），以及没有页面占用轨道时保持不变的居中 Hero；`ui-layout` 固定占用页面之下会话仍然挂载，以及会话收到的 `pageOccupied` owner prop。
