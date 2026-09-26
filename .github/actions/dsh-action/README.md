# dsh Action

English | [中文](README.zh.md)

## Summary

The composite action `dsh` runs one task in the headless profile, publishes the run's newline-delimited stream-JSON events to a file, and fails the job when the run does not complete. It installs the published `@deepseek-ai/dsh` CLI from the npm registry and never builds this repository, so a caller needs no checkout of dsh itself. `action.yml` declares the inputs and outputs; `report.mjs` turns the run-event file into the job summary, the step outputs, and a failure comment.

## Table of Contents

- [Usage](#usage)
- [Inputs](#inputs)
- [Outputs](#outputs)
- [Run behavior](#run-behavior)
- [Limitations](#limitations)
- [Dev Note](#dev-note)

<a id="usage"></a>

## Usage

```yaml
- uses: actions/checkout@v6
- id: dsh
  uses: <owner>/deepseek-harness/.github/actions/dsh-action@<ref>
  with:
    task: Review the open pull request and post one review comment.
    api-key: ${{ secrets.DEEPSEEK_API_KEY }}
- run: printf '%s\n' "${{ steps.dsh.outputs.answer }}"
```

The Action installs the CLI itself, so a caller that only wants a harness run may omit the checkout. `api-key` is the one input without a usable default: it is forwarded to the run as `DEEPSEEK_API_KEY` and never echoed.

<a id="inputs"></a>

## Inputs

| Input | Required | Default | Meaning |
|---|---|---|---|
| `task` | yes | — | Task text submitted as one user message. |
| `api-key` | yes | — | Provider credential passed to the run as `DEEPSEEK_API_KEY`. Pass it from a repository secret so the runner masks it. |
| `base-url` | no | empty | Provider endpoint passed to the run as `DEEPSEEK_BASE_URL`; empty uses the provider default. |
| `patch` | no | empty | Path of one Cordis patch overlay forwarded as `--patch` when the profile needs a deployment row. |
| `cli-version` | no | `latest` | Version or dist-tag of `@deepseek-ai/dsh` installed from the npm registry. |
| `node-version` | no | `24` | Node.js version installed before the CLI. |
| `working-directory` | no | `${{ github.workspace }}` | Directory the run works in. |
| `result-path` | no | `dsh-result.jsonl` | File the newline-delimited run events are written to, relative to `working-directory`. |
| `comment-on-failure` | no | `true` | Whether a failed run comments its failure result on the triggering pull request or issue. |
| `github-token` | no | `${{ github.token }}` | Token used for that comment, passed as `GH_TOKEN` and never echoed. |

<a id="outputs"></a>

## Outputs

| Output | Meaning |
|---|---|
| `answer` | Final answer text of a completed run; empty when the run failed. |
| `status` | Whether the run completed or failed. |
| `result-path` | Path of the run-event file the Action wrote. |

<a id="run-behavior"></a>

## Run behavior

Three steps run in order. The install step installs the CLI globally at `cli-version`, which also covers a dist-tag. The run step starts `dsh --profile headless --json`, appends `--patch <overlay>` when `patch` is set, and passes `task` as the user message; it writes the run events to `result-path`, the run's stderr to `<result-path>.stderr`, and the exit code to the step output instead of failing, so the report still runs.

The report step runs under `if: always()`, so a failed install or run still owes the job a report. It appends `## dsh run <status>` with the event count, the exit code, and a bounded result body to the job summary, sets the `answer`, `status`, and `result-path` outputs, and exits nonzero for a failed run, which fails the job. A failed run with `comment-on-failure` enabled comments the failure body on the event's pull request or issue through the REST API; a missing or unparsable exit code counts as failed rather than as a completed run, and the failure body is truncated at 8000 characters with a `[truncated]` marker.

<a id="limitations"></a>

## Limitations

No workflow in this repository consumes the Action, so its shipped surface is exercised only by the reporter's own keyless suite (`node --test .github/actions/dsh-action/report.test.mjs`). A caller supplies the workflow; the Action neither schedules itself nor publishes releases of the harness.

The Action does not post a run result back to the webhook app in [`dsh-webhook-github`](../../../packages/webhook/webhook-github/README.md). That app answers a GitHub delivery with a new Session and returns `202`, while the Action runs one task and reports it, so a deployment that needs a posted answer chooses one surface or wires both.

A failure comment needs an event carrying a pull request or issue number; other events report without commenting. The comment is best-effort: a refused or failed request warns and never changes the run's exit code. The runner must reach the npm registry and the provider endpoint.

<a id="dev-note"></a>

## Dev Note

`report.mjs` reads the run-event file, projects its terminal facts, and writes the summary, outputs, and comment; it reads `GH_TOKEN` and never writes the token or request details to any output. `report.test.mjs` covers the summary projection, comment targeting, truncation, and every report outcome with an injected environment, request function, and output append, so it runs without a provider key or network access.
