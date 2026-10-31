import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  JUDGE_REASON_MAX_CHARS,
  NUDGE_MAX_CHARS,
  NUDGE_WRITER_SYSTEM,
  STUCK_JUDGE_SYSTEM,
  buildNudgeWriterPrompt,
  buildStuckJudgePrompt,
  parseNudgeWriterReply,
  parseStuckJudgeReply,
} from '../../../lib/loopguard/judge.js'

const DIGEST = 'turns=25 edit_churn=6 distinct_edit_files=1 error_outputs=9 test_runs=9 '
  + 'repeated_identical_failures=8 stagnation=0.89\nRecent actions (oldest->newest):\n'
  + '  1: edit a.py\n  2: $ pytest -q  [err#0123456789]'

test('judge.prompts: builders embed the leakage-safe digest and the internal prompts', () => {
  assert.equal(
    buildStuckJudgePrompt(DIGEST),
    `${STUCK_JUDGE_SYSTEM}\n\nRecent process digest:\n${DIGEST}\n\nReturn the JSON verdict:`,
  )
  assert.equal(
    buildNudgeWriterPrompt(DIGEST),
    `${NUDGE_WRITER_SYSTEM}\n\nRecent process digest:\n${DIGEST}\n\nWrite the redirect:`,
  )
  // The judge prompt tells the model to judge workflow only and to emit JSON.
  assert.match(STUCK_JUDGE_SYSTEM, /Judge ONLY the workflow from the digest/)
  assert.match(STUCK_JUDGE_SYSTEM, /Favor SPARING \(stuck=false\)/)
  assert.match(STUCK_JUDGE_SYSTEM, /\{"stuck": bool, "confidence": <0\.0-1\.0>, "reason":/)
  // The writer prompt carries the never-stop hard constraints.
  assert.match(NUDGE_WRITER_SYSTEM, /Do NOT tell it to stop, give up, or reduce effort/)
  assert.match(NUDGE_WRITER_SYSTEM, /Output ONLY the redirect as plain text/)
  // Both call the digest leakage-safe.
  assert.match(STUCK_JUDGE_SYSTEM, /leakage-safe/)
  assert.match(NUDGE_WRITER_SYSTEM, /never file contents or the task description/)
})

test('judge.parseStuckJudgeReply: parses the JSON verdict and clamps its fields', () => {
  assert.deepEqual(
    parseStuckJudgeReply('{"stuck": true, "confidence": 0.82, "reason": "same edit/test loop"}'),
    { stuck: true, confidence: 0.82, reason: 'same edit/test loop' },
  )
  assert.deepEqual(
    parseStuckJudgeReply('verdict:\n```json\n{"stuck": false, "confidence": 0.4, "reason": "progress"}\n```'),
    { stuck: false, confidence: 0.4, reason: 'progress' },
  )
  // Missing fields default; `stuck: null` is the explicit ambiguity signal.
  assert.deepEqual(parseStuckJudgeReply('{"stuck": null}'), { stuck: null, confidence: 0, reason: '' })
  assert.deepEqual(parseStuckJudgeReply('{}'), { stuck: null, confidence: 0, reason: '' })
  // Confidence is clamped to 0..1.
  assert.equal(parseStuckJudgeReply('{"stuck": true, "confidence": 4}')?.confidence, 1)
  assert.equal(parseStuckJudgeReply('{"stuck": true, "confidence": -2}')?.confidence, 0)
  // The reason is capped (upstream [:160]).
  const longReason = 'x'.repeat(500)
  assert.equal(
    parseStuckJudgeReply(`{"stuck": true, "confidence": 1, "reason": "${longReason}"}`)?.reason.length,
    JUDGE_REASON_MAX_CHARS,
  )
})

test('judge.parseStuckJudgeReply: any failure returns null so the envelope fallback keeps the call', () => {
  assert.equal(parseStuckJudgeReply(''), null)
  assert.equal(parseStuckJudgeReply('I think it is stuck.'), null)
  assert.equal(parseStuckJudgeReply('{not json}'), null)
  assert.equal(parseStuckJudgeReply('{"stuck": "yes"}'), null) // strict boolean
  assert.equal(parseStuckJudgeReply('{"stuck": true, "confidence": "high"}'), null)
  assert.equal(parseStuckJudgeReply('{"stuck": true, "confidence": 0.9, "reason": 7}'), null)
  assert.equal(parseStuckJudgeReply(null), null)
  assert.equal(parseStuckJudgeReply(42), null)
})

test('judge.parseNudgeWriterReply: plain text only, trimmed and capped', () => {
  assert.equal(
    parseNudgeWriterReply('  Read the failing assertion before editing again.  '),
    'Read the failing assertion before editing again.',
  )
  assert.equal(parseNudgeWriterReply(''), null)
  assert.equal(parseNudgeWriterReply('   '), null)
  assert.equal(parseNudgeWriterReply(null), null)
  assert.equal(parseNudgeWriterReply(7), null)
  assert.equal(parseNudgeWriterReply('y'.repeat(NUDGE_MAX_CHARS + 500))?.length, NUDGE_MAX_CHARS)
})

test('judge.prompts: no network and no credential surface (pure module)', () => {
  // The module exports builders/parsers only; a runner is the adapter's job.
  const text = `${STUCK_JUDGE_SYSTEM}\n${NUDGE_WRITER_SYSTEM}`
  assert.doesNotMatch(text, /api[_-]?key|authorization|bearer/i)
})
