/**
 * Offline tests for the micro-skills model proposer (`lib/dsh/proposer.js`).
 * Digests/validation are pure; `proposeFacts` receives a fake sidecall object,
 * so no model, network, or DSH profile is involved.
 *
 * Run with:
 *   node --test --test-isolation=none "test/unit/dsh/proposer.test.js"
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DIGEST_MAX_CHARS,
  PROPOSER_SYSTEM,
  buildDigest,
  buildPrompt,
  proposeFacts,
  validateProposals,
} from '../../../lib/dsh/proposer.js'

/** @type {import('../../../lib/dsh/proposer.js').SessionSnapshot} */
const SESSION_A = {
  sessionId: 'sess-a',
  cwd: '/home/alice/repo',
  prompts: 3,
  calls: [
    { tool: 'bash', args: { command: 'npm test -- --runInBand' }, resultText: 'Tests: 3 failed, 12 passed', failed: true, exitCode: 1 },
    { tool: 'bash', args: { command: 'pytest /home/alice/repo/tests/test_api.py' }, resultText: "E   ModuleNotFoundError: No module named 'requests'", failed: true, exitCode: 1 },
    { tool: 'bash', args: { command: 'git status --short' }, resultText: ' M src/app.py', failed: false, exitCode: 0 },
  ],
}

/** @type {import('../../../lib/dsh/proposer.js').SessionSnapshot} */
const SESSION_B = {
  sessionId: 'sess-b',
  cwd: '/home/alice/repo',
  prompts: 1,
  calls: [
    { tool: 'bash', args: { command: 'pytest tests/test_api.py' }, resultText: "E   ModuleNotFoundError: No module named 'requests'", failed: true, exitCode: 1 },
    { tool: 'bash', args: { command: 'npm test' }, resultText: 'ok 42 tests passed', failed: false, exitCode: 0 },
  ],
}

const VALID_CLAIM = 'pytest cannot import requests so the api tests fail in this repo'
const VALID_JSON = JSON.stringify({
  facts: [{ claim: VALID_CLAIM, checks: ['requests'], cites: ['sess-a', 'sess-b'] }],
})

/** @param {any} override @returns {string} */
function replyWith(override) {
  return JSON.stringify({ facts: [override] })
}

/**
 * Fake sidecall recording requests.
 *
 * @param {(request: any) => any} handler
 * @returns {{calls: any[], call: (request: any) => Promise<any>}}
 */
function fakeSidecall(handler) {
  /** @type {any[]} */
  const calls = []
  return {
    calls,
    async call(request) {
      calls.push(request)
      return handler(request)
    },
  }
}

test('buildDigest is bounded, includes ids/flags, and leaks no paths or raw output', () => {
  const digest = buildDigest([SESSION_A, SESSION_B])
  assert.equal(typeof digest, 'string')
  assert.ok(digest.length <= DIGEST_MAX_CHARS)
  assert.match(digest, /sess-a/)
  assert.match(digest, /sess-b/)
  assert.match(digest, /prompts=3/)
  assert.match(digest, /ran_tests=true/)
  assert.match(digest, /missing_dependency=true/)
  assert.match(digest, /missing_command=false/)
  assert.match(digest, /bad_usage=false/)
  assert.match(digest, /\.\/tests\/test_api\.py/) // cwd replaced with '.'
  assert.doesNotMatch(digest, /\/home\/alice/)
  assert.doesNotMatch(digest, /alice/)
  assert.doesNotMatch(digest, / M src\/app\.py/) // non-failed result text is never included
  assert.match(digest, /<n>/) // numbers masked in error signatures
})

