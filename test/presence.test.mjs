import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  collectElsewhere,
  encodeEntry,
  formatHeldFor,
  KEY_PREFIX,
  MAX_BACKOFF_MS,
  mergeElsewhere,
  nextPollDelay,
  sameMap,
  TTL_MS,
  WINDOW_LABEL
} from '../src/presence.js'

const NOW = 1_000_000
const SELF = `${KEY_PREFIX}self`
const entry = (key, ids, ts = NOW) => [`${KEY_PREFIX}${key}`, encodeEntry(ids, ts)]

test('sessions open in other windows are reported, this window is not', () => {
  const open = collectElsewhere([[SELF, encodeEntry(['a'], NOW)], entry('w2', ['b', 'c'])], SELF, NOW)

  assert.deepEqual([...open].sort(), ['b', 'c'])
})

test('a stale heartbeat (crashed window) stops counting after the TTL', () => {
  const stale = entry('w2', ['b'], NOW - TTL_MS - 1)
  const fresh = entry('w3', ['c'], NOW - TTL_MS)

  assert.deepEqual([...collectElsewhere([stale, fresh], SELF, NOW)], ['c'])
})

test('garbage and foreign keys never throw or leak in', () => {
  const open = collectElsewhere(
    [
      [`${KEY_PREFIX}w2`, 'not json'],
      [`${KEY_PREFIX}w3`, '{"ids":"x","ts":1}'],
      ['other.key', encodeEntry(['z'], NOW)]
    ],
    SELF,
    NOW
  )

  assert.equal(open.size, 0)
})

test('another client names itself; the Desktop surface (this app) never dots a row', () => {
  const merged = mergeElsewhere(new Set(), [
    { session_id: 's1', surface: 'bighelp' },
    { session_id: 's2', surface: 'desktop' },
    { session_id: 's3', surface: 'Desktop' }
  ])

  assert.deepEqual([...merged], [['s1', 'bighelp']])
})

test('a named holder wins over a window peer on the same session; window-only rows keep the window label', () => {
  const merged = mergeElsewhere(new Set(['s1', 's2']), [{ session_id: 's1', surface: 'tui' }])

  assert.equal(merged.get('s1'), 'tui')
  assert.equal(merged.get('s2'), WINDOW_LABEL)
})

test('a malformed backend payload degrades to window-only', () => {
  assert.equal(mergeElsewhere(new Set(['a']), null).size, 1)
  assert.equal(mergeElsewhere(new Set(), [null, {}, { session_id: 's', surface: '' }]).size, 0)
})

test('sameMap compares labels, not just ids', () => {
  assert.ok(sameMap(new Map([['a', 'x']]), new Map([['a', 'x']])))
  assert.ok(!sameMap(new Map([['a', 'x']]), new Map([['a', 'y']])))
  assert.ok(!sameMap(new Map([['a', 'x']]), new Map()))
})

test('poll backoff grows with failures and is capped', () => {
  assert.ok(nextPollDelay(1) > nextPollDelay(0))
  assert.equal(nextPollDelay(50), MAX_BACKOFF_MS)
})

test('the holder label carries a coarse age, and none when the backend sent no age', () => {
  assert.equal(formatHeldFor(5), ' for <1 min')
  assert.equal(formatHeldFor(125), ' for 2 min')
  assert.equal(formatHeldFor(7300), ' for 2 h')
  assert.equal(formatHeldFor(undefined), '')
  assert.equal(formatHeldFor(-1), '')
  assert.equal(mergeElsewhere(new Set(), [{ session_id: 's1', surface: 'tui', age_s: 600 }]).get('s1'), 'tui for 10 min')
})
