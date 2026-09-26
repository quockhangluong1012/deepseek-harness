---
description: "面向模型的 git 工具：提交当前变更集、切换或创建分支、通过 gh 发起 pull request，以及创建或移除 worktree，供组合具备 git 能力的 agent 的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-git

[English](README.md) | 中文

## 概述

`dsh-tool-git` 让 agent 直接使用 git 操作，而不必通过原始 shell 命令：用模型自己撰写的提交信息暂存并提交当前变更集、创建或切换分支、通过 `gh` 发起 GitHub pull request，以及创建或移除 worktree。每条命令都以 argv 向量的形式经 subprocess 能力运行，因此模型与 git 之间既没有 shell 引号规则，也没有 Bash 与 PowerShell 的方言差异；长输出保持有界，完整流可从 spill 文件恢复。发起 pull request 需要安装并已认证 GitHub CLI；提交需要仓库中存在 git 身份配置。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已具备 subprocess 提供者、且 agent 需要提交、建分支、发起 pull request 或管理 worktree 的组合中挂载它，无需拼装 shell 命令字符串。

### 何时选用

当 agent 必须通过 git 本身改变仓库状态时选用它：这些工具拥有参数词汇，会在启动进程前拒绝非法分支名或空提交信息，并如实报告 git 自身的退出状态。当任务需要本包未暴露的 git 子命令——push、fetch、merge、rebase、log 或 status——时，请改用 `bash` 工具，因为本能力族刻意只包含四个变更操作，而不是一个通用 git 门面。这些工具作用于会话所在的目录，因此没有会话工作目录的组合会使用进程工作目录。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-tool-git'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `60000` | 向 `dsh-tool-call-timeout-policy` 声明的单条命令协作式截止时间；仅在该包装层已挂载时强制执行 |
| `outputMaxBytes` | `64000` | 内存中 stdout 尾部字节数；溢出时保留尾部并把完整流写入 spill 文件 |
| `spillMaxBytes` | `8388608` | 被截断的 stdout 或 stderr 流的 spill 文件总字节上限 |
| `stderrMaxBytes` | `16384` | 内存中 stderr 尾部字节数 |
| `graceMs` | `2000` | 开始终止到强制结束不退出命令之间的毫秒数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-git)是每个受支持字段的完整来源。

### 四个工具

| 工具 | 效果 |
|---|---|
| `git_commit` | 先 `git add --all`，再 `git commit --message <message>`：以模型撰写的提交信息提交完整当前变更集——修改、新增与删除 |
| `git_branch` | `git switch <name>`；`create: true` 时为 `git switch --create <name>` |
| `git_pr` | `gh pr create --title <title> --body-file -`，描述经 stdin 传入，并按需附加 `--base` 与 `--draft`；成功时返回 pull request URL |
| `git_worktree` | `git worktree add <path> [-b <branch>] [<commitish>]`，或 `git worktree remove [--force] <path>` |

每个工具都接受可选的 `repo` 目录：相对路径按会话工作目录解析，缺省时直接使用会话工作目录。

### 破坏性操作保持显式

移除 worktree 会删除其目录及仓库元数据中的对应条目；除非传入 `force: true`，否则它拒绝删除含有修改的 worktree，而 `force: true` 会丢弃这些未提交的修改。除此之外没有其他操作会移除状态：`git_commit` 从不改写历史、从不 amend、从不 force-push，也没有任何工具删除分支。模型给出的提交信息或分支名会作为单个 argv 元素传给 git，因此以短横线开头的取值会在任何进程启动前被拒绝。

### 可能出现的故障

git 的非零退出是结果而非工具错误：模型会读取输出与 `[exit code: N]` 标记。基础设施故障才是错误——调用被中止、git 无法接受的参数，或程序缺失。没有 subprocess 提供者的组合永远不会激活这些工具。每次发起 pull request 都会解析 `gh`，因此 GitHub CLI 缺失或未认证时会报告缺少什么，而不是表现为 git 失败。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 设计理念

- **argv，而非命令字符串。** 这些工具只消费 `ctx.subprocess`：每次调用解析程序、以显式 `argv` 启动，并读取收集到的输出。由于该 seam 从不做 shell 解析，同一个工具即可服务 POSIX 与 Windows 组合，提交信息可以原样包含引号或换行，模型给出的分支名也无法变成第二条命令。这正是本能力族直接消费 subprocess seam 而非 `ctx.shell` seam 的原因：shell 执行器与方言绑定（`bash -c` 或 `pwsh -Command`），其请求只承载一个命令字符串。
- **进程事实归 seam 所有。** 可执行文件解析、凭据清洗、有界收集、spill 文件、受管范围终止与退出事实都留在 `ctx.subprocess`；这些工具只负责 schema、参数前置条件、工作目录解析与渲染。
- **所有工具共用一个规范值。** 四个工具注册相同的输出形状，因此调用方对任何 git 结果一视同仁，UI 展示器也只需一个函数。
- **非零退出是值。** 只有取消、不可用参数或程序缺失才抛出；模型像解读 shell 工具那样解读退出状态与标记。
- **策略面位于他处。** 这些工具不声明任何策略。在以 enforce 模式运行 agent kernel 的部署中，需在 kernel 旁声明这些工具的能力，因为只有策略面可以扩展该词汇表。

