---
description: "Desktop OS notifications for turn completions, approvals, questions, and job settlements while the window is unfocused, with click-to-focus."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-desktop-notifications

English | [中文](README.zh.md)

## Summary

Show a native OS notification when a session's turn finishes, a tool asks for approval, a plan or question needs an answer, or a background job settles — but only while the Desktop window has no focus, so it never duplicates in-app status the user is already looking at. Clicking a notification brings the window forward and opens the originating session. The package is Desktop-only: it reads its bridge from `window.dshDesktop.notifications` and does nothing when that bridge is absent, so it is inert in the Web build.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package's `dsh.client` row in the Desktop composition; it needs no user action beyond OS notification permission (native apps do not prompt for this on any supported platform). Once mounted, notifications fire automatically:

- **Turn finished** — a session that was running becomes idle.
- **Approval needed** — a tool call is waiting on the approval composer.
- **New question** — a plan review or question is waiting on the composer.
- **Background job finished** — a job owned by any currently listed session leaves `running`/`stopping` for a terminal status.

Each fires once, at the moment of the transition, only while `document.hasFocus()` is false. An open approval or question withdraws its own notification once answered from elsewhere (for example, from a different window).

### When to choose it

This package is the only OS-notification surface; it is not a general toast or in-app alert system — those already exist per-domain (the approval composer, the unread session dot, the job list). Nothing else to choose between.

### Minimal configuration

The package has no plugin configuration. Desktop's `cordis.patch.yml` mounts it directly:

```yaml
- id: ui-desktop-notifications
  disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/client/index.ts` reads `window.dshDesktop.notifications` (a `DesktopNotificationBridge`, declared type-only in `src/types.ts`) and returns immediately if it is absent. It diffs two live sources on every publish: `ctx.uiSession.sessionStatus` (per-session `running` and `pendingInteraction`, already maintained by `@deepseek-ai/dsh-client-ui-session`) for turn/approval/question notifications, and `ctx.jobs.state` (`@deepseek-ai/dsh-api-job-controller`) for job settlements. Job rosters are watched for every session currently in `ctx.sessions.list`, not only the visible one, by calling `ctx.jobs.watchRows(sessionId)` for each and reconciling as sessions appear or leave the list.

Each notification carries a deterministic id (`turn:<sessionId>`, `pending:<sessionId>`, `job:<sessionId>:<jobId>`) so a later call for the same id replaces it, and clicks decode the session id back out of the second colon-delimited segment to call `ctx.uiWorkspace.openSession(sessionId)`.

Desktop wires the bridge in `apps/desktop/src/desktop-notifications.ts` (a native `electron.Notification` broker, one instance per live id) plus `apps/desktop/src/preload-notifications.ts` (the `contextBridge` surface) and `apps/desktop/src/main.ts` (the `ipcMain` handlers, and the click behavior: `mainWindow.show()` + `mainWindow.focus()` before forwarding the id to the renderer). This mirrors the existing `apps/desktop/src/update-attention.ts` native-notification pattern, but is driven by Client-observed Session and job state instead of the updater.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session UI status](../ui-session/README.md) — the `running`/`pendingInteraction`/`completionUnread` facts this package diffs.
- [Background jobs](../ui-jobs/README.md) — the in-session job list this package watches across every session.
- [Approval](../ui-approval/README.md) and [Questions](../ui-user-questions/README.md) — the composers whose pending state this package mirrors as notifications.
- [Web Client architecture](../../../docs/subsystems/web-client.md) — the Desktop bridge pattern this package follows.

-----

<a id="model-experience"></a>
## Model Experience

None, as OS notifications are user-facing presentation state and register no tool, prompt section, or Session event.

#### KV Cache effect

None; notifications do not enter a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Desktop-only: the Web build shows no OS notifications for these events.
- Notification firing is edge-triggered at the moment of transition. Regaining and re-losing window focus without a new transition does not resend a missed notification.
- A "turn finished" notification is not withdrawn if the session starts running again before the user clicks it; the OS notification simply becomes stale.
- Job rosters are watched only for sessions currently in the Session list (the sidebar's catalog), not for archived or otherwise unlisted sessions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The plugin owns no durable state; every fact it reads is republished by `ui-session` and `ui-jobs`.
