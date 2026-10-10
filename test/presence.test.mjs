import assert from 'node:assert/strict'
import { test } from 'node:test'

import { collectElsewhere, encodeEntry, KEY_PREFIX, sameSet, TTL_MS } from '../src/presence.js'

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

test('sameSet is order-insensitive and size-aware', () => {
  assert.ok(sameSet(new Set(['a', 'b']), new Set(['b', 'a'])))
  assert.ok(!sameSet(new Set(['a']), new Set(['a', 'b'])))
})