### 源码导航

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、预算解析、参数前置条件与四个注册 |
| [`src/argv.ts`](src/argv.ts) | 每个工具的纯参数构造器，以及卡片标题使用的单行展示文本 |
| [`src/git.ts`](src/git.ts) | 可执行文件解析，以及在 `ctx.subprocess` 之上的唯一 spawn/收集路径 |
| [`src/output.ts`](src/output.ts) | 共享的规范输出 schema 及其面向模型的渲染 |
| [`src/presentation.ts`](src/presentation.ts) | 纯终端调用/结果卡片展示器 |
| [`src/types.ts`](src/types.ts) | 仅类型：配置、工具参数、规范值 |
| — | 未发布运行时不变式伴随包；subprocess seam 会校验 spawn 规格与收集到的值，而这些工具不持有可供交叉校验的持久状态 |

### 命令环境

每条命令都会获得 subprocess seam 清洗后的父环境，外加 `GIT_CONFIG_COUNT=0`（使环境中的 `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` 对失效）、`GIT_TERMINAL_PROMPT=0` 与 `GH_PROMPT_DISABLED=1`（在交互式提示处失败而非挂起）、`GIT_OPTIONAL_LOCKS=0`，以及 `LC_ALL=C`。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

当包级契约不够用时，请阅读以下页面。

- [git 组地图](../README.zh.md)——同组页面及其包表。
- [Subprocess 子系统](../../../docs/subsystems/subprocess.zh.md)——每条 git 命令使用的 spawn 规格、收集式读取器、凭据清洗与受管范围终止。
- [Subprocess Service Definition](../../subprocess/subprocess/README.zh.md)——本包所配置的请求/规格词汇与 spill 上限。
- [tool-bash](../../shell/tool-bash/README.zh.md)——用于本能力族未暴露的 git 子命令的 shell 消费者。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-git)——模型实际接收的 schema。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-git)——每个受支持配置字段及其源码声明。
- [Agent kernel](../../runtime/agent-kernel/README.zh.md)——为何工具的能力由策略面而非工具包声明。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

模型会看到 [git 工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-git)中的四份 schema：`git_commit`（`message`，可选 `repo`）、`git_branch`（`name`，可选 `create` 与 `repo`）、`git_pr`（必填 `title` 与 `body`，可选 `base`、`draft` 与 `repo`），以及 `git_worktree`（必填 `action`，取值为 `add` 或 `remove`，必填 `path`，可选 `branch`、`commitish`、`force` 与 `repo`）。每个描述都说明了破坏性形式的后果。

#### Token 影响

只要这些工具可见，每个请求都有固定 schema 开销，不随配置或仓库状态变化。

#### KV Cache 影响

在可见性与定义不变时前缀稳定。插件生命周期或 agent 范围的工具限制可能从第一个变化的定义起使复用失效。

### 命令结果

#### 模型看到的内容

渲染器先输出有界的 stdout 尾部，当 stderr 非空时再输出 `[stderr]` 区块，随后是自解释标记：`[output truncated; full output: <path-or-(unavailable)>]`、`[killed by signal: <signal>]` 与 `[exit code: <exitCode>]`。干净退出不带标记；没有任何输出的命令渲染为 `(no output)`。

#### Token 影响

调用前结果 token 为零。输出按配置上限逐流有界，而每条已输出行在被压缩前都会留在历史中。

#### KV Cache 影响

追加式；新可见内容位于可复用请求前缀之后，不会使既有 KV-cache 条目失效。

### 工具错误

#### 模型看到的内容

校验与基础设施故障统一规范为 `Error: <message>`。本包稳定出现的消息包括 `invalid message: expected a non-empty string`、`invalid title: expected a non-empty string`、`invalid body: expected a non-empty string`、`invalid path: expected a non-empty string`、``invalid branch name: "<value>"``、`git is not available in this execution world; install git, or run the command through a shell tool`、`gh is not available in this execution world; install the GitHub CLI (`gh`) and authenticate it, or open the pull request another way`，以及规范的 `tool call aborted`。

#### Token 影响

只有失败的调用会留下这些 token；被拒绝的参数不会产生命令输出，因为不会有任何进程启动。

#### KV Cache 影响

追加式；新可见内容位于可复用请求前缀之后，不会使既有 KV-cache 条目失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明了本能力族何时不合适或需要特别注意。它们是当前的包约束，而不是任务清单。

- **只有四个变更操作**——没有 push、fetch、merge、rebase、tag、log、diff 或 status 工具；其余 git 子命令由模型使用 `bash` 工具完成。
- **提交会暂存整个工作树**——`git_commit` 以不带 pathspec 的 `git add --all` 运行，因此无法做部分提交；只提交本轮改动，或用 `bash` 自行暂存并提交。
- **提交信息由模型提供**——不会根据 diff 生成信息；工具提交的内容就是收到的信息。
- **发起 pull request 需要已认证的 `gh`**——环境中的 `GITHUB_TOKEN`/`GH_TOKEN` 不会传给子进程，因为 subprocess seam 会清洗凭据形状的环境变量名；请认证 GitHub CLI 本身。只暴露创建：评审、合并、评论与关闭都不提供。
- **提交需要已配置的 git 身份**——工具不会传入 `-c user.name`/`user.email`，因此仓库或全局身份必须已存在。
- **被锁定的 worktree 仍需手动移除**——`force: true` 只会传入一次 `--force` 来丢弃修改；git 需要该选项出现两次才能移除被锁定的 worktree，本参数不做这件事。
- **enforce 模式部署必须声明这些工具**——kernel 的能力注册表按失败关闭处理，因此在以 enforce 模式运行 agent kernel 的组合中，必须在 kernel 旁声明 `git.read`/`git.write`（以及 `git_pr` 的 `network.write`）后才能运行这些工具。
- **环境中的 git 配置会失效**——`GIT_CONFIG_COUNT=0` 会丢弃环境中的 `GIT_CONFIG_KEY_n` 对，因此通过这些变量配置 git 的部署必须改用其他方式传递设置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
