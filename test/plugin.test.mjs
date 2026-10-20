// Wiring test: runs the BUILT desktop/plugin.js against a stub SDK/React, a fake
// localStorage and a fake ctx.rest, the way the runtime loader would (specifiers rewritten).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { encodeEntry, KEY_PREFIX } from '../src/presence.js'

const store = new Map()

globalThis.localStorage = {
  get length() {
    return store.size
  },
  getItem: key => store.get(key) ?? null,
  key: index => [...store.keys()][index] ?? null,
  removeItem: key => store.delete(key),
  setItem: (key, value) => store.set(key, value)
}

globalThis.window = new EventTarget()

globalThis.__stubs = {
  host: {
    state: {
      focusedStoredSessionId: {
        get: () => 'sess-1',
        subscribe: fn => {
          fn()

          return () => {}
        }
      }
    }
  },
  Codicon: 'Codicon',
  jsx: (type, props) => ({ type, props }),
  SESSION_ROW_AREAS: { leading: 'sessionRow.leading' },
  Tip: 'Tip',
  useSyncExternalStore: (subscribe, snapshot) => snapshot()
}

const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace('export default', 'globalThis.__plugin =')

new Function(
  'const { Codicon, host, jsx, SESSION_ROW_AREAS, Tip, useSyncExternalStore } = globalThis.__stubs;' + source
)()

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function load(rest) {
  const registered = []
  const disposers = []
  const intervals = []

  globalThis.__plugin.register({
    addEventListener: (target, type, fn) => target.addEventListener(type, fn),
    onDispose: fn => disposers.push(fn),
    register: contribution => registered.push(contribution),
    rest,
    setInterval: fn => intervals.push(fn)
  })

  // What the row slot would paint for a session: the lock's tooltip label, or null.
  const lockFor = id => registered[0].data.render({ sessionId: id }).type({ sessionId: id })
  const paints = id => lockFor(id)?.props.label ?? null

  return { disposers, intervals, lockFor, paints, registered }
}

test('a session open in a peer window is locked, one open only here is not; the entry is removed on dispose', async () => {
  const { disposers, paints, registered } = load(async () => ({ ok: true, holders: [] }))

  await settle()
  assert.equal(registered[0].area, 'sessionRow.leading')
  assert.equal([...store.keys()].filter(k => k.startsWith(KEY_PREFIX)).length, 1)

  store.set(`${KEY_PREFIX}peer`, encodeEntry(['sess-2'], Date.now()))
  window.dispatchEvent(new Event('storage'))

  assert.equal(paints('sess-2'), 'Open in another window: not available here')
  assert.equal(paints('sess-1'), null)
  assert.equal(paints('sess-3'), null)

  disposers.forEach(fn => fn())
  store.delete(`${KEY_PREFIX}peer`)
  assert.equal(store.size, 0, 'own entry removed on dispose')
})

test('a session another client holds (backend /holders) is locked with that client named', async () => {
  const calls = []

  const { disposers, lockFor, paints } = load(async (path, opts) => {
    calls.push([path, opts.timeoutMs])

    return {
      ok: true,
      holders: [
        { session_id: 'sess-9', surface: 'gateway:telegram', age_s: 3 },
        { session_id: 'sess-1', surface: 'desktop', age_s: 3 }
      ]
    }
  })

  await settle()

  assert.deepEqual(calls[0], ['/holders', 8000])
  assert.equal(paints('sess-9'), 'Open in Telegram for <1 min: not available here')
  assert.equal(paints('sess-1'), null, "the Desktop's own lease never locks a row")

  const { props } = lockFor('sess-9')
  const icon = props.children

  assert.equal(icon.props.role, 'img')
  assert.equal(icon.props['aria-label'], props.label)
  assert.deepEqual(icon.props.children, { type: 'Codicon', props: { name: 'lock', size: '0.75rem' } })

  disposers.forEach(fn => fn())
})

test('a server without the backend half keeps the window source working and backs off instead of polling every beat', async () => {
  let calls = 0

  const { disposers, intervals, paints } = load(async () => {
    calls += 1
    throw new Error('404')
  })

  await settle()
  assert.equal(calls, 1)

  intervals.forEach(beat => beat())
  await settle()
  assert.equal(calls, 1, 'the next heartbeat is inside the backoff window')

  store.set(`${KEY_PREFIX}peer`, encodeEntry(['sess-2'], Date.now()))
  window.dispatchEvent(new Event('storage'))
  assert.equal(paints('sess-2'), 'Open in another window: not available here')

  disposers.forEach(fn => fn())
  store.clear()
})
