/**
 * open-elsewhere — dots a sidebar session row when that conversation is held
 * elsewhere: in another Hermes Desktop window, or by another client (iPhone app,
 * terminal, messaging gateway) that owns the session lease. Desktop-only by
 * construction: a renderer plugin decorating `sessionRow.leading`.
 *
 * Two sources, merged into one id -> label map:
 *  - other windows: each window publishes its focused stored session to
 *    localStorage (shared across same-origin windows, `storage` event elsewhere);
 *  - other clients: the backend half (`dashboard/plugin_api.py`, GET /holders)
 *    reads the active-session registry behind SESSION_NOT_OWNED. Without it on the
 *    server the poll backs off and only the window source is live.
 *
 * Edit this file, then `node scripts/build.mjs`: presence.js is inlined to give
 * the single plugin.js the runtime loader accepts.
 */

import { host, SESSION_ROW_AREAS, Tip } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useSyncExternalStore } from 'react'

const DOT_COLOR = '#f59e0b'

function createPresence() {
  const selfKey = `${KEY_PREFIX}${Math.random().toString(36).slice(2)}`
  const listeners = new Set()
  let windowIds = new Set()
  let holders = []
  let elsewhere = new Map()

  const read = () => {
    const entries = []

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)

      if (key?.startsWith(KEY_PREFIX)) {
        entries.push([key, localStorage.getItem(key)])
      }
    }

    return entries
  }

  const rebuild = () => {
    const next = mergeElsewhere(windowIds, holders)

    // Keep the snapshot identity on no-ops: useSyncExternalStore re-renders
    // every row on a new reference.
    if (!sameMap(next, elsewhere)) {
      elsewhere = next
      listeners.forEach(notify => notify())
    }
  }

  return {
    publish() {
      const id = host.state.focusedStoredSessionId.get()

      localStorage.setItem(selfKey, encodeEntry(id ? [id] : [], Date.now()))
    },
    retire() {
      localStorage.removeItem(selfKey)
    },
    refreshWindows() {
      windowIds = collectElsewhere(read(), selfKey, Date.now())
      rebuild()
    },
    setHolders(next) {
      holders = next
      rebuild()
    },
    snapshot: () => elsewhere,
    subscribe(notify) {
      listeners.add(notify)

      return () => listeners.delete(notify)
    }
  }
}

export default {
  id: 'open-elsewhere',
  name: 'Open elsewhere',
  description: 'Marks a session in the sidebar when it is also open in another window or client.',
  register(ctx) {
    const presence = createPresence()
    let disposed = false
    let polling = false
    let failures = 0
    let nextPollAt = 0

    function ElsewhereDot({ sessionId }) {
      const open = useSyncExternalStore(presence.subscribe, presence.snapshot)
      const holder = open.get(sessionId)

      if (!holder) {
        return null
      }

      const label = `Also open in ${holder}`

      return jsx(Tip, {
        label,
        children: jsx('span', {
          'aria-label': label,
          role: 'img',
          style: {
            backgroundColor: DOT_COLOR,
            borderRadius: '9999px',
            display: 'inline-block',
            flex: 'none',
            height: '0.375rem',
            marginInline: '0.25rem',
            width: '0.375rem'
          }
        })
      })
    }

    async function pollHolders() {
      if (polling || Date.now() < nextPollAt) {
        return
      }

      polling = true

      try {
        const reply = await ctx.rest('/holders', { timeoutMs: 8000 })

        if (!disposed) {
          presence.setHolders(reply?.ok ? reply.holders : [])
        }

        failures = 0
      } catch {
        // A decoration never surfaces an error: no backend half, or the server is away.
        failures += 1

        if (!disposed) {
          presence.setHolders([])
        }
      } finally {
        polling = false
        nextPollAt = Date.now() + nextPollDelay(failures)
      }
    }

    const sync = () => {
      presence.publish()
      presence.refreshWindows()
      void pollHolders()
    }

    ctx.register({
      id: 'dot',
      area: SESSION_ROW_AREAS.leading,
      data: { render: ({ sessionId }) => jsx(ElsewhereDot, { sessionId }) }
    })

    ctx.onDispose(host.state.focusedStoredSessionId.subscribe(sync))
    ctx.addEventListener(window, 'storage', () => presence.refreshWindows())
    ctx.addEventListener(window, 'pagehide', () => presence.retire())
    ctx.setInterval(sync, HEARTBEAT_MS)
    ctx.onDispose(() => {
      disposed = true
      presence.retire()
    })
  }
}

// ── inlined from src/presence.js ──
// Pure presence logic: no DOM, no SDK, so node can test it. build.mjs inlines
// this file into desktop/plugin.js (the loader reads a single plugin.js).

const KEY_PREFIX = 'hermes.plugin.open-elsewhere.win.'
// Hidden windows get their timers throttled to ~1/min, so the TTL is generous;
// a clean close removes the entry immediately and the TTL only covers crashes.
const HEARTBEAT_MS = 5000
const TTL_MS = 90000
const MAX_BACKOFF_MS = 60000
// The Desktop's own leases carry this surface: every session open HERE is held by it, so
// counting it would dot every row. Other Desktop windows are covered by window presence.
const OWN_SURFACE = 'desktop'
const WINDOW_LABEL = 'another window'

function encodeEntry(ids, now) {
  return JSON.stringify({ ids: ids.filter(Boolean), ts: now })
}

function decodeEntry(raw) {
  try {
    const value = JSON.parse(raw)

    return Array.isArray(value?.ids) && Number.isFinite(value.ts) ? value : null
  } catch {
    return null
  }
}

/** Session ids open in windows OTHER than `selfKey`. `entries` is `[key, raw]`
 *  pairs from storage; foreign keys, garbage and expired heartbeats are skipped. */
function collectElsewhere(entries, selfKey, now, ttl = TTL_MS) {
  const open = new Set()

  for (const [key, raw] of entries) {
    if (key === selfKey || !key.startsWith(KEY_PREFIX)) {
      continue
    }

    const entry = decodeEntry(raw)

    if (!entry || now - entry.ts > ttl) {
      continue
    }

    for (const id of entry.ids) {
      if (typeof id === 'string' && id) {
        open.add(id)
      }
    }
  }

  return open
}

/** session id -> who holds it. A backend holder (named surface) wins over a window peer. */
function mergeElsewhere(windowIds, holders) {
  const merged = new Map([...windowIds].map(id => [id, WINDOW_LABEL]))

  for (const holder of Array.isArray(holders) ? holders : []) {
    const id = holder?.session_id
    const surface = typeof holder?.surface === 'string' ? holder.surface.trim() : ''

    if (typeof id === 'string' && id && surface && surface.toLowerCase() !== OWN_SURFACE) {
      merged.set(id, surface)
    }
  }

  return merged
}

function sameMap(a, b) {
  return a.size === b.size && [...a].every(([id, label]) => b.get(id) === label)
}

/** Delay before the next backend poll: the heartbeat while it answers, doubling per
 *  consecutive failure (a server without the backend half 404s forever) up to a minute. */
function nextPollDelay(failures) {
  return Math.min(MAX_BACKOFF_MS, HEARTBEAT_MS * 2 ** Math.max(0, failures))
}
