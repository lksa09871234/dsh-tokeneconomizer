import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  EnvelopeTracker,
  recordTurn,
  thresholdsFor,
} from '../../../lib/loopguard/envelope.js'
import {
  JUDGE_BASE_GAP,
  JUDGE_MAX_GAP,
  JUDGE_STALE_S,
  TurnGuard,
  runnerVerdict,
  statusOfTests,
  VERIFY_RE,
} from '../../../lib/loopguard/guard.js'
import {
  DEFAULT_THRESHOLDS,
  gateForJudge,
  pinLiveThresholds,
  scaledThresholds,
} from '../../../lib/loopguard/rules.js'
import { SpiralState } from '../../../lib/loopguard/state.js'

/**
 * Five ended-green turns of eight calls: the envelope becomes 10 tool calls
 * (`p90(8) * 1.25`) and the live-plugin gate pin engages.
 * @returns {{ tracker: EnvelopeTracker, envelope: number, thr: import('../../../lib/loopguard/rules.js').Thresholds }}
 */
function warmRepository() {
  const tracker = new EnvelopeTracker()
  for (let i = 0; i < 5; i += 1) tracker.update(8, true)
  const envelope = tracker.envelope
  assert.equal(envelope, 10)
  return { tracker, envelope, thr: pinLiveThresholds(thresholdsFor(tracker)) }
}

/** One stuck-call pattern: edits and identical failing test runs, alternately. */
const STUCK_CALLS = [
  { tool: 'Edit', args: { file_path: '/r/pkg/a.py', old_string: 'x', new_string: 'y' }, resultText: 'ok' },
  { tool: 'Bash', args: { command: 'pytest -q' }, resultText: 'FAILED tests/test_a.py::test_x - AssertionError: assert 1 == 2' },
]

/**
 * @param {TurnGuard} guard
 * @param {number} n
 * @param {{ envelope?: number|null, judge?: import('../../../lib/loopguard/guard.js').JudgeLike|null, thr?: import('../../../lib/loopguard/rules.js').Thresholds }} [options]
 * @returns {Array<import('../../../lib/loopguard/guard.js').GuardDecision|null>}
 */
function spin(guard, n, options = {}) {
  const out = []
  for (let k = 0; k < n; k += 1) {
    const call = STUCK_CALLS[k % 2]
    out.push(guard.fold(call, {
      envelope: options.envelope ?? 6,
      judge: options.judge ?? null,
      thr: options.thr ?? DEFAULT_THRESHOLDS,
    }))
  }
  return out
}

/** A background judge with the verdict handed in by the test (`plugin/judge.py` interface). */
class FakeBackgroundJudge {
  constructor() {
    /** @type {string[]} */
    this.started = []
    /** @type {import('../../../lib/loopguard/rules.js').JudgeVerdict|null} */
    this.verdict = null
  }

  /**
   * @param {TurnGuard} guard
   * @param {string} digest
   * @returns {string}
   */
  start(guard, digest) {
    void guard
    this.started.push(digest)
    return `job${this.started.length}`
  }

  /**
   * @param {TurnGuard} guard
   * @returns {{ found: boolean, verdict?: import('../../../lib/loopguard/rules.js').JudgeVerdict|null }}
   */
  poll(guard) {
    const pending = guard.judgePending
    if (this.verdict === null || pending === null || pending.id !== `job${this.started.length}`) {
      return { found: false }
    }
    const verdict = this.verdict
    this.verdict = null
    return { found: true, verdict }
  }
}

test('guard.judgeDigestVerificationState: the judge is told the real verification state', () => {
  const guard = new TurnGuard({ turnKey: 't' })
  const vendored = 'turns=3\nrepo_context: ... = 1.2x that typical length. Tests are still NOT green. A'
  assert.match(guard.liveDigest(vendored), /No test or verification run has been seen in this turn\./)
  guard.fold({ tool: 'Bash', args: { command: 'python bin/test sympy/core' }, resultText: 'tests finished: 10 passed', exitCode: 0 })
  const told = guard.liveDigest(vendored)
  assert.match(told, /The last verification run passed\./)
  assert.doesNotMatch(told, /NOT green/)
  guard.fold({ tool: 'Edit', args: { file_path: '/r/a.py', old_string: 'a', new_string: 'b' }, resultText: 'ok' })
  assert.equal(guard.liveDigest(vendored).split('There have been edits since.').length - 1, 1)
})

