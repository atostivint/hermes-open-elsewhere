# hermes-open-elsewhere

Hermes **Desktop** plugin that puts an amber lock on a sidebar session row when that conversation is held
**elsewhere**: in another Desktop window, or by another client (iPhone app, terminal,
messaging gateway). It exists because sending into such a session is refused with
`SESSION_NOT_OWNED` ("This chat is open somewhere else"), with no warning beforehand.

Two halves, one package (same layout as other unified Hermes plugins):

| Half | Where it runs | What it does |
|---|---|---|
| `desktop/plugin.js` | Hermes Desktop (renderer) | Decorates `sessionRow.leading` with an amber lock; tooltip names the holder and how long it has had the session ("Open in bighelp for 5 min: not available here"). |
| `dashboard/plugin_api.py` | The Hermes backend you connect to | Read-only `GET /api/plugins/open-elsewhere/holders`, built on `active_session_registry_snapshot()` (the registry the refusal message comes from). Returns only session id, surface name and age. |

Sources merged on the Desktop (a named client wins over "another window"):

- **Other windows of this Desktop**: each window publishes its focused stored session to
  `localStorage` (heartbeat 5 s, removed on close) and reads the others' (`storage` event).
- **Other clients**: polls `/holders` every 5 s. Without the backend half on the server the
  poll backs off (to 60 s) and only the window source is live. The Desktop's own `desktop`
  surface is ignored (every session open here is held by it).
- The tooltip says "another window" for same-machine windows: windows have no name, so which one is not identified.

## Install

Desktop half (this machine; hot-reloads, the file is watched):

```
node scripts/build.mjs       # src/ -> desktop/plugin.js (inlines presence.js)
node scripts/install.mjs     # -> <hermes home>/desktop-plugins/open-elsewhere/
                             # (Windows: %LOCALAPPDATA%\hermes, else ~/.hermes)
```

Backend half (on the machine running the backend your Desktop connects to, e.g. over SSH):

```
hermes plugins install "file://$PWD" --enable     # from a committed checkout, or copy this
                                                  # folder to <hermes home>/plugins/open-elsewhere
hermes plugins enable open-elsewhere              # user plugins must be in plugins.enabled
# then restart that backend (hermes serve / dashboard)
```

## Tests

```
node --test test/plugin.test.mjs test/presence.test.mjs                     # Desktop half
python -m unittest discover -s test -p "test_*.py"                           # backend unit
HERMES_AGENT_SRC=<hermes-agent checkout> <hermes venv python> -m unittest discover -s test -p "test_*.py"
                                                                             # real registry + FastAPI, temp HERMES_HOME
```

## Known limits

- The row slot passes the lineage-root session id; the registry holds the id the owner is on.
  After an auto-compression the two can differ, so a lock may be missing until the session is
  reopened. The Desktop plugin SDK does not expose the session list to resolve lineage.
- Another *Desktop* on a different machine shares the `desktop` surface and is not detected
  (same-machine windows are, via `localStorage`).
- Only the focused session of each window is published, not every tile.
- Not verified in the running app: that the dashboard mount gates accept the backend half on
  your server version (tested against the installed checkout's registry and a plain FastAPI
  router, not through `hermes serve`), and that `localStorage` events reach a second window.
- **Taking over a held session is not implemented.** The registry enforces one live owner per
  session and has no force/transfer API for another client's lease; deleting it from outside
  would leave two writers on one session. A cooperative release between this Desktop's windows
  is possible in principle but not built; for other clients it needs a change in Hermes itself.
- English-only tooltip; fixed colour.
