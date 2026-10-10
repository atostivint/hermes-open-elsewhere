/**
 * open-elsewhere — dots a sidebar session row when that conversation is open in
 * another Hermes Desktop window. Desktop-only by construction: it is a renderer
 * plugin that decorates `sessionRow.leading`.
 *
 * Windows are separate renderers, so each one publishes the stored session it
 * has focused to localStorage (shared across same-origin windows, with a
 * `storage` event on every other window) and reads everyone else's.
 *
 * Edit this file, then `node scripts/build.mjs`: presence.js is inlined to give
 * the single plugin.js the runtime loader accepts.
 */

import { host, SESSION_ROW_AREAS, Tip } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useSyncExternalStore } from 'react'
import { collectElsewhere, encodeEntry, HEARTBEAT_MS, KEY_PREFIX, sameSet } from './presence.js'

const DOT_COLOR = '#f59e0b'

function createPresence() {
  const selfKey = `${KEY_PREFIX}${Math.random().toString(36).slice(2)}`
  const listeners = new Set()
  let elsewhere = new Set()

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

  return {
    publish() {
      const id = host.state.focusedStoredSessionId.get()

      localStorage.setItem(selfKey, encodeEntry(id ? [id] : [], Date.now()))
    },
    retire() {
      localStorage.removeItem(selfKey)
    },
    refresh() {
      const next = collectElsewhere(read(), selfKey, Date.now())

      // Keep the snapshot identity on no-ops: useSyncExternalStore re-renders
      // every row on a new reference.
      if (!sameSet(next, elsewhere)) {
        elsewhere = next
        listeners.forEach(notify => notify())
      }
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
  description: 'Marks a session in the sidebar when it is also open in another Hermes window.',
  register(ctx) {
    const presence = createPresence()

    function ElsewhereDot({ sessionId }) {
      const open = useSyncExternalStore(presence.subscribe, presence.snapshot)

      if (!open.has(sessionId)) {
        return null
      }

      return jsx(Tip, {
        label: 'Also open in another window',
        children: jsx('span', {
          'aria-label': 'Also open in another window',
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

    const sync = () => {
      presence.publish()
      presence.refresh()
    }

    ctx.register({
      id: 'dot',
      area: SESSION_ROW_AREAS.leading,
      data: { render: ({ sessionId }) => jsx(ElsewhereDot, { sessionId }) }
    })

    ctx.onDispose(host.state.focusedStoredSessionId.subscribe(sync))
    ctx.addEventListener(window, 'storage', () => presence.refresh())
    ctx.addEventListener(window, 'pagehide', () => presence.retire())
    ctx.setInterval(sync, HEARTBEAT_MS)
    ctx.onDispose(() => presence.retire())
  }
}
