# Agent Note: Desktop shell opens outbound links in the system browser

Status: implemented

English | [中文](2026-09-21-desktop-external-link-handoff.zh.md)

## Problem

The desktop shell denied every renderer-initiated window and every navigation away from `dsh-app://`: `setWindowOpenHandler` returned `{ action: 'deny' }` for all URLs, and `will-navigate` called `preventDefault()` for any non-application protocol without handing the target anywhere. A link that must leave the application therefore did nothing at all — no window, no browser, no error. The first user-visible casualty was the Models page's sign-in dialog, whose only affordance for an OAuth flow is an "Open sign-in page" link to `claude.ai`; clicking it silently did nothing, so the flow could not be started. The same silence applied to every model-facing or settings link rendered through the web client inside the desktop app.

## Decision

Both interception points hand an `http`/`https` target to `shell.openExternal` and keep denying the in-window action:

- `setWindowOpenHandler` opens the URL externally and still returns `{ action: 'deny' }`, so no second application window is ever created.
- `will-navigate` prevents the in-window navigation and opens the URL externally.

Only `http` and `https` reach the shell. Any other protocol — `file:`, a custom scheme, a `dsh-recovery:` link the emergency document uses — is dropped, and a URL the renderer could not parse is dropped rather than thrown. The recovery handling that follows the same `will-navigate` listener is unchanged, because those links are neither `http` nor `https` and continue to the code that owns them.

## Alternatives considered

**Open the link inside the application window.** Rejected: the window hosts the application document under a custom protocol, and navigating it to a third-party page would replace the running application with a page that cannot return, breaking the shell's ownership of its own document.

**Let `target="_blank"` create an Electron window.** Rejected: a second BrowserWindow would need the same preload, sandbox, and lifecycle treatment as the main window, for a page that is not part of the product. The user's browser already holds the account session the sign-in flow needs.

**Restrict the fix to the sign-in card.** Rejected: the shell is what denies the link, and it denied every link the same way. Fixing it in the card would leave the identical defect in every other external link the web client renders.

**Open any scheme through the OS.** Rejected: an `openExternal` call forwards to the registered handler for that scheme, so an untrusted page could ask the shell to launch a local application; the `http`/`https` allowlist keeps a page's reach to a browser.

## Consequences

External links work from every surface in the desktop app, including the sign-in dialog, and the application window still hosts exactly one document. The cost is that a link opens in the user's browser rather than in-app, which is the intended behavior for a page the shell does not own. A deployment that wants a specific link kept in-app has no seat for that today.

## Verification

[`main-startup.spec.ts`](../../../../apps/desktop/tests/main-startup.spec.ts) drives both interception points: the window-open handler and an https `will-navigate` each reach `shell.openExternal` with the exact URL, and a custom scheme, an unparseable target, and a `file:` navigation reach neither the shell nor a created window. `pnpm --filter @deepseek-ai/dsh-desktop run test` runs them; the packaged application owns the real-browser behavior.
