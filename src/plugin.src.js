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
import { collectElsewhere, encodeEntry, HEARTBEAT_MS, KEY_PREFIX, mergeElsewhere, nextPollDelay, sameMap } from './presence.js'

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
