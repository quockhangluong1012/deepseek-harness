---
description: "Web 客户端可配置的窗口键位映射：打开命令面板的组合键，以及把焦点交回输入框的组合键。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-keybindings

[English](README.md) | 中文

## 概述

`dsh-client-ui-keybindings` 让客户端的键盘快捷键真正属于用户：它把一组组合键绑定到命令面板，把另一组绑定到输入框聚焦，两者都从持久设置区读取，并在保存的那一刻即刻生效。面板就是输入框既有的 `/` 命令菜单——按下组合键会写入该标记并交回焦点——因此命令交互面只有一个而非两个，且半写完的消息绝不会被替换。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在任何显示输入框的客户端挂载 `dsh-client-ui-keybindings`——随附的 Web 与 Desktop bundle 已经这样做。设置行出现在「设置 → 通用」下。

### 键位绑定

| 动作 | 默认组合键 | 效果 |
|---|---|---|
| 打开命令面板 | `mod+k` | 聚焦输入框；为空时写入 `/`，从而打开命令菜单 |
| 聚焦输入框 | `mod+i` | 把键盘焦点交回输入框，不改动草稿 |

`mod` 是平台主修饰键：macOS 上为 Command，其他平台为 Control。组合键至少需要一个修饰键，不支持的写法会被设置行拒绝，而不是被静默忽略。点击某个快捷键后按下新组合即可录制，因此无需手写组合键语法。

### 配置

两个字段都位于 `ui-keybindings` 设置区，并投影到浏览器，因此修改无需刷新即可作用于已打开的标签页。

```ts
export interface Config {
  commandPalette: string
  focusComposer: string
}
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `commandPalette` | `'mod+k'` | 打开命令面板的组合键 |
| `focusComposer` | `'mod+i'` | 聚焦输入框的组合键 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计

- **单一捕获阶段监听器。** 键位映射在 window 上安装一个 `keydown` 监听器，每次事件都解析当前绑定，并消费自己处理的事件，因此已绑定的组合键不会继续传到编辑器或浏览器。
- **面板就是命令菜单。** 该绑定解析界面正在展示的会话，在草稿为空时写入 `/`，并聚焦输入框；既有的 trigger 管线负责打开菜单。这让命令的发现、过滤与分发只存在于一处。
- **实时重绑。** 绑定从镜像持久设置区的浏览器本地 store 读取，因此保存组合键会立即改变键位映射，而无需重新挂载。
- **当前会话来自视图。** 被操作的输入框是主视图所保留的会话，也就是界面正在展示的那个；没有可见会话的部署不会绑定任何按键。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/keybindings-settings.ts`](src/keybindings-settings.ts) | 设置命名空间、默认值与组合键文法（`parseChord`、`chordMatches`） |
| [`src/index.ts`](src/index.ts) | Host 面：可变的设置字段 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器面：偏好镜像、窗口键位映射与设置行注册 |
| [`src/client/keymap.ts`](src/client/keymap.ts) | 监听器本身，与 DOM 隔离，便于测试直接驱动 |
| `src/client/settings/KeybindingsRow.tsx` | 录制替换组合键的设置行 |
| — | 不发布运行时不变式伴生入口；键位映射是当前绑定的纯函数，设置行由客户端测试覆盖。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [命令交互面](../ui-commands/README.zh.md)——面板所打开的菜单。
- [输入框契约](../ui-conversation/README.zh.md)——绑定所驱动的会话级输入接口面。
- [设置运行时](../ui-settings/README.zh.md)——组合键所存放的配置表单。

-----

<a id="model-experience"></a>
## 模型体验

### 键位绑定的副作用

#### 模型看到的内容

只在用户随后提交时看到用户输入的内容。键位映射在浏览器内改变输入框的草稿与焦点：它不贡献提示词区段、消息、工具或 schema，也不追加会话事件。当面板动作用写入 `/` 时，模型只在该命令被提交时看到它，与用户手输完全一致。

#### Token 影响

键位映射本身为零。若一次面板按键最终提交了某条命令，其成本正是该命令的成本，不多不少。

#### KV Cache 影响

无影响。焦点与草稿的变化不会进入任何请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定键位映射当下的能力边界。它们是当前包约束，不是任务积压。

- **两个动作，且不支持组合序列**——可绑定动作只有命令面板与聚焦输入框，一个组合键是「带修饰键的单个键」；多键序列（`mod+k mod+s`）与按面板绑定均不解析。
- **无冲突检测**——组合键可能与浏览器或操作系统快捷键冲突；监听器只能消费页面收到的事件，且不会对冲突发出警告。
- **面板不是全局搜索**——它打开的是命令菜单，因此列出的是命令及其参数提示，而不是文件、会话或设置。
- **绑定作用于整个窗口**——所有绑定都作用于整个应用；组合键无法限定在某个面板，也无法在文本框获得焦点时禁用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
