# Agent Note: Center-track page seat

Status: implemented

[English](2026-09-10-center-track-page-seat.md) | 中文

## 问题

frame 只提供一个放“自己的整块界面”的位置：`shell.overlay`，一个位于所有栏目之上的可穿透浮层。因此，一个作为*目的地*而非通知的界面——Workspace 页面、文档页、仪表盘——要么只能在其中伪装成应用级页面，配上固定遮罩、居中面板与 `role="dialog"`，要么直接替换 `conversation`，并连带删除其占用方声明的每一个席位（会话主体、输入框、hero、整个输入 dock）。两者都不像页面：前者遮住用户仍然需要的导航栏，后者让“打开页面”变成一次进程级卸载。

`ui-workspace-memory` 走了前一条路，并为此付出两次代价：页面读起来像模态框，而且它的样式表命名了八个在 `ui-theme` 中根本不存在的 `--dsw-*` 属性（`--dsw-surface`、`--dsw-text`、`--dsw-border`、`--dsw-track`、`--dsw-accent`、`--dsw-danger`、`--dsw-overlay-mask`、`--dsw-z-overlay`），于是所有颜色都落到写死的浅色字面值上，深色模式下页面依然是白的。

## 决定

`ui-layout` 在 `root` 下声明第五个子席位：`shell.page`，`single` 基数、`root` 作用域，由 `AppFrame` 渲染在一个与会话共用中栏轨道的页面层中。

- **同一时刻只有一个页面，绘制在会话之上。** 页面层是与 `.centerCol` 处在同一网格单元的网格项（`grid-area: 1 / 2`），因此无需测量即可跟随侧栏宽度，并由中栏的 `overflow: hidden` 裁剪在该轨道内。侧栏与右栏保持自身几何并且仍可使用。
- **会话始终挂载在下方。** 该席位无人占用时不渲染任何内容；占用方渲染 `null` 时该层保持可穿透（`.pageLayer` 设置 `pointer-events: none`，其直接子元素再选择性恢复），因此关闭页面既不会卸载，也不会丢失会话状态。
- **席位只在页面展示期间存在。** `ui-workspace-memory` 在该席位的 inject 生命周期内注册自己的 seat，并把该注册同步到自身的打开状态，在关闭与插件销毁时释放。若常驻注册并在关闭时渲染 `null`，每个空白 Session 都会被报告为中栏被占用，从而压制本该保留的居中 Hero。
- **在 `.centerCol` 上使用 `isolation: isolate`。** 会话自身的 z-index 最高到 100（上下文仪表）与 1100（统计对话框）。把它们限制在该栏内，页面层才能用一个声明为 `1` 的层级胜出，而不是用一个必须始终领先于所有占用方、无人能维护下去的数字。
- **该席位不承载任何外观契约。** 标题与布局属于页面组件；`shell.page` 只提供区域与层叠关系。`ui-workspace-memory` 在其中注册 `WorkspaceMemorySeat`，其页面以普通的可滚动界面渲染名称与描述行（名称、路径、描述），以及产出、会话/动态标签页和三张卡片。
- **页面会把该栏让给在别处打开的任何 Session。** 中栏的意义就是显示当前所选会话，滞留的页面会把那次点击的含义反过来。两条路径覆盖它：`ui-workspace` 的会话行在 `sessions.open()` 之前调用 `workspacePage.close()`——这同时覆盖了点击*已经选中*的那个会话的情况，此时订阅方观察不到任何状态变化——而页面插件订阅会话列表以覆盖其余入口（fork、仪表盘、create）。选择被清空时页面保留：无会话视图显示的正是这个页面。
- **页面与常驻 composer 共同分配轨道。** 占用轨道的页面在自身名称与描述下方留出 composer band，并发布 band box 供 seat 停靠；打开页面会解析该 Workspace 的空白 Session，使 composer 拥有活的绑定。[实时 composer 笔记](2026-09-10-workspace-page-live-composer.zh.md)承载 composer 的引入——它取代了本笔记原先放在页面自有模块中的提问框——两者的交界由 [composer band 笔记](2026-09-10-workspace-page-composer-band.zh.md)承载。

## 备选方案

