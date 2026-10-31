import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ERR_RE,
  RECENT_LIMIT,
  SpiralState,
  TEST_RUN_RE,
  basename,
  canonTool,
  failureSignature,
  matchesErrorMarker,
} from '../../../lib/loopguard/state.js'

/**
 * @param {Array<[unknown, Record<string, unknown>, string, (boolean|number)?]>} fixture
 * @returns {SpiralState}
 */
function stateWith(fixture) {
  const state = new SpiralState()
  for (const [name, args, result, failed] of fixture) state.update(name, args, result, failed)
  return state
}

test('state.canonTool: upstream and DSH tool spellings map to one family', () => {
  assert.equal(canonTool('Bash'), 'bash')
  assert.equal(canonTool('shell'), 'bash')
  assert.equal(canonTool('pwsh'), 'bash')
  assert.equal(canonTool('ops_bash'), 'bash')
  assert.equal(canonTool('Read'), 'view')
  assert.equal(canonTool('read_file'), 'view')
  assert.equal(canonTool('MultiEdit'), 'edit')
  assert.equal(canonTool('multi_edit'), 'edit')
  assert.equal(canonTool('Apply_Patch'), 'edit')
  assert.equal(canonTool('Write'), 'create')
  assert.equal(canonTool('create_file'), 'create')
  assert.equal(canonTool('Grep'), 'grep')
  assert.equal(canonTool('Glob'), 'glob')
  assert.equal(canonTool('question'), 'question') // unknown passes through
  assert.equal(canonTool(''), '?')
  assert.equal(canonTool(undefined), '?')
})

test('state.basename: last component, POSIX and Windows separators', () => {
  assert.equal(basename('pkg/mod.py'), 'mod.py')
  assert.equal(basename('pkg/mod.py/'), 'mod.py')
  assert.equal(basename('src\\pkg\\mod.py'), 'mod.py')
  assert.equal(basename('/'), '')
  assert.equal(basename(''), '')
  assert.equal(basename(null), '')
})

test('state.matchesErrorMarker: upstream marker vocabulary incl. case-sensitive all-caps', () => {
  assert.equal(matchesErrorMarker('Traceback (most recent call last):'), true)
  assert.equal(matchesErrorMarker('ValueError: bad'), true)
  assert.equal(matchesErrorMarker('FAILED tests/test_a.py::t'), true)
  assert.equal(matchesErrorMarker('assert total == 3'), true)
  assert.equal(matchesErrorMarker('# fail 1'), true)
  assert.equal(matchesErrorMarker('not ok 3 - rates'), true)
  assert.equal(matchesErrorMarker('2 failing'), true)
  assert.equal(matchesErrorMarker('--- FAIL: TestAdd (0.00s)'), true)
  assert.equal(matchesErrorMarker('FAIL\tacme/x'), true)
  assert.equal(matchesErrorMarker('FAIL'), true)
  // `fail` alone (lower-case) is not the Go/TAP summary the case-sensitive tail names.
  assert.equal(matchesErrorMarker('fail'), false)
  assert.equal(matchesErrorMarker('3 passed in 0.1s'), false)
  assert.equal(matchesErrorMarker(''), false)
  assert.equal(matchesErrorMarker(null), false)
  assert.equal(ERR_RE.test('all good'), false)
  assert.equal(TEST_RUN_RE.test('python -m pytest -q'), true)
  assert.equal(TEST_RUN_RE.test('ls tests'), false)
})

test('state.failureSignature: numbers, addresses and paths are normalized away', () => {
  const a = failureSignature('AssertionError: assert 1 == 2 at 0xdeadbeef in /repo/a.py')
  const b = failureSignature('AssertionError: assert 5 == 9 at 0xcafe in /repo/b.py')
  assert.equal(a, b)
  assert.match(String(a), /^[0-9a-f]{10}$/)
  // A different failure line is a different signature.
  assert.notEqual(a, failureSignature('ValueError: nope'))
  // No error line -> no signature.
  assert.equal(failureSignature('all tests passed'), null)
  assert.equal(failureSignature(''), null)
})