test('guard.contentToolNotFailure: reading a file full of asserts opens no gate and no signature', () => {
  const testFile = 'def test_total():\n    assert total([1, 2]) == 3\n    raise ValueError(\'no\')\n'
  const guard = new TurnGuard({ turnKey: 't' })
  for (let i = 0; i < 3; i += 1) {
    guard.fold({ tool: 'read', args: { path: 'tests/test_total.py' }, resultText: testFile })
    guard.fold({ tool: 'grep', args: { pattern: 'assert' }, resultText: 'tests/test_total.py:2:    assert total' })
  }
  guard.fold({ tool: 'bash', args: { command: 'cat tests/test_total.py' }, resultText: testFile, exitCode: 0 })
  assert.equal(guard.whole.errorOutputs, 0)
  assert.equal(guard.whole.repeatedFailSigs, 0)
  assert.equal(gateForJudge(guard.whole, { ...DEFAULT_THRESHOLDS, gate_min_turns: 1 }), false)
  // What did fail still counts: a non-zero exit, or a read the tool itself reports as failed.
  guard.fold({ tool: 'bash', args: { command: 'pytest -q' }, resultText: 'FAILED tests/test_total.py - AssertionError', exitCode: 1 })
  guard.fold({ tool: 'bash', args: { command: 'pytest -q' }, resultText: 'FAILED tests/test_total.py - AssertionError' })
  assert.equal(guard.whole.errorOutputs, 2)
  assert.equal(guard.whole.repeatedFailSigs, 1)
  const state = new SpiralState()
  state.update('Read', { file_path: 'x.py' }, 'Error: File does not exist.', true)
  assert.equal(state.errorOutputs, 1)
})

test('guard.judgeBackoff: a productive verdict grows the judge gap 5 -> 10', () => {
  const guard = new TurnGuard({ turnKey: 't' })
  const judge = new FakeBackgroundJudge()
  assert.deepEqual(spin(guard, 7, { judge }), Array.from({ length: 7 }, () => null))
  assert.equal(judge.started.length, 1)
  assert.doesNotMatch(judge.started[0], /NOT green/)
  judge.verdict = { stuck: false, confidence: 0.8, reason: 'progress' }
  assert.deepEqual(spin(guard, 1, { judge }), [null])
  assert.equal(guard.judgeGap, JUDGE_BASE_GAP * 2)
  assert.equal(guard.judgePending, null)
})

test('guard.judgeBackoff: a stuck verdict resets the judge gap', () => {
  const guard = new TurnGuard({ turnKey: 't' })
  const judge = new FakeBackgroundJudge()
  // A large envelope keeps the hard backstop out of the way while the cadence runs.
  spin(guard, 18, { envelope: 100, judge })
  assert.equal(judge.started.length, 1)
  judge.verdict = { stuck: false, confidence: 0.8 }
  assert.deepEqual(spin(guard, 1, { envelope: 100, judge }), [null])
  assert.equal(guard.judgeGap, 10)
  assert.deepEqual(spin(guard, 9, { envelope: 100, judge }), Array.from({ length: 9 }, () => null))
  assert.equal(judge.started.length, 2)
  judge.verdict = { stuck: true, confidence: 0.9, reason: 'loop' }
  const decision = spin(guard, 1, { envelope: 100, judge })[0]
  assert.equal(decision?.action, 'nudge')
  assert.equal(guard.judgeGap, JUDGE_BASE_GAP)
  assert.ok(guard.judgeGap < JUDGE_MAX_GAP)
})

