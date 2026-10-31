import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_RETAINED_CALLS, SessionAccumulator } from '../../../lib/dsh/session-accumulator.js'

/**
 * @param {SessionAccumulator} acc
 * @param {string} type
 * @param {any} data
 */
function emit(acc, type, data) {
  acc.onEvent({ type, data, time: Date.now(), seq: 2 })
}

/**
 * @param {SessionAccumulator} acc
 * @param {string} callId
 * @param {string} name
 * @param {object} args
 */
function call(acc, callId, name, args) {
  emit(acc, 'tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
}

/**
 * @param {SessionAccumulator} acc
 * @param {string} callId
 * @param {string} text
 * @param {boolean} [isError]
 */
function result(acc, callId, text, isError = false) {
  emit(acc, 'tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], isError },
  })
}

test('accumulator pairs tool calls with results and records usage/turns/prompts/catalog', () => {
  const acc = new SessionAccumulator({ sessionId: 's1', cwd: '/repo', startedAt: 1 })
  emit(acc, 'request/header', { header: { tools: [{ name: 'bash', description: 'run shell' }, { name: 'read', description: 'read files' }] } })
  emit(acc, 'turn/start', { turn: 1 })
  emit(acc, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'fix it' }] })
  emit(acc, 'user/message', { source: { kind: 'tokeneconomizer' }, content: [{ type: 'text', text: 'context' }] })
  call(acc, 'c1', 'bash', { command: 'python -m pytest' })
  result(acc, 'c1', 'exit code: 1', true)
  emit(acc, 'assistant/message', { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 } })
  emit(acc, 'assistant/message', { usage: { inputTokens: 50, outputTokens: 10 } })
  emit(acc, 'turn/end', { reason: { kind: 'completed' } })

  const snapshot = acc.snapshot()
  assert.equal(snapshot.prompts, 1)
  assert.equal(snapshot.turns.total, 1)
  assert.equal(snapshot.turns.completed, 1)
  assert.equal(snapshot.calls.length, 1)
  assert.equal(snapshot.calls[0].tool, 'bash')
  assert.equal(snapshot.calls[0].failed, true)
  assert.deepEqual(snapshot.toolsUsed, ['bash'])
  assert.deepEqual(snapshot.toolsVisible, ['bash', 'read'])
  assert.equal(snapshot.usage.inputTokens, 150)
  assert.equal(snapshot.usage.outputTokens, 30)
  assert.equal(snapshot.usage.cacheReadTokens, 900)
  assert.equal(snapshot.usage.requests, 2)
})

test('an unpaired result is ignored and unknown events do not throw', () => {
  const acc = new SessionAccumulator({ sessionId: 's2' })
  result(acc, 'missing', 'x')
  emit(acc, 'goal/round', { anything: true })
  acc.onEvent({ type: 'bogus' })
  acc.onEvent(/** @type {any} */ (null))
  assert.deepEqual(acc.snapshot().calls, [])
})

test('call retention is bounded while accounting stays exact', () => {
  const acc = new SessionAccumulator({ sessionId: 's3' })
  for (let i = 0; i < MAX_RETAINED_CALLS + 25; i += 1) {
    call(acc, `c${i}`, 'bash', { command: `cmd ${i}` })
    result(acc, `c${i}`, 'ok')
  }
  const snapshot = acc.snapshot()
  assert.equal(snapshot.calls.length, MAX_RETAINED_CALLS)
  assert.equal(snapshot.truncatedCalls, 25)
  assert.deepEqual(snapshot.toolsUsed, ['bash'])
})

test('subagent sessions are identifiable and snapshots are serializable', () => {
  const acc = new SessionAccumulator({ sessionId: 's4', origin: 'subagent', cwd: '/repo' })
  assert.equal(acc.isSubagentSession(), true)
  emit(acc, 'request/header', { header: { tools: [{ name: 'bash' }] } })
  const snapshot = acc.snapshot()
  assert.equal(JSON.parse(JSON.stringify(snapshot)).sessionId, 's4')
  assert.deepEqual(snapshot.catalog, [{ name: 'bash', description: '' }])
})

test('turn end error/abort/max-tokens categories are counted separately', () => {
  const acc = new SessionAccumulator({ sessionId: 's5' })
  emit(acc, 'turn/start', { turn: 1 })
  emit(acc, 'turn/end', { reason: { kind: 'error', error: { message: 'boom' } } })
  emit(acc, 'turn/start', { turn: 2 })
  emit(acc, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } })
  emit(acc, 'turn/start', { turn: 3 })
  emit(acc, 'turn/end', { reason: { kind: 'max-tokens' } })
  const turns = acc.snapshot().turns
  assert.deepEqual(turns, { total: 3, completed: 0, aborted: 1, errored: 1, maxTokens: 1 })
})
