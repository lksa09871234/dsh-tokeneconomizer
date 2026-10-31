/**
 * Offline tests for the background guard judge adapter
 * (`lib/dsh/judge.js`). The sidecall is a plain fake object, so these tests
 * never touch a model, network, or DSH profile.
 *
 * Run with:
 *   node --test --test-isolation=none "test/unit/dsh/judge.test.js"
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JUDGE_REASON_MAX_CHARS, NUDGE_MAX_CHARS, NUDGE_WRITER_SYSTEM, STUCK_JUDGE_SYSTEM } from '../../../lib/loopguard/judge.js'
import { createGuardJudge } from '../../../lib/dsh/judge.js'

/** @param {number} ms @returns {Promise<void>} */
function flush(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll until a verdict (or a bounded number of macrotasks).
 *
 * @param {{poll: (guard: any) => {found: boolean, verdict?: any}}} judge
 * @param {{segment: number}} guard
 * @param {number} [attempts]
 * @returns {Promise<{found: boolean, verdict?: any}>}
 */
async function waitVerdict(judge, guard, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    const polled = judge.poll(guard)
    if (polled.found) return polled
    await flush(0)
  }
  throw new Error('judge job did not complete')
}

/**
 * Side-call usage with a known effective total (input + cacheRead + cacheWrite + output).
 *
 * @param {number} input
 * @param {number} output
 * @param {number} cacheRead
 * @param {number} cacheWrite
 * @returns {{inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, totalTokens: number}}
 */
function usage(input, output, cacheRead = 0, cacheWrite = 0) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
  }
}

/**
 * Fake sidecall recording every request.
 *
 * @param {(request: any, index: number) => any} handler
 * @returns {{calls: any[], call: (request: any) => Promise<any>}}
 */
function fakeSidecall(handler) {
  /** @type {any[]} */
  const calls = []
  return {
    calls,
    async call(request) {
      calls.push(request)
      return handler(request, calls.length - 1)
    },
  }
}

const JUDGE_DIGEST = 'recent actions: 4 edits to src/app.py; 3 failed pytest runs'

test('start fires the judge call and poll returns parsed verdict, tokens and nudge', async () => {
  const sidecall = fakeSidecall((_request, index) => {
    if (index === 0) {
      return { ok: true, text: JSON.stringify({ stuck: true, confidence: 1.7, reason: 'r'.repeat(400) }), usage: usage(10, 5, 2, 1) }
    }
    return { ok: true, text: 'n'.repeat(NUDGE_MAX_CHARS + 50), usage: usage(20, 10) }
  })
  const judge = createGuardJudge({ sidecall, enableNudgeWriter: true })
  const guard = { segment: 0 }
  const jobId = judge.start(guard, JUDGE_DIGEST)
  assert.equal(typeof jobId, 'string')
  assert.ok(jobId !== '')
  assert.deepEqual(judge.poll(guard), { found: false })
  assert.equal(judge.start(guard, JUDGE_DIGEST), null, 'one pending job at most')

  const polled = await waitVerdict(judge, guard)
  const verdict = polled.verdict
  assert.equal(verdict.stuck, true)
  assert.equal(verdict.confidence, 1)
  assert.equal(verdict.reason.length, JUDGE_REASON_MAX_CHARS)
  assert.equal(verdict.tokens, 18 + 30)
  assert.equal(verdict.nudge.length, NUDGE_MAX_CHARS)

  assert.equal(sidecall.calls.length, 2)
  assert.equal(sidecall.calls[0].system, STUCK_JUDGE_SYSTEM)
  assert.match(sidecall.calls[0].prompt, /recent actions: 4 edits/)
  assert.equal(sidecall.calls[1].system, NUDGE_WRITER_SYSTEM)
  assert.equal(sidecall.calls[1].maxTokens, NUDGE_MAX_CHARS)

  assert.deepEqual(judge.poll(guard), { found: false })
  assert.equal(typeof judge.start(guard, JUDGE_DIGEST), 'string')
  judge.dispose()
})

