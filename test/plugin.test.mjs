// Wiring test: runs the BUILT plugin.js against a stub SDK/React and a fake
// localStorage, the way the runtime loader would (specifiers rewritten).
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

let focused = 'sess-1'
const focusListeners = new Set()

globalThis.window = new EventTarget()

globalThis.__stubs = {
  host: {
    state: {
      focusedStoredSessionId: {
        get: () => focused,
        subscribe: fn => {
          focusListeners.add(fn)
          fn()

          return () => focusListeners.delete(fn)
        }
      }
    }
  },
  jsx: (type, props) => ({ type, props }),
  SESSION_ROW_AREAS: { leading: 'sessionRow.leading' },
  Tip: 'Tip',
  useSyncExternalStore: (subscribe, snapshot) => snapshot()
}

const source = readFileSync(new URL('../dist/plugin.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace('export default', 'globalThis.__plugin =')

new Function(
  'const { host, jsx, SESSION_ROW_AREAS, Tip, useSyncExternalStore } = globalThis.__stubs;' + source
)()

function load() {
  const registered = []
  const disposers = []
  const intervals = []

  globalThis.__plugin.register({
    addEventListener: (target, type, fn) => target.addEventListener(type, fn),
    onDispose: fn => disposers.push(fn),
    register: contribution => registered.push(contribution),
    setInterval: fn => intervals.push(fn)
  })

  return { disposers, registered }
}

const dotFor = (registered, sessionId) => registered[0].data.render({ sessionId })

test('publishes this window under its own key and dots rows open in a peer window', () => {
  const { disposers, registered } = load()

  assert.equal(registered[0].area, 'sessionRow.leading')
  assert.equal([...store.keys()].filter(k => k.startsWith(KEY_PREFIX)).length, 1)

  store.set(`${KEY_PREFIX}peer`, encodeEntry(['sess-2'], Date.now()))
  window.dispatchEvent(new Event('storage'))

  // ElsewhereDot is a component: call it to see what it would paint.
  const paints = id => registered[0].data.render({ sessionId: id }).type({ sessionId: id })

  assert.ok(paints('sess-2'), 'peer-open session gets a dot')
  assert.equal(paints('sess-1'), null, 'a session only open here gets none')
  assert.equal(paints('sess-3'), null)

  disposers.forEach(fn => fn())
  assert.equal([...store.keys()].filter(k => k !== `${KEY_PREFIX}peer`).length, 0, 'own entry removed on dispose')
})
