// Pure presence logic: no DOM, no SDK, so node can test it. build.mjs inlines
// this file into desktop/plugin.js (the loader reads a single plugin.js).

export const KEY_PREFIX = 'hermes.plugin.open-elsewhere.win.'
// Hidden windows get their timers throttled to ~1/min, so the TTL is generous;
// a clean close removes the entry immediately and the TTL only covers crashes.
export const HEARTBEAT_MS = 5000
export const TTL_MS = 90000
export const MAX_BACKOFF_MS = 60000
// The Desktop's own leases carry this surface: every session open HERE is held by it, so
// counting it would dot every row. Other Desktop windows are covered by window presence.
export const OWN_SURFACE = 'desktop'
export const WINDOW_LABEL = 'another window'

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
export function holderLabel(surface) {
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

/** " for 5 min" for a holder's lease age in seconds; empty when unknown. Coarse on purpose:
 *  the label is part of the merged map, and every change re-renders every row. */
export function formatHeldFor(ageSeconds) {
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
export function mergeElsewhere(windowIds, holders) {
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

export function sameMap(a, b) {
  return a.size === b.size && [...a].every(([id, label]) => b.get(id) === label)
}

/** Delay before the next backend poll: the heartbeat while it answers, doubling per
 *  consecutive failure (a server without the backend half 404s forever) up to a minute. */
export function nextPollDelay(failures) {
  return Math.min(MAX_BACKOFF_MS, HEARTBEAT_MS * 2 ** Math.max(0, failures))
}
