/**
 * Ported from `tokeneconomizer/microskills/lifecycle.py` behavior
 * (Apache-2.0, microsoft/TokenEconomizer @ e428fc9); the upstream test suite
 * exercises the state machine through the env-facts families, so these tests
 * pin the constants and transitions directly.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FIRE_GATE,
  FIRE_MIN_N,
  GAMMA,
  HARD_KILL,
  K_PROMOTE,
  LAMBDA,
  Lifecycle,
  SCORE_FLOOR,
} from '../../../lib/microskills/lifecycle.js'

/** @returns {Lifecycle} */
function fresh() {
  return new Lifecycle('fact:test', false)
}

/**
 * @param {Lifecycle} life
 * @param {number} count
 * @param {number} now
 * @param {boolean} [fired]
 */
function confirmTimes(life, count, now, fired = true) {
  for (let index = 0; index < count; index += 1) {
    // No edited files: every confirmation counts even with drift=true.
    life.update(now + index, 'confirm', fired, true, new Set())
  }
}

test('constants are upstream values verbatim (lifecycle.py:14-21)', () => {
  assert.equal(K_PROMOTE, 3)
  assert.equal(GAMMA, 0.8)
  assert.equal(LAMBDA, 5)
  assert.equal(SCORE_FLOOR, 0)
  assert.equal(HARD_KILL, true)
  assert.equal(FIRE_GATE, 0.4)
  assert.equal(FIRE_MIN_N, 4)
})

test('promotion needs K_PROMOTE drift-free confirmations', () => {
  const life = fresh()
  life.update(0, 'confirm', true, true, new Set())
  life.update(1, 'confirm', true, true, new Set())
  assert.equal(life.state, 'CANDIDATE')
  life.update(2, 'confirm', true, true, new Set())
  assert.equal(life.state, 'ACTIVE')
  assert.equal(life.promotedAt, 2)
})

test('drift=true counts only confirmations on disjoint edited-file sets', () => {
  const drifting = new Lifecycle('fact:drift', false, true)
  const fileSets = ['a.py', 'a.py', 'b.py', 'b.py']
  fileSets.forEach((file, index) => drifting.update(index, 'confirm', true, true, new Set([file])))
  // Only one confirmation per disjoint file set.
  assert.equal(drifting.driftedConfirms(), 2)
  assert.equal(drifting.state, 'CANDIDATE')
  drifting.update(4, 'confirm', true, true, new Set(['c.py']))
  assert.equal(drifting.state, 'ACTIVE')

  const noFiles = new Lifecycle('fact:files', false, true)
  for (let index = 0; index < 3; index += 1) noFiles.update(index, 'confirm', true, true, new Set())
  assert.equal(noFiles.state, 'ACTIVE')

  // Environment facts pass drift=false: the same file every session still promotes.
  const environment = new Lifecycle('fact:env', false, false)
  for (let index = 0; index < 3; index += 1) environment.update(index, 'confirm', true, true, new Set(['same.py']))
  assert.equal(environment.state, 'ACTIVE')
})

test('driftedConfirms ignores later confirmations that overlap a kept one', () => {
  const life = new Lifecycle('fact:overlap', false, true)
  life.update(0, 'confirm', true, true, new Set(['a.py']))
  life.update(1, 'confirm', true, true, new Set(['a.py', 'b.py'])) // overlaps a.py, dropped
  life.update(2, 'confirm', true, true, new Set(['b.py'])) // disjoint from kept a.py, kept
  assert.equal(life.driftedConfirms(), 2)
})

