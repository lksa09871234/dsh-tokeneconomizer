/**
 * Offline tests for the optional LLM side-call adapter.
 *
 * These mount the REAL `@deepseek-ai/cordis` and `@deepseek-ai/dsh-llm`
 * packages from the repo devDependencies and register a fake in-process
 * `LlmAdapter`, so the complete prepareCall -> stream -> BlockAssembler path is
 * exercised exactly as it runs inside DSH. No network, no model, no DSH profile.
 *
 * Run with:
 *   node --test --test-isolation=none "test/unit/dsh/sidecall.test.js"
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'

import {
  createSideCall,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_PURPOSE,
  DEFAULT_TIMEOUT_MS,
  normalizeSideCallUsage,
  SIDE_CALL_CODES,
  SIDE_CALL_SOURCE_KIND,
} from '../../../lib/dsh/sidecall.js'

/**
 * One scripted provider answer.
 * @typedef {object} FakeBehavior
 * @property {'ok'|'hang'|'error'|'finish-aborted'|'finish-error'} kind
 * @property {string} [text]
 * @property {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, totalTokens?: number}} [usage]
 * @property {string} [message]
 */

/** @type {FakeBehavior} */
const OK_BEHAVIOR = {
  kind: 'ok',
  text: 'FAKE-SIDE-CALL-TEXT',
  usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2 },
}

/** Fake provider adapter: streams text + usage chunks like a real adapter. */
class FakeAdapter extends LlmAdapter {
  /** @param {FakeBehavior} behavior */
  constructor(behavior) {
    super()
    this.behavior = behavior
    /** @type {any[]} */
    this.requests = []
  }

  /**
   * @param {any} options
   * @returns {AsyncGenerator<any>}
   */
  async *stream(options) {
    this.requests.push(options)
    const behavior = this.behavior
    if (behavior.kind === 'hang') {
      await new Promise((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('adapter aborted before start'))
          return
        }
        options.signal?.addEventListener('abort', () => reject(new Error('adapter aborted')), { once: true })
      })
      return
    }
    if (behavior.kind === 'error') {
      throw new Error(behavior.message ?? 'adapter failed')
    }
    if (behavior.kind === 'finish-aborted') {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: behavior.message ?? 'provider aborted' } } }
      return
    }
    if (behavior.kind === 'finish-error') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: behavior.message ?? 'provider error' } } }
      return
    }
    const text = behavior.text ?? 'ok'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (behavior.usage !== undefined) yield { type: 'usage', usage: behavior.usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Mount a bare Cordis app with the real LLM service and one fake provider route.
 *
 * @param {FakeBehavior} behavior
 * @param {(host: {ctx: Context, adapter: FakeAdapter}) => Promise<void>} fn
 * @returns {Promise<void>}
 */
async function withHost(behavior, fn) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new FakeAdapter(behavior)
  const registration = ctx.llm.registerAdapter(['fake'], adapter)
  try {
    await fn({ ctx, adapter })
  } finally {
    try {
      registration()
    } catch {
      /* already disposed */
    }
    await ctx.fiber.dispose()
  }
}

/**
 * An agent-like stub exposing only the session route accessors.
 *
 * @param {{id?: string, header?: () => unknown, context?: () => unknown}} options
 * @returns {any}
 */
function agentStub(options = {}) {
  return {
    session: {
      id: options.id ?? 'stub-session',
      requestHeader: options.header ?? (() => ({ config: { provider: 'fake', model: 'fake-model' } })),
      requestContext: options.context ?? (() => undefined),
    },
  }
}

const EXPLICIT = { provider: 'fake', model: 'fake-model' }

