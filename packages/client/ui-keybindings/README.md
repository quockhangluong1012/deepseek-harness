---
description: "Configurable window keymap for the Web client: the chord that opens the command palette and the chord that returns focus to the composer."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-keybindings

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-keybindings` makes the client's keyboard shortcuts the user's own: it binds a chord to the command palette and another to composer focus, reads both from the durable settings section, and applies a replacement the moment it is saved. The palette is the composer's existing `/` command menu — pressing the chord seeds that token and returns focus — so there is one command surface, not two, and a half-typed message is never replaced.

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

Mount `dsh-client-ui-keybindings` in any client that shows the composer — the shipped Web and Desktop bundles already do. The settings row appears under Settings → General.

### Bindings

| Action | Default chord | Effect |
|---|---|---|
| Open the command palette | `mod+k` | Focus the composer and seed `/` when it is empty, opening the command menu |
| Focus the composer | `mod+i` | Return the keyboard to the composer without touching its draft |

`mod` is the platform primary modifier: Command on macOS, Control everywhere else. A chord needs at least one modifier, and unsupported spellings are refused by the settings row rather than silently ignored. Clicking a shortcut and pressing the new combination captures it, so nobody types chord grammar by hand.

### Configuration

Both fields live in the `ui-keybindings` settings section and are projected to the browser, so a change applies to open tabs without a reload.

```ts
export interface Config {
  commandPalette: string
  focusComposer: string
}
```

| Field | Default | Meaning |
|---|---|---|
| `commandPalette` | `'mod+k'` | Chord opening the command palette |
| `focusComposer` | `'mod+i'` | Chord focusing the composer |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **One capture-phase listener.** The keymap installs a single `keydown` listener on the window, resolves the current bindings on each event, and consumes the event it handles, so a bound chord never reaches an editor or the browser.
- **The palette is the command menu.** The binding resolves the session the interface is showing, seeds `/` into an empty draft, and focuses the composer; the existing trigger pipeline opens the menu. This keeps command discovery, filtering, and dispatch in one place.
- **Live rebinding.** Bindings are read from browser-local stores that mirror the durable settings section, so saving a chord changes the keymap without a remount.
- **The active session comes from the view.** The composer to act on is the session retained by the main view, which is exactly what the interface displays; a deployment with no visible session binds nothing.

### Source map

| File | Role |
|---|---|
| [`src/keybindings-settings.ts`](src/keybindings-settings.ts) | Settings namespace, defaults, and the chord grammar (`parseChord`, `chordMatches`) |
| [`src/index.ts`](src/index.ts) | Host face: the volatile settings fields |
| [`src/client/index.ts`](src/client/index.ts) | Browser face: preference mirroring, the window keymap, and the Settings row registration |
| [`src/client/keymap.ts`](src/client/keymap.ts) | The listener itself, isolated from the DOM so it is driven directly by tests |
| `src/client/settings/KeybindingsRow.tsx` | The Settings row that captures a replacement chord |
| — | No runtime invariant companion is published; the keymap is a pure function of the current bindings, and the Settings row is covered by client tests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Command surface](../ui-commands/README.md) — the menu the palette opens.
- [Composer input contract](../ui-conversation/README.md) — the session-scoped input facade the bindings drive.
- [Settings runtime](../ui-settings/README.md) — the configuration form the chords are stored in.

-----

<a id="model-experience"></a>
## Model Experience

### Keybinding side effects

#### What the model sees

Only what the user then types. The keymap changes the composer's draft and focus inside the browser: it contributes no prompt section, message, tool, or schema, and it appends no session event. When the palette action seeds `/`, the model sees the resulting command only if the user submits it, exactly as if they had typed it.

#### Token effect

Zero from the keymap itself. A palette keystroke that ends in a submitted command costs whatever that command costs, and nothing more.

#### KV Cache effect

No effect. Focus and draft changes never reach a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits bound what the keymap can do today. They are current package constraints, not a task backlog.

- **Two actions, and no chord sequences** — the palette and composer focus are the only bindable actions, and a chord is one key with modifiers; multi-key sequences (`mod+k mod+s`) and per-panel bindings are not interpreted.
- **No conflict detection** — a chord may collide with a browser or operating-system shortcut; the listener can only consume events the page receives, and nothing warns about a collision.
- **The palette is not a global search** — it opens the command menu, so it lists commands and their argument hints rather than files, sessions, or settings.
- **Bindings are window-wide** — every binding applies to the whole application; a chord cannot be scoped to one panel or disabled while a text field has focus.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