test('buildDigest masks absolute paths and long raw output, respects per-session caps and maxSessions', () => {
  /** @type {import('../../../lib/dsh/proposer.js').SessionSnapshot} */
  const noisy = {
    sessionId: 'sess-noisy',
    cwd: 'C:\\Users\\alice\\repo',
    prompts: 1,
    calls: Array.from({ length: 10 }, (_value, index) => ({
      tool: 'bash',
      args: { command: index === 0 ? 'node C:\\Users\\alice\\repo\\tool.js --check' : `echo step-${index}` },
      resultText: index === 0 ? `Error: boom ${'X'.repeat(500)}` : '',
      failed: index === 0,
      exitCode: index === 0 ? 1 : 0,
    })),
  }
  const digest = buildDigest([noisy])
  assert.ok(digest.length <= DIGEST_MAX_CHARS)
  assert.doesNotMatch(digest, /C:\\Users/)
  assert.doesNotMatch(digest, /alice/)
  assert.doesNotMatch(digest, /X{200}/)
  const commandLines = digest.split('\n').filter((line) => line.startsWith('  cmds:'))
  assert.equal(commandLines.length, 1)
  const templates = (commandLines[0] ?? '').split(' | ')
  assert.ok(templates.length <= 6, `expected <=6 command templates, got ${templates.length}`)
  assert.ok(digest.indexOf('step-1') >= 0)

  /** @type {import('../../../lib/dsh/proposer.js').SessionSnapshot[]} */
  const many = Array.from({ length: 12 }, (_value, index) => ({
    sessionId: `sess-${index}`,
    prompts: 1,
    calls: [{ tool: 'bash', args: { command: `npm test ${index}` }, resultText: 'ok 1 passed', failed: false, exitCode: 0 }],
  }))
  const recent = buildDigest(many)
  assert.match(recent, /sess-11/)
  assert.match(recent, /sess-4/)
  assert.doesNotMatch(recent, /sess-0\b/)
  assert.doesNotMatch(recent, /sess-3\b/)
})

test('buildDigest honors the maxChars cap', () => {
  const digest = buildDigest([SESSION_A, SESSION_B], { maxChars: 100 })
  assert.ok(digest.length <= 100, `digest length ${digest.length}`)
})

test('buildPrompt returns a strict JSON-only instruction and includes existing claims', () => {
  const digest = buildDigest([SESSION_A, SESSION_B])
  const { system, prompt } = buildPrompt(digest, ['an older manual fact about make targets'])
  assert.match(system, /ONLY a JSON object/)
  assert.match(system, /"facts"/)
  assert.match(system, /at least 2 session ids/)
  assert.match(system, /Never use these words/)
  assert.match(prompt, /untrusted data/i)
  assert.ok(prompt.includes(digest))
  assert.match(prompt, /DO NOT propose these again/)
  assert.match(prompt, /an older manual fact about make targets/)
  const plain = buildPrompt(digest)
  assert.doesNotMatch(plain.prompt, /DO NOT propose these again/)
})

test('validateProposals accepts an evidence-backed fact with a stable manual id', () => {
  const result = validateProposals(VALID_JSON, { snapshots: [SESSION_A, SESSION_B], existing: [] })
  assert.equal(result.ok, true)
  assert.equal(result.proposals.length, 1)
  const proposal = result.proposals[0]
  assert.match(proposal.id, /^manual:[0-9a-f]{12}$/)
  assert.equal(proposal.claim, VALID_CLAIM)
  assert.deepEqual(proposal.checks, ['requests'])
  assert.deepEqual(proposal.cites, ['sess-a', 'sess-b'])
  const again = validateProposals(VALID_JSON, { snapshots: [SESSION_A, SESSION_B], existing: [] })
  assert.equal(again.proposals[0].id, proposal.id, 'id is derived from the claim')
})

