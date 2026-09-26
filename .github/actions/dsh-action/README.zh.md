# dsh Action

[English](README.md) | 中文

## 摘要

复合 action `dsh` 以 headless profile 运行一个任务，把该次运行的按行分隔的 stream-JSON 事件写入文件，并在运行未完成时让作业失败。它从 npm registry 安装已发布的 `@deepseek-ai/dsh` CLI，从不构建本仓库，因此调用方无需检出 dsh 自身。`action.yml` 声明输入与输出；`report.mjs` 把运行事件文件转成作业摘要、步骤输出与失败评论。

## 目录

- [用法](#usage)
- [输入](#inputs)
- [输出](#outputs)
- [运行行为](#run-behavior)
- [限制](#limitations)
- [开发备注](#dev-note)

<a id="usage"></a>

## 用法

```yaml
- uses: actions/checkout@v6
- id: dsh
  uses: <owner>/deepseek-harness/.github/actions/dsh-action@<ref>
  with:
    task: Review the open pull request and post one review comment.
    api-key: ${{ secrets.DEEPSEEK_API_KEY }}
- run: printf '%s\n' "${{ steps.dsh.outputs.answer }}"
```

Action 自行安装 CLI，因此只需要一次 harness 运行的调用方可以省略检出。`api-key` 是唯一没有可用默认值的输入：它以 `DEEPSEEK_API_KEY` 转发给运行，且绝不被回显。

<a id="inputs"></a>

## 输入

| 输入 | 必填 | 默认值 | 含义 |
|---|---|---|---|
| `task` | 是 | — | 作为单条用户消息提交的任务文本。 |
| `api-key` | 是 | — | 以 `DEEPSEEK_API_KEY` 传给运行的凭据。请从仓库 secret 传入，让 runner 完成掩码。 |
| `base-url` | 否 | 空 | 以 `DEEPSEEK_BASE_URL` 传给运行的提供方端点；留空使用提供方默认值。 |
| `patch` | 否 | 空 | profile 需要部署行时以 `--patch` 转发的单个 Cordis patch overlay 路径。 |
| `cli-version` | 否 | `latest` | 从 npm registry 安装的 `@deepseek-ai/dsh` 版本或 dist-tag。 |
| `node-version` | 否 | `24` | 安装 CLI 前安装的 Node.js 版本。 |
| `working-directory` | 否 | `${{ github.workspace }}` | 运行所在目录。 |
| `result-path` | 否 | `dsh-result.jsonl` | 运行事件写入的文件，相对 `working-directory`。 |
| `comment-on-failure` | 否 | `true` | 失败的运行是否把失败结果评论到触发它的 pull request 或 issue。 |
| `github-token` | 否 | `${{ github.token }}` | 该评论使用的 token，以 `GH_TOKEN` 传入且绝不被回显。 |

<a id="outputs"></a>

## 输出

| 输出 | 含义 |
|---|---|
| `answer` | 已完成运行的最终回答文本；运行失败时为空。 |
| `status` | 运行是完成还是失败。 |
| `result-path` | Action 写入的运行事件文件路径。 |

<a id="run-behavior"></a>

## 运行行为

三个步骤依次执行。安装步骤按 `cli-version` 全局安装 CLI，dist-tag 同样适用。运行步骤启动 `dsh --profile headless --json`，在设置了 `patch` 时追加 `--patch <overlay>`，并把 `task` 作为用户消息传入；它把运行事件写入 `result-path`、把运行的 stderr 写入 `<result-path>.stderr`，并把退出码记入步骤输出而不是直接失败，从而让报告步骤仍然执行。

报告步骤在 `if: always()` 下运行，因此安装或运行的失败同样要向作业交付报告。它把 `## dsh run <status>` 连同事件数、退出码与有界的运行结果正文追加到作业摘要，设置 `answer`、`status` 与 `result-path` 输出，并在运行失败时以非零状态退出，使作业失败。启用 `comment-on-failure` 的失败运行会通过 REST API 把失败正文评论到该事件的 pull request 或 issue；缺失或无法解析的退出码按失败处理而不是当作已完成运行，失败正文在 8000 字符处截断并带 `[truncated]` 标记。

<a id="limitations"></a>

## 限制

本仓库没有任何工作流使用该 Action，因此其已发布面只由报告器自身的无密钥套件（`node --test .github/actions/dsh-action/report.test.mjs`）覆盖。工作流由调用方提供；Action 既不自行调度，也不发布 harness 的发行版。

该 Action 不会把运行结果回传到 [`dsh-webhook-github`](../../../packages/webhook/webhook-github/README.zh.md) 中的 webhook 应用。该应用用一个新的 Session 响应一次 GitHub 投递并返回 `202`，而 Action 运行一个任务并报告它，因此需要回帖回答的部署应二选一，或把两者都接上。

失败评论需要事件携带 pull request 或 issue 编号；其他事件只报告而不评论。评论是尽力而为的：被拒绝或失败的请求只记录警告，绝不改变运行的退出码。运行器必须能访问 npm registry 与提供方端点。

<a id="dev-note"></a>

## 开发备注

`report.mjs` 读取运行事件文件，投影出其终局事实，并写入摘要、输出与评论；它读取 `GH_TOKEN`，绝不把该 token 或请求细节写入任何输出。`report.test.mjs` 通过注入的环境、请求函数与输出追加覆盖摘要投影、评论定位、截断以及每一种报告结果，因此无需提供方密钥或网络即可运行。
