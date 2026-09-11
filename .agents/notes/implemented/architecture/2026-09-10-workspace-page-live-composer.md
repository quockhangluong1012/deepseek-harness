# Agent Note: Workspace page hosts the resident composer

Status: implemented

English | [中文](2026-09-10-workspace-page-live-composer.zh.md)

## Problem

The Workspace page's ask box was a hand-rolled replica of the home composer: a textarea and a send circle, with no plus/menu button, paperclip, model seat, permission chip, or plan seat. Restyling could not close that gap. A feature package may not import another feature package's component, and the composer's slot subtree belongs to one declarer: `ui-conversation`'s `conversation` entry renders `conversation.composer.bar`, which declares the seven child holes (`conversation.input.attachments`, `.overlay`, `.left`, `.plan`, `.right`, `.model`, `conversation.composer.dock`) that `ui-attachment`, `ui-commands`, `ui-input-trigger`, `ui-model-selection`, `ui-plan`, and `ui-chat` fill. The model and permission seats read live Session state — the per-session model catalog, the `permissions` projection, and the command face — and `InputBar` deliberately renders them absent while no Session is bound.

## Decision

The Workspace page opens onto a live Session and shares the center track with the conversation's own composer instead of drawing an input of its own.

- **Opening a page resolves a Session.** `workspacePage.open(workspaceId)` calls `uiWorkspace.connectWorkspace`, which reuses the Workspace's existing blank Session or creates one, then anchors the page on that id and selects it through `sessions.open`. Every later page visit reuses the same blank Session until a prompt is sent. The page's own input is gone entirely: the injected `sendPrompt` verb, its prompt state, its `grow` helper, its ask-box markup, its ask CSS, the composer entry card that briefly replaced that box, and all four `composer.*` dictionary keys (`composer.title`, `.placeholder`, `.hint`, `.aria`).
- **The page layer states no composer geometry.** `ConversationRoot`'s seat observer publishes the composer seat's live height as `--dsh-composer-height` on the document root (it already publishes it on the scroll body for floating View chrome). The occupying page now holds that band open in its own layout and publishes the band's box as `--dsh-page-composer-top`, `--dsh-page-composer-left`, and `--dsh-page-composer-right`; [the composer-band note](2026-09-10-workspace-page-composer-band.md) owns that placement. The document root is the only ancestor the two subtrees share.
- **The frame tells the conversation that a page is open.** `ui-layout`'s root registration exposes a registrant-private hook over `slots.entries('shell.page')`; `AppFrame` reads it, renders the page layer from it, and passes the same boolean to the conversation as the `conversation` owner prop `ConvOwnerProps.pageOccupied`.
- **An occupied track docks the composer into the page's band.** `ConversationRoot` computes `hero` as `!pageOccupied && (…)`, so a page suppresses the blank-session hero chrome (brand mark, tagline, Workspace chip) and renders the bar in its `composer` variant. The root marks itself `data-page-occupied`, where the composer seat takes the published band offsets as its margins — the band the page holds open beneath its name and description, which is what puts the one editor above the page's Outputs and chats, no wider than the column they fill ([the composer-band note](2026-09-10-workspace-page-composer-band.md)).
- **Yield rules cover the new Session.** The page leaves the column when its own Session is talked to (the client clears the summary's `blank` bit on the first send, before any host frame), when another Session is opened anywhere else, and through the sidebar's `close` call. A cleared selection leaves the page standing.

The page therefore shows one control — the resident composer — and both surfaces read the same component, the same seats, and the same Session vocabulary.

## Alternatives considered

- **Keep the ask box and re-register the composer for the page.** `ui-conversation` would register a second bar under a page-owned key and each control package would register a second entry into page-owned holes. Rejected: without a bound Session the model catalog, permission projection, attachment rail, and command menu all render empty, so the result is still not the same chatbox — at the price of a second registration in six packages plus new staging logic for every seat.
- **Promote a shared composer card into `ui-primitives`.** The card (capsule, tool row, plus/paperclip, grow-textarea, send circle) is presentation and could move; the seats are live Session state and could not. Rejected: this buys the frame and the send circle, which the page already had, and none of the controls the request named.
- **Render the real composer into the page layer.** A slot key has exactly one declarer and the declaring entry is its only legal renderer, so `shell.page`'s occupant can never render `conversation.composer.bar`; registering the bar into a page-owned key means re-declaring its whole child table there.
- **Create the Session on send, as before.** Rejected: a Session minted per prompt has no binding to show a model catalog or permissions before it exists, and a failed delivery would have to move the reader into an empty Session.
- **Publish the occupancy as a global standard prop.** Rejected: the fact is the frame's own render input, so it travels as an owner prop to the child it affects and as an entry-private hook to the frame itself; a global standard prop would advertise it to every scope.

## Consequences

The Workspace page is a chat surface: one chat per page visit, and the first visit to a Workspace mints the blank Session that the composer needs (later visits reuse it, exactly as the Workspace picker's own connect does). Opening the page also selects that Session, so the page opens onto the Workspace's new chat rather than onto the conversation the reader came from. The page's own ask box, its error strip, and their copy are gone.

The band's geometry depends on CSS variables published across two sibling subtrees on the document root, the only shared ancestor available; neither subtree measures the other directly. A conversation that never mounts leaves the band's height unset and the band collapses, which is also what happens while no page occupies the track.

## Testing

`ui-workspace-memory` pins the page entry's registration lifetime and the Workspace-Session connect it resolves on open; `ui-conversation` pins the occupied-track posture (hero chrome gone, composer seat still mounted in the scroll body, `data-page-occupied` set) and the unchanged centred hero while no page occupies the track; `ui-layout` pins the conversation staying mounted beneath an occupying page and the `pageOccupied` owner prop it receives.