test('verdict only returns for the current segment; a stale verdict is dropped and aborted', async () => {
  const sidecall = fakeSidecall((request) => new Promise((resolve) => {
    request.signal.addEventListener('abort', () => resolve({ ok: false, code: 'aborted', error: 'aborted' }), { once: true })
  }))
  const judge = createGuardJudge({ sidecall })
  const guard = { segment: 0 }
  assert.equal(typeof judge.start(guard, JUDGE_DIGEST), 'string')
  await flush(0)
  assert.equal(sidecall.calls.length, 1)
  guard.segment = 1
  const stalePoll = judge.poll(guard)
  assert.deepEqual(stalePoll, { found: false })
  assert.equal(sidecall.calls[0].signal.aborted, true, 'stale job is aborted so nobody pays for it')
  assert.equal(typeof judge.start(guard, JUDGE_DIGEST), 'string', 'a new segment may start a new job')
  judge.dispose()
})

test('a completed but unpolled verdict is dropped when the segment moved on', async () => {
  const sidecall = fakeSidecall(() => ({ ok: true, text: '{"stuck":true,"confidence":0.9}', usage: usage(1, 1) }))
  const judge = createGuardJudge({ sidecall })
  const guard = { segment: 0 }
  judge.start(guard, JUDGE_DIGEST)
  await flush(0)
  guard.segment = 1
  assert.deepEqual(judge.poll(guard), { found: false }, 'old-segment verdict never leaks back')
  const nextId = judge.start(guard, JUDGE_DIGEST)
  assert.equal(typeof nextId, 'string')
  judge.dispose()
})

test('unparseable reply yields a judge-error verdict carrying the call tokens', async () => {
  const sidecall = fakeSidecall(() => ({ ok: true, text: 'not json at all', usage: usage(3, 3) }))
  const judge = createGuardJudge({ sidecall })
  const guard = { segment: 0 }
  judge.start(guard, JUDGE_DIGEST)
  const verdict = (await waitVerdict(judge, guard)).verdict
  assert.deepEqual({ stuck: verdict.stuck, confidence: verdict.confidence, reason: verdict.reason, tokens: verdict.tokens }, {
    stuck: null,
    confidence: 0,
    reason: 'judge-error',
    tokens: 6,
  })
  assert.equal(sidecall.calls.length, 1, 'no writer call for an unparsed verdict')
  judge.dispose()
})

test('failed calls map to judge-error / judge-unavailable without throwing', async () => {
  for (const [code, expected] of [['timeout', 'judge-error'], ['llm-unavailable', 'judge-unavailable'], ['module-unavailable', 'judge-unavailable']]) {
    const sidecall = fakeSidecall(() => ({ ok: false, code, error: 'side call failed' }))
    const judge = createGuardJudge({ sidecall })
    const guard = { segment: 0 }
    judge.start(guard, JUDGE_DIGEST)
    const verdict = (await waitVerdict(judge, guard)).verdict
    assert.equal(verdict.stuck, null)
    assert.equal(verdict.confidence, 0)
    assert.equal(verdict.reason, expected)
    assert.equal(verdict.tokens, 0)
    judge.dispose()
  }
})

test('a judge with no sidecall is inert and public calls never throw', () => {
  const judge = createGuardJudge()
  assert.equal(judge.start({ segment: 0 }, JUDGE_DIGEST), null)
  assert.deepEqual(judge.poll({ segment: 0 }), { found: false })
  assert.doesNotThrow(() => judge.dispose())
  assert.doesNotThrow(() => judge.dispose())

  const sidecall = fakeSidecall(() => ({ ok: true, text: '{"stuck":false,"confidence":0.2}', usage: usage(1, 1) }))
  const working = createGuardJudge({ sidecall })
  assert.doesNotThrow(() => working.start(/** @type {any} */ (null), /** @type {any} */ (null)))
  assert.doesNotThrow(() => working.poll(/** @type {any} */ (null)))
  working.dispose()
})