test('state.update: edits per basename, order, churn and distinct files', () => {
  const state = stateWith([
    ['Edit', { file_path: '/r/pkg/a.py' }, 'ok'],
    ['MultiEdit', { file_path: '/r/pkg/a.py' }, 'ok'],
    ['Write', { path: '/r/pkg/b.py' }, 'ok'],
    ['str_replace', { filePath: '/r/pkg/c.py' }, 'ok'],
  ])
  assert.equal(state.turns, 4)
  assert.equal(state.editCounts['a.py'], 2)
  assert.equal(state.editChurn, 2)
  assert.equal(state.distinctEditFiles, 3)
  assert.deepEqual(state.editOrder, ['a.py', 'a.py', 'b.py', 'c.py'])
})

test('state.update: bash test runs are counted and appear in the action log', () => {
  const state = stateWith([
    ['Bash', { command: '  python -m   pytest   -q  ' }, '3 passed', 0],
    ['Bash', { command: 'ls -la' }, '', 0],
  ])
  assert.equal(state.testRuns, 1)
  assert.equal(state.recent[0], '  1: $ python -m pytest -q')
  assert.equal(state.recent[1], '  2: $ ls -la')
})

test('state.update: grep/glob/view action lines are leakage-safe summaries', () => {
  const state = stateWith([
    ['Grep', { pattern: 'assert total' }, '/r/tests/test_a.py:2: assert total == 3'],
    ['View', { path: '/r/tests/test_a.py' }, 'def test_total():\n    assert total([1, 2]) == 3'],
  ])
  assert.equal(state.recent[0], '  1: grep assert total')
  assert.equal(state.recent[1], '  2: view test_a.py')
  // The action log records neither the read content nor the matched line.
  assert.doesNotMatch(state.recent.join('\n'), /assert total == 3/)
})

test('guard.contentToolNotFailure: reading a file full of asserts is not a failure', () => {
  const testFile = 'def test_total():\n    assert total([1, 2]) == 3\n    raise ValueError(\'no\')\n'
  const state = new SpiralState()
  for (let i = 0; i < 3; i += 1) {
    state.update('read', { path: 'tests/test_total.py' }, testFile)
    state.update('grep', { pattern: 'assert' }, 'tests/test_total.py:2:    assert total')
  }
  state.update('bash', { command: 'cat tests/test_total.py' }, testFile, false)
  assert.equal(state.errorOutputs, 0)
  assert.equal(state.repeatedFailSigs, 0)
  // A read the TOOL itself reports as failed can fail.
  const failedRead = new SpiralState()
  failedRead.update('Read', { file_path: 'x.py' }, 'Error: File does not exist.', true)
  assert.equal(failedRead.errorOutputs, 1)
  // A bash result known to have succeeded cannot be a failure even if the text looks like one.
  state.update('bash', { command: 'cat tests/test_total.py' }, 'FAILED tests/test_total.py', false)
  assert.equal(state.errorOutputs, 0)
})

test('state.update: repeated identical failures raise repeatedFailSigs and stagnation', () => {
  const failure = 'FAILED tests/test_a.py::test_x - AssertionError: assert 1 == 2'
  const state = new SpiralState()
  for (let i = 0; i < 3; i += 1) state.update('bash', { command: 'pytest -q' }, failure, 1)
  assert.equal(state.errorOutputs, 3)
  assert.equal(state.repeatedFailSigs, 2)
  const signature = failureSignature(failure)
  assert.ok(signature)
  assert.equal(state.failSigs[signature], 3)
  assert.ok(Math.abs(state.stagnation - 2 / 3) < 1e-9)
  // A different failure is not a repeat.
  state.update('bash', { command: 'pytest -q' }, 'ValueError: other problem', 1)
  assert.equal(state.repeatedFailSigs, 2)
  assert.equal(Object.keys(state.failSigs).length, 2)
})