test('guard.backgroundJudge: starts once, then its verdict nudges a later call', () => {
  const guard = new TurnGuard({ turnKey: 't' })
  const judge = new FakeBackgroundJudge()
  assert.deepEqual(spin(guard, 10, { judge }), Array.from({ length: 10 }, () => null))
  assert.equal(judge.started.length, 1) // and no second job is started
  assert.doesNotMatch(judge.started[0], /NOT green/)
  judge.verdict = {
    stuck: true,
    confidence: 0.9,
    reason: 'loop',
    nudge: 'Read the failing assertion before editing again.',
  }
  const decision = spin(guard, 1, { judge })[0]
  assert.equal(decision?.action, 'nudge')
  assert.equal(decision?.reason, 'judge-stuck@0.90:loop')
  assert.equal(decision?.text, 'Read the failing assertion before editing again.')
  // nudgeBody consumed the judge-written redirect once; afterwards it is the template.
  assert.notEqual(guard.nudgeBody({ envelope: 6 }), 'Read the failing assertion before editing again.')
  assert.match(guard.nudgeBody({ envelope: 6 }), /^Process check \(automated\):/)
})

test('guard.staleJudge: a job that never answers stops blocking the next one', () => {
  const guard = new TurnGuard({ turnKey: 't' })
  const judge = new FakeBackgroundJudge()
  spin(guard, 7, { judge })
  assert.equal(judge.started.length, 1)
  assert.ok(guard.judgePending)
  // Its process died: the verdict never came back.
  guard.judgePending.since = 0
  spin(guard, guard.judgeGap, { judge })
  assert.equal(judge.started.length, 2)
  // The stale timeout is upstream's 300 s.
  assert.equal(JUDGE_STALE_S, 300)
})

test('guard.coldStartSpares: with no learned envelope the guard never acts and never pays', () => {
  const guard = new TurnGuard({ turnKey: 't' })
  let calls = 0
  const judge = { judge: () => { calls += 1; return { stuck: true, confidence: 1 } } }
  const results = []
  for (let k = 0; k < 40; k += 1) {
    results.push(guard.fold(STUCK_CALLS[k % 2], { envelope: null, judge }))
  }
  assert.deepEqual(results, Array.from({ length: 40 }, () => null))
  assert.equal(calls, 0)
  assert.equal(guard.cumTurns, 40)
  assert.equal(guard.nudgesDone, 0)
  assert.equal(guard.aborted, false)
})

test('guard.coldStartSpares: the no-judge fallback also spares a cold repository', () => {
  const guard = new TurnGuard({ turnKey: 't' })
  const decisions = []
  for (let k = 0; k < 40; k += 1) decisions.push(guard.fold(STUCK_CALLS[k % 2], { envelope: null }))
  assert.deepEqual(decisions, Array.from({ length: 40 }, () => null))
})

test('guard.warmGuardNudgesThenOnlyNotifies: one redirect, then one notice, then silence', () => {
  const { envelope, thr } = warmRepository()
  const guard = new TurnGuard({ turnKey: 't' })
  /** @type {Array<{ at: number, decision: import('../../../lib/loopguard/guard.js').GuardDecision }>} */
  const fired = []
  for (let call = 0; call < 60; call += 1) {
    const decision = guard.fold(STUCK_CALLS[call % 2], { envelope, thr })
    if (decision) fired.push({ at: call + 1, decision })
  }
  assert.equal(fired.length, 2)
  assert.equal(fired[0].decision.action, 'nudge')
  assert.match(fired[0].decision.text, /^Process check \(automated\):/)
  assert.equal(fired[1].decision.action, 'notice')
  assert.match(fired[1].decision.text, /still looks stuck/)
  assert.equal(guard.nudgesDone, 1)
  assert.equal(guard.aborted, true)
  assert.equal(guard.abortDelivered, true)
  // The turn's own state is preserved so the adapter can summarize it.
  assert.equal(guard.cumTurns, 60)
  assert.equal(guard.whole.errorOutputs, 30)
})

test('guard.gateStaysClosed: a long clean turn never wakes the judge', () => {
  const { envelope, thr } = warmRepository()
  const guard = new TurnGuard({ turnKey: 't' })
  let calls = 0
  const judge = { judge: () => { calls += 1; return { stuck: true, confidence: 1 } } }
  for (let k = 0; k < 60; k += 1) {
    const decision = guard.fold(
      { tool: 'Read', args: { file_path: `/r/m${k}.py` }, resultText: 'ok' },
      { envelope, thr, judge },
    )
    assert.equal(decision, null)
  }
  assert.equal(calls, 0)
})

