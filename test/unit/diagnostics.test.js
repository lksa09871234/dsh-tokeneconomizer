import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { appendBounded, readDiagnostics, redactText, writeDiagnostic } from '../../lib/diagnostics.js'

/** @returns {string} */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'te-diag-'))
}

test('redactText removes tokens, credentials, emails and personal paths', () => {
  const input = [
    'key sk-abcdefgh12345678',
    'token=ghp_abcdefghijklmnop1234567890',
    'Authorization: Bearer abcdefghijklmnop',
    'api_key: "super-secret-value"',
    'mail someone@example.com',
    'path C:\\Users\\alice\\project\\file.txt',
    'path /home/bob/private.txt',
  ].join('\n')
  const output = redactText(input)
  assert.doesNotMatch(output, /sk-abcdefgh/)
  assert.doesNotMatch(output, /ghp_abcdefgh/)
  assert.doesNotMatch(output, /Bearer abcdef/)
  assert.doesNotMatch(output, /super-secret-value/)
  assert.doesNotMatch(output, /someone@example\.com/)
  assert.doesNotMatch(output, /alice/)
  assert.doesNotMatch(output, /bob/)
})

test('redactText caps length and strips control characters', () => {
  const output = redactText(`a\u0000b${'x'.repeat(40)}`, 12)
  assert.equal(output.length, 13) // 12 kept + ellipsis
  assert.doesNotMatch(output, /\u0000/)
})

test('writeDiagnostic persists bounded redacted JSONL records', () => {
  const dir = tempDir()
  assert.equal(writeDiagnostic(dir, { level: 'warn', scope: 'hooks', message: 'failed token=abc123456', error: 'at sk-abcdefgh1234' }, 4096), true)
  const records = readDiagnostics(dir)
  assert.equal(records.length, 1)
  assert.equal(records[0].level, 'warn')
  assert.equal(records[0].scope, 'hooks')
  assert.match(String(records[0].message), /token=\[redacted\]/)
})

test('appendBounded keeps the newest records under the byte cap', () => {
  const dir = tempDir()
  const file = path.join(dir, 'diag.jsonl')
  for (let i = 0; i < 50; i += 1) {
    appendBounded(file, { i, padding: 'x'.repeat(40) }, 600)
  }
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.ok(Buffer.byteLength(lines.join('\n'), 'utf8') <= 600)
  assert.match(lines.at(-1) ?? '', /"i":49/)
})

test('readDiagnostics tolerates a torn trailing line and a missing file', () => {
  const dir = tempDir()
  assert.deepEqual(readDiagnostics(dir), [])
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'diagnostics.jsonl'), '{"level":"info"}\n{"broken":', 'utf8')
  const records = readDiagnostics(dir)
  assert.equal(records.length, 1)
  assert.equal(records[0].level, 'info')
})