/** @returns {Promise<void>} A macrotask boundary. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test('returns text, provider usage and finish kind for a successful call', async () => {
  await withHost(OK_BEHAVIOR, async ({ ctx, adapter }) => {
    const sidecall = createSideCall(ctx)
    const result = await sidecall.call({ prompt: 'propose facts', system: 'be terse', ...EXPLICIT, maxTokens: 64 })
    assert.equal(result.ok, true)
    assert.equal(result.text, 'FAKE-SIDE-CALL-TEXT')
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2, totalTokens: 21 })
    assert.equal(result.finish, 'stop')
    assert.equal(result.provider, 'fake')
    assert.equal(result.model, 'fake-model')
    assert.equal(sidecall.activeCalls, 0)

    const sent = adapter.requests[0]
    assert.equal(sent.provider, 'fake')
    assert.equal(sent.model, 'fake-model')
    assert.equal(sent.purpose, DEFAULT_PURPOSE)
    assert.equal(sent.system, 'be terse')
    assert.equal(sent.maxTokens, 64)
    assert.equal(sent.messages.length, 1)
    assert.equal(sent.messages[0].role, 'user')
    assert.equal(sent.messages[0].content[0].type, 'text')
    assert.equal(sent.messages[0].content[0].text, 'propose facts')
    assert.equal(sent.messages[0].source.kind, SIDE_CALL_SOURCE_KIND)
    sidecall.dispose()
  })
})

test('defaults: purpose, output cap and timeout constants are the documented values', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 60_000)
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 1_024)
  assert.equal(DEFAULT_PURPOSE, 'tokeneconomizer')
  assert.equal(SIDE_CALL_SOURCE_KIND, 'tokeneconomizer')
})

test('resolves the route from agent.session.requestHeader().config and forwards sessionId', async () => {
  await withHost(OK_BEHAVIOR, async ({ ctx, adapter }) => {
    const sidecall = createSideCall(ctx)
    const agent = agentStub({ id: 'session-from-header' })
    const result = await sidecall.call({ prompt: 'p', agent })
    assert.equal(result.ok, true)
    assert.equal(adapter.requests[0].provider, 'fake')
    assert.equal(adapter.requests[0].sessionId, 'session-from-header')
    assert.equal(adapter.requests[0].purpose, 'tokeneconomizer')
    sidecall.dispose()
  })
})

test('falls back to agent.session.requestContext() when no header config exists', async () => {
  await withHost(OK_BEHAVIOR, async ({ ctx, adapter }) => {
    const sidecall = createSideCall(ctx)
    const agent = agentStub({ id: 'session-from-context', header: () => undefined, context: () => ({ provider: 'fake', model: 'fake-model' }) })
    const result = await sidecall.call({ prompt: 'p', agent })
    assert.equal(result.ok, true)
    assert.equal(adapter.requests[0].provider, 'fake')
    assert.equal(adapter.requests[0].model, 'fake-model')
    sidecall.dispose()
  })
})

test('explicit provider/model wins over the agent route', async () => {
  await withHost(OK_BEHAVIOR, async ({ ctx, adapter }) => {
    const sidecall = createSideCall(ctx)
    const agent = agentStub({ header: () => ({ config: { provider: 'not', model: 'used' } }) })
    const result = await sidecall.call({ prompt: 'p', agent, provider: 'fake', model: 'explicit-model' })
    assert.equal(result.ok, true)
    assert.equal(adapter.requests[0].provider, 'fake')
    assert.equal(adapter.requests[0].model, 'explicit-model')
    sidecall.dispose()
  })
})

test('missing route returns ok:false/no-route and does not throw or dispatch', async () => {
  await withHost(OK_BEHAVIOR, async ({ ctx, adapter }) => {
    const sidecall = createSideCall(ctx)
    const agent = agentStub({ header: () => ({ config: { provider: '', model: '' } }), context: () => ({}) })
    const result = await sidecall.call({ prompt: 'p', agent })
    assert.equal(result.ok, false)
    assert.equal(result.code, SIDE_CALL_CODES.NO_ROUTE)
    assert.match(result.error, /no provider\/model route/)
    assert.equal(adapter.requests.length, 0)
    sidecall.dispose()
  })
})

test('throwing session accessors are contained (never thrown into the caller)', async () => {
  await withHost(OK_BEHAVIOR, async ({ ctx }) => {
    const sidecall = createSideCall(ctx)
    const agent = {
      session: {
        id: 'broken',
        requestHeader() {
          throw new Error('header exploded')
        },
        requestContext() {
          throw new Error('context exploded')
        },
      },
    }
    const result = await sidecall.call({ prompt: 'p', agent })
    assert.equal(result.ok, false)
    assert.equal(result.code, SIDE_CALL_CODES.NO_ROUTE)
    await assert.doesNotReject(() => sidecall.call(/** @type {any} */ (null)))
    const inert = /** @type {any} */ (await sidecall.call(/** @type {any} */ (null)))
    assert.equal(inert.code, SIDE_CALL_CODES.INVALID_PROMPT)
    sidecall.dispose()
  })
})