test('guard.nudgeBeforeBackstop: a small envelope\'s backstop never preempts the nudge', () => {
  const thr = scaledThresholds('aggressive')
  const failure = 'FAIL: test_floats (tests.test_calc.TestAdd)\nTraceback (most recent call last):\n'
    + 'AssertionError: 0.30000000000000004 != 0.3\n\nFAILED (failures=1)\n'
  const guard = new TurnGuard({ turnKey: 't' })
  /** @type {import('../../../lib/loopguard/guard.js').GuardToolCall[]} */
  const sequence = [
    { tool: 'Bash', args: { command: 'python -m unittest' }, resultText: failure, exitCode: 1 },
  ]
  for (let k = 0; k < 30; k += 1) {
    sequence.push({ tool: 'Edit', args: { file_path: 'src/calc/__init__.py', old_string: 'x', new_string: `y${k}` }, resultText: 'ok' })
    sequence.push({ tool: 'Bash', args: { command: 'python -m unittest' }, resultText: failure, exitCode: 1 })
  }
  /** @type {Array<[number, string]>} */
  const fired = []
  for (let i = 0; i < sequence.length; i += 1) {
    const decision = guard.fold(sequence[i], { envelope: 4.0, thr })
    if (decision) {
      fired.push([i + 1, decision.action])
      if (decision.action === 'notice') break
    }
  }
  assert.deepEqual(fired, [[14, 'nudge'], [28, 'notice']])
})

test('guard.verifyPathForms: a runner named by path counts as verification', () => {
  const commands = [
    'python tests/runtests.py model_inheritance -v 2',
    './runtests.py basic',
    '.venv/bin/pytest -q tests/test_a.py',
    'cd web && ./node_modules/.bin/jest src',
    '/usr/bin/python3 -m pytest',
    '/w/venv/bin/pytest -q',
    '~/.local/bin/pytest -q',
    'python3 /w/repo/tests/runtests.py basic',
    'node --test test/',
  ]
  for (const command of commands) {
    const guard = new TurnGuard({ turnKey: 't' })
    guard.fold({ tool: 'Edit', args: { file_path: '/r/a.py', old_string: 'x', new_string: 'y' }, resultText: 'ok' })
    guard.fold({ tool: 'Bash', args: { command }, resultText: 'FAILED (failures=1)', exitCode: 1 })
    assert.equal(guard.verifications, 1, command)
    assert.equal(guard.resolvedProxy(), false, command)
  }
})

test('guard.verifyPathForms: a file named like a runner is not a verification', () => {
  const commands = ['cat /w/pytest.ini', 'cat pytest.ini', 'ls /w/tests', 'vim tests/runtests.py.bak']
  for (const command of commands) {
    assert.equal(VERIFY_RE.test(command), false, command)
    const guard = new TurnGuard({ turnKey: 't' })
    guard.fold({ tool: 'Edit', args: { file_path: '/r/a.py', old_string: 'x', new_string: 'y' }, resultText: 'ok' })
    guard.fold({ tool: 'Bash', args: { command }, resultText: 'FAILED (failures=1)', exitCode: 1 })
    assert.equal(guard.verifications, 0, command)
  }
})

test('guard.statusOfTests: a replaced status is judged by the runner\'s own summary', () => {
  assert.equal(statusOfTests('npm test 2>&1 | tail -n 8'), 'hidden')
  assert.equal(statusOfTests('set -o pipefail; npm test | tail -n 8'), 'own')
  assert.equal(statusOfTests('python3 -m unittest tests.test_x; echo "exit=$?"'), 'hidden')
  assert.equal(statusOfTests('npm test || true'), 'hidden')
  assert.equal(statusOfTests('pytest -q; git diff'), 'mixed')
  assert.equal(statusOfTests('set -o pipefail; npm test | tail -n 8'), 'own')
  assert.equal(statusOfTests('/bin/bash -lc \'cd /w && timeout 60 go test ./... 2>&1 | tail -3\''), 'hidden')
  assert.equal(statusOfTests('ls -la'), null)
  assert.equal(statusOfTests(null), null)

  const tapFailing = '# tests 9\n# suites 0\n# pass 8\n# fail 1\n# cancelled 0'
  const guard = new TurnGuard({ turnKey: 't' })
  for (let i = 0; i < 3; i += 1) {
    guard.fold({ tool: 'bash', args: { command: 'npm test 2>&1 | tail -n 8' }, resultText: tapFailing, exitCode: 0 })
  }
  assert.equal(guard.whole.errorOutputs, 3)
  assert.equal(guard.whole.repeatedFailSigs, 2)
  assert.equal(guard.resolvedProxy(), false)

  const pipefail = new TurnGuard({ turnKey: 't' })
  pipefail.fold({ tool: 'bash', args: { command: 'set -o pipefail; npm test | tail -n 8' }, resultText: tapFailing, exitCode: 0 })
  pipefail.fold({ tool: 'bash', args: { command: 'pytest -q | grep FAILED' }, resultText: '', exitCode: 1 })
  assert.equal(pipefail.whole.errorOutputs, 0)
  assert.equal(pipefail.resolvedProxy(), true)
})

