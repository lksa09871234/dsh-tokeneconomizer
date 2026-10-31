import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseArgs } from '../../bin/te.js'

test('parseArgs accepts the documented command line', () => {
  assert.deepEqual(parseArgs(['status', '--json']), { command: 'status', rest: ['--json'], options: {} })
  assert.deepEqual(parseArgs(['toolprune', 'apply', '--cwd', 'C:\\repo']), {
    command: 'toolprune',
    rest: ['apply'],
    options: { cwd: 'C:\\repo' },
  })
  assert.deepEqual(parseArgs(['--data-dir=state', 'usage']), { command: 'usage', rest: [], options: { 'data-dir': 'state' } })
})

test('parseArgs passes reset --yes to the command instead of rejecting it', () => {
  const parsed = parseArgs(['--data-dir', 'state', 'reset', '--yes'])
  assert.equal(parsed.command, 'reset')
  assert.deepEqual(parsed.rest, ['--yes'])
  assert.deepEqual(parsed.options, { 'data-dir': 'state' })
  assert.deepEqual(parseArgs(['reset', '-y']).rest, ['-y'])
})

test('parseArgs reports missing option values and unknown options', () => {
  assert.match(String(parseArgs(['status', '--cwd']).error), /needs a value/)
  assert.match(String(parseArgs(['status', '--bogus']).error), /unknown option/)
})

test('parseArgs defaults to the status command', () => {
  assert.equal(parseArgs([]).command, 'status')
})