- **保留 `shell.overlay` 并把页面改成整屏样式。** 否决：浮层是覆盖整个 frame 的 `position: absolute; inset: 0` 且 `z-index: 20`，放在那里的整屏页面必然遮住侧栏与缩放手柄，还需要自行抑制遮罩与指针事件规则才能不拦截 frame 自身控件。它同样让页面无法使用会话的网格几何，并保留了那个语义谎言：把目的地渲染成浮层。
- **以更高优先级注册到 `conversation`。** 否决：`conversation` 是 `single`，胜出者会替换随包附带的占用方，而该占用方声明的每个席位（`conversation.session`、`conversation.composer`、`conversation.hero.*`、输入 dock）都会随之消失。打开页面会卸载会话引擎，而不是把它藏起来。
- **把页面层放进 `.centerCol` 内部。** 否决，理由是绘制顺序：层叠上下文只在*彼此之间*约束后代，因此列为 1 的页面层放在栏内仍会输给列为 100 的上下文仪表。页面层必须是该栏的兄弟节点，而该栏必须隔离，兄弟节点的层级才有意义。
- **引入路由：`history.pushState`、每页一个 URL、前进/后退。** 否决，因为那是另一项能力而非更小的一步。客户端目前没有路由词汇（导航即 `sessions.current`），而 URL 方案必须为未来每一个页面席位决定持久化、深链与刷新语义。`shell.page` 是路由将要驱动的组合原语。
- **保留页面上的 document 级 Escape 监听。** 否决：页面自身的 `Modal` 已经监听 Escape，于是一次按键会同时关掉记忆预览的模态框和它背后的页面——页面是界面而不是临时浮层，它通过掌握选区的界面离开。
- **只按观察到的选择变化让页面让位。** 否决，因为不完整：点击已经选中的那个会话不产生任何状态变化，订阅方永远不会触发，这次点击看起来就被忽略了——正是这个反馈促成了 opener 服务上的 `close()` 动词。仅靠订阅也无法感知来自其它位置的、针对当前 id 的 `sessions.open()`。
- **让提问框用 `ui-primitives` 的按钮而不是 composer 的圆钮。** 否决：需求是两个 composer 读起来像同一个控件，而 `Button` 的胶囊是另一个控件、另一种尺寸、另一套 token 家族。目录的规则——先复用再改样式，第二个使用方出现时提取——正是第三个使用这个圆钮的人应当重新审视的地方。自[实时 composer 笔记](2026-09-10-workspace-page-live-composer.zh.md)起该讨论已不再适用：页面不再自行渲染任何输入。
- **通过把页面的提示词接进 composer 来复用它。** 此处否决：组合出来的 composer 是会话作用域的（`conversation.composer`，`session` scope），驱动的是实时 Session 的键盘、草稿与队列；而页面的提示词是在 Workspace 中创建*新* Session。二者共享的是外观，不是契约。在页面能够解析出属于自己的空白 Session 之后，[实时 composer 笔记](2026-09-10-workspace-page-live-composer.zh.md)重新审视了这一点：composer 保持其契约，由页面把中栏让给它。

## 后果

任何功能现在都能以页面形式拥有中栏，而无需触碰 `ui-conversation`，且打开页面时 Workspaces 导航栏得以保留。代价是多了第四个 frame 区域，其占用方必须保持页面不透明（CSS module 设置了背景），并且在无内容可显示时渲染 `null` 而不是空壳，否则它会不可见地盖在会话之上并吞掉点击。页面也不再是自己存在状态的唯一所有者：侧边栏通过打开它的同一个 Cordis 服务把它关闭，因此一个失去了对应主体的页面可以从它自己的模块之外被撤销。

Workspace 页面本身已按真实的 ui-theme 别名重写样式（`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-*`、`--dsw-alias-label-*`、`--dsw-alias-border-l*`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-state-error-primary`、`--dsw-alias-markdown-placeholder`），因此与其它功能界面一样跟随明暗主题；它为其渲染的每个元素都命名了一个类，而不是把裸 `<button>`、`<h2>`、`<textarea>` 留在浏览器默认样式下。其操作走 `Button`、`Pill` 与 `Input` 原语；列表行与多行编辑器保留在本地，这正是原语目录为页面专有控件保留的空间。