test('validateProposals lowercases checks and accepts multi-check facts with repeated support', () => {
  const raw = replyWith({
    claim: 'pytest runs in this repo fail while the requests package is missing',
    checks: ['REQUESTS', 'pytest'],
    cites: ['sess-a', 'sess-b'],
  })
  const result = validateProposals(raw, { snapshots: [SESSION_A, SESSION_B], existing: [] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.proposals[0].checks, ['requests', 'pytest'])
})

test('validateProposals rejects unsupported cites, unknown cites and single-session evidence', () => {
  const oneCite = validateProposals(replyWith({ claim: VALID_CLAIM, checks: ['requests'], cites: ['sess-a'] }), { snapshots: [SESSION_A, SESSION_B] })
  assert.equal(oneCite.ok, false)
  assert.equal(oneCite.error, 'no-valid-proposals')
  const unknownCite = validateProposals(replyWith({ claim: VALID_CLAIM, checks: ['requests'], cites: ['sess-a', 'sess-z'] }), { snapshots: [SESSION_A, SESSION_B] })
  assert.equal(unknownCite.ok, false)
  const singleEvidence = validateProposals(replyWith({
    claim: 'git status is used to inspect pending changes in this repository',
    checks: ['git status'],
    cites: ['sess-a', 'sess-b'],
  }), { snapshots: [SESSION_A, SESSION_B] })
  assert.equal(singleEvidence.ok, false, 'a check supported by only one cited session is not repeated evidence')
})

test('validateProposals rejects unsupported checks and advice-style claims', () => {
  const unsupported = validateProposals(replyWith({ claim: VALID_CLAIM, checks: ['nonexistenttoken'], cites: ['sess-a', 'sess-b'] }), { snapshots: [SESSION_A, SESSION_B] })
  assert.equal(unsupported.ok, false)
  for (const claim of [
    'Do not run pytest before installing requests here',
    'Verify that requests is installed before running the api tests',
    'Stop repeating pytest failures for the requests module',
    'requests',
    `${VALID_CLAIM} ${'a'.repeat(250)}`,
  ]) {
    const result = validateProposals(replyWith({ claim, checks: ['requests'], cites: ['sess-a', 'sess-b'] }), { snapshots: [SESSION_A, SESSION_B] })
    assert.equal(result.ok, false, `claim should be rejected: ${claim.slice(0, 40)}`)
  }
})

test('validateProposals enforces check count and length bounds', () => {
  const tooShort = validateProposals(replyWith({ claim: VALID_CLAIM, checks: ['req'], cites: ['sess-a', 'sess-b'] }), { snapshots: [SESSION_A, SESSION_B] })
  assert.equal(tooShort.ok, false)
  const tooLong = validateProposals(replyWith({ claim: VALID_CLAIM, checks: [`${'a'.repeat(81)}`], cites: ['sess-a', 'sess-b'] }), { snapshots: [SESSION_A, SESSION_B] })
  assert.equal(tooLong.ok, false)
  const fiveChecks = validateProposals(replyWith({ claim: VALID_CLAIM, checks: ['requests', 'pytest', 'npm', 'test', 'failed'], cites: ['sess-a', 'sess-b'] }), { snapshots: [SESSION_A, SESSION_B] })
  assert.equal(fiveChecks.ok, false)
})

test('validateProposals dedupes against existing facts and returns max 4 proposals', () => {
  const first = validateProposals(VALID_JSON, { snapshots: [SESSION_A, SESSION_B] })
  const existingId = first.proposals[0].id
  const byId = validateProposals(VALID_JSON, { snapshots: [SESSION_A, SESSION_B], existing: [{ id: existingId, claim: VALID_CLAIM }] })
  assert.equal(byId.ok, false, 'same id is deduped')
  const byClaim = validateProposals(VALID_JSON, { snapshots: [SESSION_A, SESSION_B], existing: [{ id: 'manual:000000000000', claim: VALID_CLAIM }] })
  assert.equal(byClaim.ok, false, 'same claim text is deduped')

  const claims = [
    'pytest cannot import requests so the api test fails in this repo',
    'the requests python package is missing from this environment here',
    'api tests using requests fail at import time in this checkout',
    'running pytest surfaces a missing requests dependency in the api tests',
    'the api test module imports requests which is not available locally',
  ]
  const many = JSON.stringify({
    facts: claims.map((claim) => ({ claim, checks: ['requests'], cites: ['sess-a', 'sess-b'] })),
  })
  const capped = validateProposals(many, { snapshots: [SESSION_A, SESSION_B] })
  assert.equal(capped.ok, true)
  assert.equal(capped.proposals.length, 4)
})

test('validateProposals reports unusable replies without throwing', () => {
  assert.deepEqual(validateProposals('not json', { snapshots: [SESSION_A, SESSION_B] }), { ok: false, proposals: [], error: 'no-json' })
  assert.equal(validateProposals('{"facts": [}', { snapshots: [SESSION_A, SESSION_B] }).error, 'malformed-json')
  assert.equal(validateProposals('{"facts": "nope"}', { snapshots: [SESSION_A, SESSION_B] }).error, 'malformed-json')
  assert.doesNotThrow(() => validateProposals(/** @type {any} */ (null), {}))
  assert.deepEqual(validateProposals('', {}), { ok: false, proposals: [], error: 'no-json' })
})

test('proposeFacts returns proposals plus provider usage for the ledger', async () => {
  const sidecall = fakeSidecall(() => ({
    ok: true,
    text: VALID_JSON,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, totalTokens: 18 },
  }))
  const result = await proposeFacts({ sidecall, snapshots: [SESSION_A, SESSION_B], existing: [], maxFacts: 4 })
  assert.equal(result.ok, true)
  assert.equal(result.proposals.length, 1)
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, totalTokens: 18 })
  assert.equal(sidecall.calls.length, 1)
  assert.equal(sidecall.calls[0].system, PROPOSER_SYSTEM)
  assert.match(sidecall.calls[0].prompt, /sess-a/)
  assert.match(sidecall.calls[0].prompt, /untrusted data/i)
})

