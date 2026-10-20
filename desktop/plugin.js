/**
 * open-elsewhere — puts a lock on a sidebar session row when that conversation is held
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

import { Codicon, host, SESSION_ROW_AREAS, Tip } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useSyncExternalStore } from 'react'

// The app's amber (StatusDot's warn tone is bg-amber-500). Tailwind only emits utilities the
// app itself uses, so read its theme variable rather than rely on a class; hex if it is absent.
const LOCK_COLOR = 'var(--color-amber-500, #f59e0b)'

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

    function ElsewhereLock({ sessionId }) {
      const open = useSyncExternalStore(presence.subscribe, presence.snapshot)
      const holder = open.get(sessionId)

      if (!holder) {
        return null
      }

      const label = `Open in ${holder}: not available here`

      return jsx(Tip, {
        label,
        // Codicon is aria-hidden, so the wrapper carries the accessible name.
        children: jsx('span', {
          'aria-label': label,
          role: 'img',
          style: { color: LOCK_COLOR, display: 'inline-flex', flex: 'none', marginInline: '0.25rem' },
          children: jsx(Codicon, { name: 'lock', size: '0.75rem' })
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
      id: 'lock',
      area: SESSION_ROW_AREAS.leading,
      data: { render: ({ sessionId }) => jsx(ElsewhereLock, { sessionId }) }
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

// Lease surfaces are raw strings: `gateway:<platform>` (gateway/run_busy.py), `cli`, `tui`,
// `desktop`, and whatever a plugin session is tagged with. Platform names that a plain
// capitalised first letter would get wrong.
const PLATFORM_NAMES = {
  bluebubbles: 'iMessage',
  dingtalk: 'DingTalk',
  imessage: 'iMessage',
  qqbot: 'QQ',
  sms: 'SMS',
  wecom: 'WeCom',
  wecom_callback: 'WeCom',
  weixin: 'WeChat',
  whatsapp: 'WhatsApp',
  whatsapp_cloud: 'WhatsApp'
}

const PLAIN_PLATFORMS = new Set(['discord', 'email', 'matrix', 'mattermost', 'signal', 'slack', 'telegram'])
const capitalise = text => text.charAt(0).toUpperCase() + text.slice(1)
const platformName = key => PLATFORM_NAMES[key] ?? capitalise(key.replace(/_/g, ' '))

/** Human label for a lease `surface`: "Telegram", "a terminal", "the messaging gateway".
 *  Unknown surfaces come back trimmed but otherwise as sent. */
function holderLabel(surface) {
  const raw = typeof surface === 'string' ? surface.trim() : ''
  const key = raw.toLowerCase()

  if (key === 'cli' || key === 'tui') {
    return 'a terminal'
  }

  if (key === 'gateway') {
    return 'the messaging gateway'
  }

  if (key === 'acp') {
    return 'an editor'
  }

  if (key.startsWith('gateway:')) {
    const platform = key.slice('gateway:'.length).trim()

    return platform ? platformName(platform) : 'the messaging gateway'
  }

  // A plugin session tagged with a bare platform name ("telegram") reads the same way.
  return key in PLATFORM_NAMES || PLAIN_PLATFORMS.has(key) ? platformName(key) : raw
}

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

/** " for 5 min" for a holder's lease age in seconds; empty when unknown. Coarse on purpose:
 *  the label is part of the merged map, and every change re-renders every row. */
function formatHeldFor(ageSeconds) {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) {
    return ''
  }

  const minutes = Math.floor(ageSeconds / 60)

  if (minutes < 1) {
    return ' for <1 min'
  }

  return minutes < 60 ? ` for ${minutes} min` : ` for ${Math.floor(minutes / 60)} h`
}

/** session id -> who holds it. A backend holder (named surface) wins over a window peer. */
function mergeElsewhere(windowIds, holders) {
  const merged = new Map([...windowIds].map(id => [id, WINDOW_LABEL]))

  for (const holder of Array.isArray(holders) ? holders : []) {
    const id = holder?.session_id
    const surface = typeof holder?.surface === 'string' ? holder.surface.trim() : ''

    if (typeof id === 'string' && id && surface && surface.toLowerCase() !== OWN_SURFACE) {
      merged.set(id, holderLabel(surface) + formatHeldFor(holder.age_s))
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