test('host without ctx.llm is inert: llm-unavailable, no throw', async () => {
  const ctx = new Context()
  try {
    const sidecall = createSideCall(ctx)
    const result = await sidecall.call({ prompt: 'p', ...EXPLICIT })
    assert.equal(result.ok, false)
    assert.equal(result.code, SIDE_CALL_CODES.LLM_UNAVAILABLE)
    sidecall.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

test('unresolvable dsh-llm fails once with a clear reason and stays inert', async () => {
  await withHost(OK_BEHAVIOR, async ({ ctx, adapter }) => {
    let imports = 0
    const sidecall = createSideCall(ctx, {
      loadModule: async () => {
        imports += 1
        throw new Error('simulated missing package')
      },
    })
    const first = await sidecall.call({ prompt: 'p', ...EXPLICIT })
    const second = await sidecall.call({ prompt: 'p', ...EXPLICIT })
    assert.equal(first.ok, false)
    assert.equal(first.code, SIDE_CALL_CODES.MODULE_UNAVAILABLE)
    assert.match(first.error, /dsh-llm module/)
    assert.equal(second.ok, false)
    assert.equal(second.error, first.error)
    assert.equal(imports, 1)
    assert.equal(adapter.requests.length, 0)
    sidecall.dispose()
  })
})

test('hard timeout aborts a non-cooperative stream and cleans up', async () => {
  await withHost({ kind: 'hang' }, async ({ ctx }) => {
    const sidecall = createSideCall(ctx, { timeoutMs: 30 })
    const started = Date.now()
    const result = await sidecall.call({ prompt: 'p', ...EXPLICIT })
    const elapsed = Date.now() - started
    assert.equal(result.ok, false)
    assert.equal(result.code, SIDE_CALL_CODES.TIMEOUT)
    assert.match(result.error, /timed out after 30 ms/)
    assert.ok(elapsed < 5_000, `timeout returned in ${elapsed} ms`)
    assert.equal(sidecall.activeCalls, 0)
    assert.equal(sidecall.stats.timeouts, 1)
    sidecall.dispose()
    assert.equal(sidecall.disposed, true)
  })
})

test('caller abort cancels an in-flight call (aborted code)', async () => {
  await withHost({ kind: 'hang' }, async ({ ctx }) => {
    const sidecall = createSideCall(ctx, { timeoutMs: 0 })
    const controller = new AbortController()
    const pending = sidecall.call({ prompt: 'p', ...EXPLICIT, signal: controller.signal })
    await tick()
    controller.abort(new Error('caller cancelled'))
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.code, SIDE_CALL_CODES.ABORTED)
    assert.match(result.error, /caller cancelled/)
    assert.equal(sidecall.activeCalls, 0)
    sidecall.dispose()
  })
})

test('dispose aborts in-flight calls and makes the adapter inert', async () => {
  await withHost({ kind: 'hang' }, async ({ ctx }) => {
    const sidecall = createSideCall(ctx, { timeoutMs: 0 })
    const pending = sidecall.call({ prompt: 'p', ...EXPLICIT })
    await tick()
    sidecall.dispose()
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.code, SIDE_CALL_CODES.ABORTED)
    assert.match(result.error, /disposed while the call was in flight/)
    assert.equal(sidecall.activeCalls, 0)
    assert.equal(sidecall.stats.disposed, 0)
    const after = await sidecall.call({ prompt: 'p', ...EXPLICIT })
    assert.equal(after.ok, false)
    assert.equal(after.code, SIDE_CALL_CODES.DISPOSED)
    sidecall.dispose() // idempotent
  })
})

test('provider finish kinds error/aborted map to ok:false without throwing', async () => {
  await withHost({ kind: 'finish-error', message: 'auth failed' }, async ({ ctx }) => {
    const sidecall = createSideCall(ctx)
    const result = await sidecall.call({ prompt: 'p', ...EXPLICIT })
    assert.equal(result.ok, false)
    assert.equal(result.code, SIDE_CALL_CODES.FINISH_ERROR)
    assert.match(result.error, /auth failed/)
    sidecall.dispose()
  })
  await withHost({ kind: 'finish-aborted', message: 'provider stopped' }, async ({ ctx }) => {
    const sidecall = createSideCall(ctx)
    const result = await sidecall.call({ prompt: 'p', ...EXPLICIT })
    assert.equal(result.ok, false)
    assert.equal(result.code, SIDE_CALL_CODES.FINISH_ERROR)
    assert.match(result.error, /provider stopped/)
    sidecall.dispose()
  })
})

test('adapter failures are normalized to a redacted ok:false and never thrown', async () => {
  const secret = 'sk-abcdefgh12345678 Authorization: Bearer abcdefghijklmnop'
  await withHost({ kind: 'error', message: `provider exploded token ${secret}` }, async ({ ctx, adapter }) => {
    const sidecall = createSideCall(ctx)
    // dsh-llm normalizes an adapter throw into a terminal `finish` error chunk,
    // so the adapter surfaces it as FINISH_ERROR rather than rejecting.
    const result = await sidecall.call({ prompt: 'p', ...EXPLICIT })
    assert.equal(result.ok, false)
    assert.equal(result.code, SIDE_CALL_CODES.FINISH_ERROR)
    assert.equal(adapter.requests.length, 1)
    assert.match(result.error, /provider exploded/)
    assert.doesNotMatch(result.error, /sk-abcdefgh/)
    assert.doesNotMatch(result.error, /Bearer abcdef/)
    assert.equal(sidecall.activeCalls, 0)
    sidecall.dispose()
  })
})

test('normalizeSideCallUsage fills totalTokens, clamps invalid values', () => {
  assert.deepEqual(normalizeSideCallUsage({ inputTokens: 4, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 1 }), {
    inputTokens: 4,
    outputTokens: 2,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    totalTokens: 8,
  })
  assert.deepEqual(normalizeSideCallUsage({ inputTokens: 9, outputTokens: 1, totalTokens: 99 }), {
    inputTokens: 9,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 99,
  })
  assert.deepEqual(normalizeSideCallUsage(undefined), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  })
  assert.deepEqual(normalizeSideCallUsage({ inputTokens: -3, outputTokens: Number.NaN, cacheReadTokens: 2 }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    totalTokens: 2,
  })
})