test('guard.statusOfTests: a test run followed by other commands uses its runner summary', () => {
  const diff = 'diff --git a/m.py b/m.py\n+    raise ValueError(\'no\')\n'
  const mixed = new TurnGuard({ turnKey: 't' })
  mixed.fold({ tool: 'bash', args: { command: 'pytest -q; git diff' }, resultText: `F.\n1 failed, 1 passed in 0.12s\n${diff}`, exitCode: 0 })
  assert.equal(mixed.whole.errorOutputs, 1)
  assert.equal(mixed.resolvedProxy(), false)
  for (const exitCode of [1, 0, null]) {
    const guard = new TurnGuard({ turnKey: 't' })
    guard.fold({ tool: 'bash', args: { command: 'pytest -q\ngit diff --exit-code' }, resultText: `2 passed in 0.10s\n${diff}`, exitCode })
    assert.equal(guard.whole.errorOutputs, 0, String(exitCode))
    assert.equal(guard.resolvedProxy(), true, String(exitCode))
  }
})

test('guard.statusOfTests: any other command keeps the reported exit status', () => {
  const commands = [
    'tar -xOf pkg.tgz pkg/x.py | sed -n 1,80p',
    'cat tests/test_x.py | head -40',
    'grep -rn pytest src | head',
    'python -m pytest x.py --collect-only -q | rg test_',
    'bin/test --help | head',
    'python repro.py 2>&1 | tail',
    'pytest -q; git diff --stat',
  ]
  for (const command of commands) {
    const guard = new TurnGuard({ turnKey: 't' })
    guard.fold({
      tool: 'bash',
      args: { command },
      resultText: 'def f():\n    assert x\n    raise ValueError(\'no\')\n',
      exitCode: 0,
    })
    assert.equal(guard.whole.errorOutputs, 0, command)
  }
})

test('guard.runnerVerdict: runners\' summaries across ecosystems', () => {
  const tapFailing = '# tests 9\n# suites 0\n# pass 8\n# fail 1\n# cancelled 0'
  /** @type {Array<[string, boolean|null]>} */
  const cases = [
    ['1 failed, 4 passed, 2 warnings in 1.23s', true],
    ['== 1 error in 0.12s ==', true],
    ['2 passed, 1 warning in 0.30s', false],
    ['no tests ran in 0.01s', null],
    ['Ran 3 tests in 0.1s\n\nFAILED (failures=1)', true],
    ['Ran 3 tests in 0.1s\n\nOK', false],
    ['tests finished: 10 passed, 1 failed, in 3.20 seconds', true],
    [tapFailing, true],
    ['# pass 9\n# fail 0', false],
    ['Tests:       1 failed, 3 passed, 4 total', true],
    ['  3 passing (20ms)\n  1 failing', true],
    ['--- FAIL: TestAdd (0.00s)', true],
    ['ok  \tacme/x\t0.012s', false],
    ['test result: FAILED. 1 passed; 1 failed', true],
    ['test result: ok. 3 passed; 0 failed', false],
    ['5 examples, 1 failure', true],
    ['Tests run: 4, Failures: 0, Errors: 1', true],
    ['[INFO] BUILD SUCCESS', false],
    ["+    raise ValueError('no')", null],
    ['ok 1 - add', null],
  ]
  for (const [output, expected] of cases) {
    assert.equal(runnerVerdict(output), expected, JSON.stringify(output))
  }
})