test('state.update: the recent action log is capped at 40 entries', () => {
  const state = new SpiralState()
  for (let i = 0; i < 60; i += 1) state.update('bash', { command: `echo ${i}` }, '', 0)
  assert.equal(state.recent.length, RECENT_LIMIT)
  assert.match(state.recent[0] ?? '', /: \$ echo 20$/)
})

test('state.recentDigest: compact, leakage-safe, with repo context when given', () => {
  const failure = 'AssertionError: assert 1 == 2'
  const state = new SpiralState()
  state.update('Edit', { file_path: '/r/pkg/a.py' }, 'ok')
  state.update('bash', { command: 'pytest -q' }, failure, 1)
  state.update('Edit', { file_path: '/r/pkg/a.py' }, 'ok')
  state.update('bash', { command: 'pytest -q' }, failure, 1)
  const digest = state.recentDigest()
  assert.match(digest, /^turns=4 edit_churn=2 distinct_edit_files=1 error_outputs=2 test_runs=2 repeated_identical_failures=1 stagnation=0\.50/)
  assert.match(digest, /Recent actions \(oldest->newest\):/)
  assert.match(digest, /edit a\.py/)
  assert.match(digest, /\[err#[0-9a-f]{10}\]/)
  assert.doesNotMatch(digest, /Tests are still NOT green\./)
  const withContext = state.recentDigest(24, 10)
  assert.match(withContext, /repo_context: tasks here usually RESOLVE within ~10 turns/)
  assert.match(withContext, /Tests are still NOT green\./)
  assert.match(withContext, /this trajectory is at 4 turns = 0\.4x that typical length/)
  // Leakage-safe: no file contents, only basenames and the hash.
  assert.doesNotMatch(withContext, /assert 1 == 2/)
})

test('state.recentDigest: only the last n actions are shown', () => {
  const state = new SpiralState()
  for (let i = 0; i < 30; i += 1) state.update('bash', { command: `echo ${i}` }, '', 0)
  const digest = state.recentDigest(3)
  const lines = digest.split('\n')
  assert.equal(lines.length, 2 + 3)
  assert.match(lines[2], /echo 27/)
})

test('state.snapshot: upstream snake_case signal keys', () => {
  const state = stateWith([
    ['Edit', { file_path: '/r/a.py' }, 'ok'],
    ['bash', { command: 'pytest -q' }, 'FAILED x', 1],
  ])
  assert.deepEqual(state.snapshot(), {
    turns: 2,
    edit_churn: 1,
    distinct_edit_files: 1,
    error_outputs: 1,
    test_runs: 1,
    stagnation: 0,
    repeated_fail_sigs: 0,
  })
})

test('state: toJSON/fromJSON round-trip keeps every count and the action log', () => {
  const state = new SpiralState()
  state.update('Edit', { path: '/r/a.py' }, 'ok')
  state.update('bash', { command: 'pytest -q' }, 'FAILED tests/a.py::t - AssertionError', 1)
  state.update('bash', { command: 'pytest -q' }, 'FAILED tests/a.py::t - AssertionError', 1)
  const restored = SpiralState.fromJSON(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(restored.toJSON(), state.toJSON())
  assert.equal(restored.editChurn, 1)
  assert.equal(restored.repeatedFailSigs, 1)
  assert.equal(restored.turns, 3)
})

test('state.fromJSON: malformed data degrades to a fresh state', () => {
  assert.equal(SpiralState.fromJSON(null).turns, 0)
  assert.equal(SpiralState.fromJSON('nope').turns, 0)
  assert.equal(SpiralState.fromJSON({ turns: 'x', edit_counts: [], recent: [1, 'a'] }).turns, 0)
  assert.deepEqual(SpiralState.fromJSON({ recent: [1, 'a'] }).recent, ['a'])
})
