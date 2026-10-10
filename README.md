# hermes-open-elsewhere

MVP Hermes **Desktop** plugin: an amber dot in the sidebar session list when that
conversation is also open in **another Hermes Desktop window**.

Desktop-only by construction: it is a renderer plugin loaded from
`$HERMES_HOME/desktop-plugins/<name>/plugin.js`, decorating the
`sessionRow.leading` slot (`SESSION_ROW_AREAS.leading` in the SDK). No backend or
core change.

## How it works

Each window is a separate renderer. Every window writes the stored session it has
focused to `localStorage` under `hermes.plugin.open-elsewhere.win.<random>`
(heartbeat every 5 s, removed on close/disable) and listens to `storage` events
for the others. A row is dotted when its id appears in a *different* window's
entry that is fresher than the 90 s TTL (the TTL only matters after a crash).

## Use

```
node scripts/build.mjs       # src/ -> dist/plugin.js (inlines presence.js)
node scripts/install.mjs     # copy to <hermes home>/desktop-plugins/open-elsewhere/
                             # (Windows: %LOCALAPPDATA%\hermes, else ~/.hermes)
node --test test/plugin.test.mjs test/presence.test.mjs
```

The plugin shows up in Capabilities ▸ Plugins; the file is fs-watched, so
re-installing hot-reloads it.

## Not verified yet (needs a real Desktop with two windows)

- That `localStorage` + `storage` events really reach the other BrowserWindow
  (expected: same origin/partition) and that secondary windows load disk plugins.
- Compression: the row slot receives the lineage-root id, while
  `focusedStoredSessionId` can be the live id after an auto-compression, so the
  dot may not match until the session is reopened. The SDK does not expose
  `$sessions`, so a fix needs either a lineage lookup in the SDK or publishing
  both ids.

## Not in the MVP

- Only the *focused* session of each window is published, not every tile.
- Other clients (TUI, CLI, gateway, another machine): needs a presence field from
  the backend (`tui_gateway` already tracks a session lease but the sessions list
  does not expose it).
- No setting for the colour, no i18n (English tooltip).