test('guard.envelopeOnlyGreen: only turns that ended green feed the envelope', () => {
  const tracker = new EnvelopeTracker()
  const red = new TurnGuard({ turnKey: 'red' })
  red.fold({ tool: 'Edit', args: { file_path: '/r/a.py' }, resultText: 'ok' })
  red.fold({ tool: 'Bash', args: { command: 'pytest -q' }, resultText: 'FAILED tests/test_a.py::t - AssertionError', exitCode: 1 })
  recordTurn(tracker, red)
  assert.deepEqual(tracker.toJSON().resolved_turns, [])
  const green = new TurnGuard({ turnKey: 'green' })
  green.fold({ tool: 'Edit', args: { file_path: '/r/a.py' }, resultText: 'ok' })
  green.fold({ tool: 'Bash', args: { command: 'pytest -q' }, resultText: '3 passed', exitCode: 0 })
  recordTurn(tracker, green)
  assert.deepEqual(tracker.toJSON().resolved_turns, [2])
  assert.equal(tracker.toJSON().resolved_snaps.length, 1)
  assert.equal(tracker.toJSON().resolved_snaps[0]?.turns, 2)
})

test('guard.nudgesThenNotifies: the module only returns decisions, never a stop call', () => {
  const { envelope, thr } = warmRepository()
  const guard = new TurnGuard({ turnKey: 't' })
  /** @type {string[]} */
  const actions = []
  for (let call = 0; call < 60; call += 1) {
    const decision = guard.fold(STUCK_CALLS[call % 2], { envelope, thr })
    if (!decision) continue
    actions.push(decision.action)
    assert.equal(typeof decision.reason, 'string')
    assert.equal(typeof decision.text, 'string')
    assert.ok(['nudge', 'notice'].includes(decision.action))
    assert.equal(Object.hasOwn(decision, 'stop'), false)
  }
  assert.deepEqual(actions, ['nudge', 'notice'])
})

test('guard.serialization: a persisted guard resumes with the same segment, cadence and totals', () => {
  const guard = new TurnGuard({ turnKey: 'turn-1' })
  const judge = new FakeBackgroundJudge()
  spin(guard, 7, { judge })
  judge.verdict = { stuck: false, confidence: 0.8 }
  spin(guard, 1, { judge })
  guard.fold({ tool: 'Edit', args: { file_path: '/r/a.py' }, resultText: 'ok' })
  const restored = TurnGuard.fromJSON(JSON.parse(JSON.stringify(guard)))
  assert.equal(restored.cumTurns, guard.cumTurns)
  assert.equal(restored.judgeGap, guard.judgeGap)
  assert.equal(restored.judgeCalls, guard.judgeCalls)
  assert.equal(restored.st.turns, guard.st.turns)
  assert.equal(restored.whole.turns, guard.whole.turns)
  assert.equal(restored.lastEdit, guard.lastEdit)
  assert.deepEqual(restored.summary(false), guard.summary(false))
  // It keeps folding identically after a reload.
  const next = restored.fold(STUCK_CALLS[1], { envelope: 6, judge })
  assert.equal(next, null)
  assert.equal(restored.cumTurns, guard.cumTurns + 1)
  // Malformed data degrades to a fresh guard.
  assert.equal(TurnGuard.fromJSON({ st: 'nope', cum_turns: 'x' }).cumTurns, 0)
})

test('guard.summary: the per-turn ledger summary fields', () => {
  const guard = new TurnGuard({ turnKey: 't' })
  guard.fold({ tool: 'Edit', args: { file_path: '/r/a.py' }, resultText: 'ok' })
  guard.fold({ tool: 'Bash', args: { command: 'pytest -q' }, resultText: '3 passed', exitCode: 0 })
  assert.deepEqual(guard.summary(true), {
    turn_key: 't',
    tool_calls: 2,
    nudges: 0,
    aborted: false,
    resolved_proxy: true,
    edits: 1,
    verifications: 1,
    judge_tokens: 0,
    writer_tokens: 0,
  })
})