test('dispose aborts in-flight work, clears the job and makes start inert', async () => {
  const sidecall = fakeSidecall((request) => new Promise((resolve) => {
    request.signal.addEventListener('abort', () => resolve({ ok: false, code: 'aborted', error: 'aborted' }), { once: true })
  }))
  const judge = createGuardJudge({ sidecall })
  const guard = { segment: 0 }
  assert.equal(typeof judge.start(guard, JUDGE_DIGEST), 'string')
  await flush(0)
  assert.equal(sidecall.calls.length, 1)
  judge.dispose()
  assert.equal(sidecall.calls[0].signal.aborted, true)
  assert.deepEqual(judge.poll(guard), { found: false })
  assert.equal(judge.start(guard, JUDGE_DIGEST), null)
  await flush(5)
  assert.deepEqual(judge.poll(guard), { found: false })
})

test('internal timeout ends the job and leaves no timer behind', async () => {
  const sidecall = fakeSidecall((request) => new Promise((resolve) => {
    request.signal.addEventListener('abort', () => resolve({ ok: false, code: 'timeout', error: 'signal aborted' }), { once: true })
  }))
  const judge = createGuardJudge({ sidecall, timeoutMs: 20 })
  const guard = { segment: 0 }
  judge.start(guard, JUDGE_DIGEST)
  const verdict = (await waitVerdict(judge, guard)).verdict
  assert.equal(verdict.reason, 'judge-error')
  assert.equal(verdict.tokens, 0)
  assert.equal(sidecall.calls[0].signal.aborted, true)
  judge.dispose()
})

test('maxJudgedTokens skips the writer once the judge call spent the budget', async () => {
  const sidecall = fakeSidecall((_request, index) => (index === 0
    ? { ok: true, text: '{"stuck":true,"confidence":0.95}', usage: usage(10, 8) }
    : { ok: true, text: 'redirect', usage: usage(1, 1) }))
  const judge = createGuardJudge({ sidecall, enableNudgeWriter: true, maxJudgedTokens: 10 })
  const guard = { segment: 0 }
  judge.start(guard, JUDGE_DIGEST)
  const verdict = (await waitVerdict(judge, guard)).verdict
  assert.equal(verdict.stuck, true)
  assert.equal(verdict.tokens, 18)
  assert.equal(verdict.nudge, undefined)
  assert.equal(sidecall.calls.length, 1)
  judge.dispose()
})

test('writer failure or disabled writer keeps the stuck verdict without a nudge', async () => {
  const failing = fakeSidecall((_request, index) => (index === 0
    ? { ok: true, text: '{"stuck":true,"confidence":0.9}', usage: usage(2, 2) }
    : { ok: false, code: 'timeout', error: 'writer timed out' }))
  const judge = createGuardJudge({ sidecall: failing, enableNudgeWriter: true })
  const guard = { segment: 0 }
  judge.start(guard, JUDGE_DIGEST)
  const verdict = (await waitVerdict(judge, guard)).verdict
  assert.equal(verdict.stuck, true)
  assert.equal(verdict.nudge, undefined)
  assert.equal(verdict.tokens, 4)
  judge.dispose()

  const disabled = fakeSidecall(() => ({ ok: true, text: '{"stuck":true,"confidence":0.9}', usage: usage(2, 2) }))
  const plain = createGuardJudge({ sidecall: disabled })
  const plainGuard = { segment: 0 }
  plain.start(plainGuard, JUDGE_DIGEST)
  const plainVerdict = (await waitVerdict(plain, plainGuard)).verdict
  assert.equal(plainVerdict.stuck, true)
  assert.equal(plainVerdict.nudge, undefined)
  assert.equal(disabled.calls.length, 1)
  plain.dispose()
})

test('stuck=false and confidence bounds are preserved without calling the writer', async () => {
  const sidecall = fakeSidecall(() => ({ ok: true, text: '{"stuck":false,"confidence":-3}', usage: usage(1, 1) }))
  const judge = createGuardJudge({ sidecall, enableNudgeWriter: true })
  const guard = { segment: 0 }
  judge.start(guard, JUDGE_DIGEST)
  const verdict = (await waitVerdict(judge, guard)).verdict
  assert.equal(verdict.stuck, false)
  assert.equal(verdict.confidence, 0)
  assert.equal(sidecall.calls.length, 1)
  judge.dispose()
})
