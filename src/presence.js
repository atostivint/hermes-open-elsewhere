// Pure presence logic: no DOM, no SDK, so node can test it. build.mjs inlines
// this file into dist/plugin.js (the loader reads a single plugin.js).

export const KEY_PREFIX = 'hermes.plugin.open-elsewhere.win.'
// Hidden windows get their timers throttled to ~1/min, so the TTL is generous;
// a clean close removes the entry immediately and the TTL only covers crashes.
export const HEARTBEAT_MS = 5000
export const TTL_MS = 90000

export function encodeEntry(ids, now) {
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
export function collectElsewhere(entries, selfKey, now, ttl = TTL_MS) {
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

export function sameSet(a, b) {
  return a.size === b.size && [...a].every(id => b.has(id))
}
