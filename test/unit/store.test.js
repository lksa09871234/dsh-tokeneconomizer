import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { JsonStore } from '../../lib/store.js'

/** @returns {string} */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'te-store-'))
}

test('writeJson/readJson round-trips a versioned document', () => {
  const store = new JsonStore(tempDir())
  assert.equal(store.writeJson('facts.json', { facts: [{ id: 'f1' }] }), true)
  assert.deepEqual(store.readJson('facts.json', { facts: [] }), { facts: [{ id: 'f1' }] })
})

test('readJson returns the fallback for a missing file without recording corruption', () => {
  const store = new JsonStore(tempDir())
  assert.deepEqual(store.readJson('absent.json', { ok: true }), { ok: true })
  assert.deepEqual(store.corruptions, [])
})

test('a corrupt document is quarantined and replaced by the fallback', () => {
  const dir = tempDir()
  const store = new JsonStore(dir)
  fs.writeFileSync(path.join(dir, 'facts.json'), '{not json', 'utf8')
  assert.deepEqual(store.readJson('facts.json', { facts: [] }), { facts: [] })
  assert.equal(store.corruptions.length, 1)
  const quarantined = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'))
  assert.equal(quarantined.length, 1)
})

test('a wrong-shape document is rejected by the validator', () => {
  const store = new JsonStore(tempDir())
  store.writeJson('facts.json', { facts: 'nope' })
  const value = store.readJson('facts.json', { facts: [] }, (v) => Boolean(v && typeof v === 'object' && Array.isArray(/** @type {any} */ (v).facts)))
  assert.deepEqual(value, { facts: [] })
  assert.equal(store.corruptions.length, 1)
})

test('updateJson applies the mutation under the lock and persists it', () => {
  const store = new JsonStore(tempDir())
  store.writeJson('counter.json', { n: 1 })
  const result = store.updateJson('counter.json', { n: 0 }, (current) => ({ n: current.n + 1 }))
  assert.equal(result.ok, true)
  assert.equal(result.value.n, 2)
  assert.equal(store.readJson('counter.json', { n: 0 }).n, 2)
})

test('withLock releases the lock file on success and on throw', () => {
  const dir = tempDir()
  const store = new JsonStore(dir)
  assert.equal(store.withLock('blob', () => 42), 42)
  assert.equal(fs.existsSync(path.join(dir, 'blob.lock')), false)
  assert.throws(() => store.withLock('blob', () => { throw new Error('boom') }), /boom/)
  assert.equal(fs.existsSync(path.join(dir, 'blob.lock')), false)
})

test('a stale lock is recovered after the timeout window', () => {
  const dir = tempDir()
  const store = new JsonStore(dir, { lockStaleMs: 20, lockTimeoutMs: 1000 })
  const lock = path.join(dir, 'blob.lock')
  fs.writeFileSync(lock, 'other-process', 'utf8')
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(lock, old, old)
  assert.equal(store.withLock('blob', () => 'recovered'), 'recovered')
})

test('appendJsonl/readJsonl return records in order and survive a torn line', () => {
  const dir = tempDir()
  const store = new JsonStore(dir)
  assert.equal(store.appendJsonl('usage.jsonl', { turn: 1 }), true)
  assert.equal(store.appendJsonl('usage.jsonl', { turn: 2 }), true)
  fs.appendFileSync(path.join(dir, 'usage.jsonl'), '{"torn":', 'utf8')
  assert.deepEqual(store.readJsonl('usage.jsonl').map((record) => record.turn), [1, 2])
})

test('appendJsonl rotates a stream that exceeds its byte budget', () => {
  const dir = tempDir()
  const store = new JsonStore(dir, { maxJsonlBytes: 120 })
  for (let i = 0; i < 8; i += 1) store.appendJsonl('usage.jsonl', { i, pad: 'x'.repeat(30) })
  assert.equal(fs.existsSync(path.join(dir, 'usage.jsonl.1')), true)
  const records = store.readJsonl('usage.jsonl')
  assert.ok(records.length >= 1)
  assert.equal(records.at(-1)?.i, 7)
})

test('errors never escape the store: an unwritable directory returns false/fallback', () => {
  const store = new JsonStore(path.join(tempDir(), 'dir-that-is-a-file', 'nested'))
  const dirWithFile = tempDir()
  fs.writeFileSync(path.join(dirWithFile, 'blocked'), 'x')
  const blocked = new JsonStore(path.join(dirWithFile, 'blocked', 'nested'))
  assert.equal(blocked.writeJson('a.json', { a: 1 }), false)
  assert.deepEqual(blocked.readJson('a.json', { a: 0 }), { a: 0 })
  // A missing directory is not an error for reads.
  assert.deepEqual(store.readJson('a.json', { a: 0 }), { a: 0 })
})