test('proposeFacts caps proposals at maxFacts', async () => {
  const claims = [
    'pytest cannot import requests so the api test fails in this repo',
    'the requests python package is missing from this environment here',
  ]
  const sidecall = fakeSidecall(() => ({
    ok: true,
    text: JSON.stringify({ facts: claims.map((claim) => ({ claim, checks: ['requests'], cites: ['sess-a', 'sess-b'] })) }),
    usage: { inputTokens: 1, outputTokens: 1 },
  }))
  const result = await proposeFacts({ sidecall, snapshots: [SESSION_A, SESSION_B], maxFacts: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.proposals.length, 1)
})

test('proposeFacts never throws on failure, no JSON, or too few snapshots', async () => {
  const failing = fakeSidecall(() => ({ ok: false, code: 'timeout', error: 'side call timed out after 50 ms' }))
  const failed = await proposeFacts({ sidecall: failing, snapshots: [SESSION_A, SESSION_B] })
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.proposals, [])
  assert.deepEqual(failed.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 })
  assert.match(String(failed.error), /timed out/)

  const garbage = fakeSidecall(() => ({ ok: true, text: 'no json here', usage: { inputTokens: 2, outputTokens: 1 } }))
  const invalid = await proposeFacts({ sidecall: garbage, snapshots: [SESSION_A, SESSION_B] })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error, 'no-json')
  assert.equal(invalid.usage.totalTokens, 3)

  const throwing = fakeSidecall(() => {
    throw new Error('adapter exploded token sk-abcdefgh12345678')
  })
  const thrown = await proposeFacts({ sidecall: throwing, snapshots: [SESSION_A, SESSION_B] })
  assert.equal(thrown.ok, false)
  assert.match(String(thrown.error), /proposer call failed/)
  assert.doesNotMatch(String(thrown.error), /sk-abcdefgh/)

  const notCalled = fakeSidecall(() => ({ ok: true, text: VALID_JSON }))
  const tooFew = await proposeFacts({ sidecall: notCalled, snapshots: [SESSION_A] })
  assert.equal(tooFew.ok, false)
  assert.equal(tooFew.error, 'insufficient-snapshots')
  assert.equal(notCalled.calls.length, 0)

  const noSidecall = await proposeFacts({ snapshots: [SESSION_A, SESSION_B] })
  assert.equal(noSidecall.ok, false)
  assert.equal(noSidecall.error, 'sidecall-unavailable')
})
