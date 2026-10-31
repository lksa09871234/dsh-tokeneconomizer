import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  catalogFromHeader,
  contentToText,
  exitCodeFromResult,
  isHumanPromptSource,
  normalizeToolCall,
  normalizeUsage,
  parseArguments,
  toolFamily,
} from '../../../lib/dsh/normalize.js'

test('parseArguments parses JSON strings and tolerates garbage', () => {
  assert.deepEqual(parseArguments('{"command":"ls"}'), { command: 'ls' })
  assert.deepEqual(parseArguments({ command: 'ls' }), { command: 'ls' })
  assert.deepEqual(parseArguments('not json'), {})
  assert.deepEqual(parseArguments('[1,2]'), {})
  assert.deepEqual(parseArguments(undefined), {})
})

test('contentToText renders text and marks non-text blocks', () => {
  assert.equal(contentToText([{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }]), 'hello\nworld')
  assert.equal(contentToText([{ type: 'image' }]), '[image]')
  assert.equal(contentToText([]), '')
  assert.equal(contentToText('plain'), 'plain')
})

test('exitCodeFromResult prefers meta and falls back to rendered text', () => {
  assert.equal(exitCodeFromResult('', { exitCode: 2 }), 2)
  assert.equal(exitCodeFromResult('command failed\nexit code: 127', undefined), 127)
  assert.equal(exitCodeFromResult('all good', undefined), null)
})

test('normalizeToolCall pairs call and result', () => {
  const call = normalizeToolCall(
    { callId: 'c1', name: 'bash', arguments: '{"command":"python -m pytest"}' },
    { message: { content: [{ type: 'text', text: 'exit code: 1' }], isError: true }, meta: { exitCode: 1 } },
  )
  assert.equal(call.tool, 'bash')
  assert.deepEqual(call.args, { command: 'python -m pytest' })
  assert.equal(call.failed, true)
  assert.equal(call.exitCode, 1)
  assert.equal(call.callId, 'c1')
  assert.equal(call.resultText, 'exit code: 1')
})

test('normalizeUsage keeps cache categories disjoint and rejects empty usage', () => {
  const usage = normalizeUsage({ usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 2 } })
  assert.deepEqual(usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 2, reasoningTokens: 0, totalTokens: 0 })
  assert.equal(normalizeUsage({ usage: { inputTokens: 0, outputTokens: 0 } }), null)
  assert.equal(normalizeUsage({}), null)
})

test('catalogFromHeader extracts names and descriptions', () => {
  const catalog = catalogFromHeader({ tools: [{ name: 'bash', description: 'run' }, { name: 'read', description: 'read' }] })
  assert.deepEqual(catalog, [{ name: 'bash', description: 'run' }, { name: 'read', description: 'read' }])
  assert.deepEqual(catalogFromHeader({}), [])
})

test('only human prompts count as prompts', () => {
  assert.equal(isHumanPromptSource({ kind: 'user' }), true)
  assert.equal(isHumanPromptSource({ kind: 'tokeneconomizer' }), false)
  assert.equal(isHumanPromptSource(undefined), false)
})

test('toolFamily maps built-in and ops tool names', () => {
  assert.equal(toolFamily('bash'), 'bash')
  assert.equal(toolFamily('ops_bash'), 'bash')
  assert.equal(toolFamily('read'), 'view')
  assert.equal(toolFamily('read_file'), 'view')
  assert.equal(toolFamily('ops_edit_file'), 'edit')
  assert.equal(toolFamily('write_file'), 'create')
  assert.equal(toolFamily('grep'), 'grep')
  assert.equal(toolFamily('glob'), 'glob')
  assert.equal(toolFamily('todo_write'), 'other')
})