test('firing gate: ACTIVE, FIRE_MIN_N exercised tasks, FIRE_GATE firing rate', () => {
  const life = fresh()
  confirmTimes(life, 3, 0, false) // exercised but never fired
  assert.equal(life.state, 'ACTIVE')
  assert.equal(life.fireNum, 0)
  assert.equal(life.fireDen, 3)
  assert.equal(life.injectable(), false) // FIRE_MIN_N=4 not reached
  life.update(3, null, false, true, new Set())
  assert.equal(life.fireDen, 4)
  assert.equal(life.firingRate(), 0)
  assert.equal(life.injectable(), false) // clears the sample floor, not the rate gate

  const hot = fresh()
  confirmTimes(hot, 3, 0, true) // every confirmation also fired
  assert.equal(hot.injectable(), false) // 3/3 exercised, still FIRE_MIN_N short
  hot.update(3, null, true, true, new Set())
  assert.equal(hot.fireNum, 4)
  assert.equal(hot.fireDen, 4)
  assert.equal(hot.firingRate(), 1)
  assert.equal(hot.injectable(), true)

  const half = fresh()
  confirmTimes(half, 3, 0, true)
  half.update(3, null, false, true, new Set()) // 3 of 4 fired
  assert.ok(Math.abs(half.firingRate() - 0.75) < 1e-12)
  assert.equal(half.injectable(), true)
})

test('low-stakes ACTIVE retires when the recency score drops below the floor', () => {
  const life = fresh()
  confirmTimes(life, 4, 0, false)
  assert.equal(life.state, 'ACTIVE')
  assert.ok(life.score(4) > SCORE_FLOOR)
  // One contradiction at task 5 costs LAMBDA; the decayed confirmations no longer cover it.
  life.update(5, 'contradict', false, true, new Set())
  assert.ok(life.score(5) < SCORE_FLOOR)
  assert.equal(life.state, 'RETIRED')
  assert.equal(life.retiredAt, 5)
})

test('high-stakes ACTIVE hard-kills on one clean contradiction', () => {
  const life = new Lifecycle('fact:high', true)
  confirmTimes(life, 3, 0, false)
  life.update(3, 'contradict', false, true, new Set())
  assert.equal(life.state, 'RETIRED')
})

test('a contradicting CANDIDATE is not retired by the shared machine', () => {
  const life = fresh()
  life.update(0, 'confirm', true, true, new Set())
  life.update(1, 'contradict', false, true, new Set())
  assert.equal(life.state, 'CANDIDATE')
  assert.deepEqual(life.contradicts, [1])
})

test('score is recency-weighted: GAMMA per task, LAMBDA per contradiction', () => {
  const life = fresh()
  life.update(0, 'confirm', true, true, new Set())
  life.update(2, 'confirm', true, true, new Set())
  life.update(2, 'contradict', false, true, new Set())
  const expected = GAMMA ** 2 + GAMMA ** 0 - LAMBDA * GAMMA ** 0
  assert.ok(Math.abs(life.score(2) - expected) < 1e-12)
  assert.ok(Math.abs(life.firingRate() - 2 / 3) < 1e-12)
})

test('toJSON/fromJSON round-trip keeps the upstream document shape', () => {
  const life = new Lifecycle('fact:round', true, true)
  life.update(0, 'confirm', true, true, new Set(['b.py', 'a.py']))
  life.update(1, 'confirm', false, true, new Set())
  life.update(2, 'contradict', false, true, new Set(['c.py']))
  const doc = life.toJSON()
  assert.deepEqual(Object.keys(doc).sort(), [
    'confirms', 'contradicts', 'drift', 'fire_den', 'fire_num', 'high', 'key',
    'promoted_at', 'retired_at', 'state',
  ])
  assert.deepEqual(doc.confirms[0], [0, ['a.py', 'b.py']])
  const restored = Lifecycle.fromJSON(JSON.parse(JSON.stringify(doc)))
  assert.deepEqual(restored.toJSON(), doc)
  assert.equal(restored.state, life.state)
  assert.equal(restored.drift, true)
})

test('fromJSON rejects documents that are not lifecycle-shaped', () => {
  assert.throws(() => Lifecycle.fromJSON(null), TypeError)
  assert.throws(() => Lifecycle.fromJSON({}), TypeError)
  assert.throws(() => Lifecycle.fromJSON({ key: 'x' }), TypeError)
  // Partial but keyed documents load with defaults for the rest.
  const partial = Lifecycle.fromJSON({ key: 'x', high: false })
  assert.equal(partial.state, 'CANDIDATE')
  assert.equal(partial.fireDen, 0)
})
