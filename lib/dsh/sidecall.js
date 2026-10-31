/**
 * Optional model side calls ("proposer" / "judge") for dsh-tokeneconomizer.
 *
 * This is the plugin's only supported path for model-assisted features that are
 * not part of an agent turn. It is a thin, defensive wrapper over the harness's
 * `ctx.llm` service (the same service the agent loop and the shipped
 * session-title provider use), so it never opens a network connection itself and
 * never creates an agent turn.
 *
 * Design contract:
 *
 * - `createSideCall(ctx, options)` returns one reusable adapter bound to a host
 *   context. It is inert until the first `call()`.
 * - `call(request)` resolves its route from (1) explicit `provider`+`model`,
 *   (2) `agent.session.requestHeader()?.config`, (3) `agent.session.requestContext()`.
 * - Every call is bounded by a hard timeout (default 60 s) and cooperatively
 *   cancelled through the caller's `signal`. Both are fused into one
 *   `AbortSignal` that is handed to `ctx.llm` and to the stream consumer; the
 *   consumer also races the provider iterator against the signal, so an adapter
 *   that ignores cancellation cannot outlive the deadline.
 * - It NEVER throws into a caller/session. Every failure is
 *   `{ ok: false, code, error }` with the error text redacted.
 * - It never logs or returns prompts, system text, or credentials; the caller
 *   owns prompt construction and any persistence of prompt material.
 * - Timers and abort listeners are cleaned up in `finally`; `dispose()` aborts
 *   in-flight calls and is registered as a context effect so plugin unload
 *   releases everything.
 *
 * Reference implementation of the same harness API:
 * `@deepseek-ai/dsh-session-title-llm` `executeSessionTitleLlm()`.
 * API contract: `research/DSH-API.md` §7 and §11.
 *
 * @module dsh-tokeneconomizer/dsh/sidecall
 */

import { redactText } from '../diagnostics.js'

/**
 * @typedef {import('@deepseek-ai/cordis').Context} Context
 * @typedef {typeof import('@deepseek-ai/dsh-llm')} DshLlmModule
 * @typedef {import('@deepseek-ai/dsh-llm').BlockAssembler} BlockAssembler
 * @typedef {import('@deepseek-ai/dsh-llm').LlmRuntime} LlmRuntime
 */

/**
 * @typedef {object} SideCallUsage
 * @property {number} inputTokens Uncached input tokens reported by the provider.
 * @property {number} outputTokens Output tokens reported by the provider.
 * @property {number} cacheReadTokens Cache-read tokens (0 when unreported).
 * @property {number} cacheWriteTokens Cache-write tokens (0 when unreported).
 * @property {number} totalTokens Sum of the four fields above when the provider omitted a total.
 */

/**
 * @typedef {object} SideCallSuccess
 * @property {true} ok
 * @property {string} text Joined text blocks of the assistant answer (may be '').
 * @property {SideCallUsage} usage Provider-reported usage, zero-filled when unreported.
 * @property {string} finish Terminal finish kind (`stop`, `max-tokens`, `tool-calls`).
 * @property {string} provider Route provider actually used.
 * @property {string} model Route model actually used.
 */

/**
 * @typedef {object} SideCallFailure
 * @property {false} ok
 * @property {string} code Stable failure code (see {@link SIDE_CALL_CODES}).
 * @property {string} error Redacted, single-line diagnostic. Never contains prompt text.
 */

/** @typedef {SideCallSuccess | SideCallFailure} SideCallResult */

/**
 * A live agent handle, or anything exposing the same session route accessors.
 * Kept structural so unit tests can pass a stub without importing dsh-agent.
 * @typedef {object} AgentLike
 * @property {{requestHeader?: () => {config?: {provider?: unknown, model?: unknown} | null} | null | undefined, requestContext?: () => {provider?: unknown, model?: unknown} | null | undefined} | null | undefined} [session]
 */

/**
 * @typedef {object} SideCallRequest
 * @property {string} prompt User-prompt text. Required, non-empty.
 * @property {string} [system] Optional system instruction. Omitted when empty.
 * @property {number} [maxTokens] Per-request output cap; overrides `maxOutputTokens`.
 * @property {string} [provider] Explicit route provider (requires `model`).
 * @property {string} [model] Explicit route model (requires `provider`).
 * @property {string} [sessionId] Session identity recorded with the request; defaults to the agent session id.
 * @property {AgentLike} [agent] Live agent whose logged route may be used.
 * @property {AbortSignal} [signal] Caller cancellation; aborts the provider stream.
 */

/**
 * @typedef {object} SideCallOptions
 * @property {number} [timeoutMs] Hard per-call timeout; default {@link DEFAULT_TIMEOUT_MS}. `0` disables (not recommended).
 * @property {string} [purpose] Request purpose tag; default {@link DEFAULT_PURPOSE}.
 * @property {number} [maxOutputTokens] Default output-token cap; default {@link DEFAULT_MAX_OUTPUT_TOKENS}.
 * @property {(specifier: string) => Promise<DshLlmModule>} [loadModule] Test/advanced seam for the lazy dsh-llm import.
 */

/**
 * @typedef {object} SideCallAdapter
 * @property {(request: SideCallRequest) => Promise<SideCallResult>} call Run one bounded side call.
 * @property {() => void} dispose Abort in-flight calls and make the adapter inert (idempotent).
 * @property {boolean} disposed Whether {@link SideCallAdapter.dispose} ran.
 * @property {number} activeCalls Number of calls currently awaiting the provider.
 * @property {{calls:number, ok:number, failures:number, timeouts:number, aborts:number, disposed:number}} stats Lifetime counters (read-only snapshot).
 */

/**
 * Stable failure codes. Additive only; callers route on the code, never on text.
 * @readonly
 */
export const SIDE_CALL_CODES = Object.freeze({
  DISPOSED: 'disposed',
  INVALID_PROMPT: 'invalid-prompt',
  LLM_UNAVAILABLE: 'llm-unavailable',
  MODULE_UNAVAILABLE: 'module-unavailable',
  NO_ROUTE: 'no-route',
  TIMEOUT: 'timeout',
  ABORTED: 'aborted',
  FINISH_ERROR: 'finish-error',
  ERROR: 'error',
})

/** Default hard timeout for one side call (milliseconds). */
export const DEFAULT_TIMEOUT_MS = 60_000
/** Default output-token cap for one side call. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1_024
/** Default request purpose tag recorded by the LLM service. */
export const DEFAULT_PURPOSE = 'tokeneconomizer'
/** `MessageSource.kind` identifying side-call prompts in a session log. */
export const SIDE_CALL_SOURCE_KIND = 'tokeneconomizer'

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error ?? 'unknown error')
}

/** @param {AbortSignal} signal @returns {Error} */
function abortReason(signal) {
  const reason = signal.reason
  return reason instanceof Error ? reason : new Error('aborted')
}

/**
 * Race one promise against an abort signal, removing the listener in every
 * outcome so a long-lived caller signal does not accumulate listeners.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    /** @returns {void} */
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Normalize provider usage to the plugin ledger keys.
 *
 * Undefined, negative, or non-finite values become 0; `totalTokens` is summed
 * from the four buckets when the provider did not report one.
 *
 * @param {unknown} usage Raw `BlockAssembler.usage` value.
 * @returns {SideCallUsage}
 */
export function normalizeSideCallUsage(usage) {
  const record = usage !== null && typeof usage === 'object' ? /** @type {Record<string, unknown>} */ (usage) : {}
  /** @param {string} key @returns {number} */
  const num = (key) => {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  }
  const inputTokens = num('inputTokens')
  const outputTokens = num('outputTokens')
  const cacheReadTokens = num('cacheReadTokens')
  const cacheWriteTokens = num('cacheWriteTokens')
  const reportedTotal = num('totalTokens')
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  }
}

/**
 * Join the text blocks of an assembled assistant answer.
 *
 * @param {{type?: unknown, text?: unknown}[]} blocks
 * @returns {string}
 */
function blocksToText(blocks) {
  /** @type {string[]} */
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/**
 * Read one provider route from the agent's durable session record.
 *
 * @param {AgentLike | undefined} agent
 * @returns {{provider: string, model: string} | null}
 */
function routeFromAgent(agent) {
  const session = agent?.session
  if (session === null || session === undefined) return null
  /** @param {unknown} value @returns {string} */
  const str = (value) => (typeof value === 'string' && value !== '' ? value : '')
  try {
    const header = session.requestHeader?.()
    const config = header?.config
    const provider = str(config?.provider)
    const model = str(config?.model)
    if (provider !== '' && model !== '') return { provider, model }
  } catch {
    /* a broken session accessor must not break the side call; fall through */
  }
  try {
    const context = session.requestContext?.()
    const provider = str(context?.provider)
    const model = str(context?.model)
    if (provider !== '' && model !== '') return { provider, model }
  } catch {
    /* see above */
  }
  return null
}

/**
 * Read a service without tripping Cordis's scoped-getter guard.
 *
 * @param {Context | null | undefined} ctx
 * @param {string} name
 * @returns {any}
 */
function readService(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined
  try {
    const get = /** @type {{get?: (service: string) => unknown}} */ (ctx).get
    if (typeof get === 'function') {
      const value = get.call(ctx, name)
      if (value !== undefined) return value
    }
  } catch {
    /* fall through to a direct property read */
  }
  try {
    return /** @type {Record<string, any>} */ (/** @type {unknown} */ (ctx))[name]
  } catch {
    return undefined
  }
}

/**
 * Create one reusable, failure-isolated side-call adapter for a host context.
 *
 * @param {Context | null | undefined} ctx Host context exposing `ctx.llm`.
 * @param {SideCallOptions} [options]
 * @returns {SideCallAdapter}
 */
export function createSideCall(ctx, options = {}) {
  const timeoutMs = numberOption(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const purpose = stringOption(options.purpose, DEFAULT_PURPOSE)
  const maxOutputTokens = numberOption(options.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS)
  const loadModule = typeof options.loadModule === 'function' ? options.loadModule : () => import('@deepseek-ai/dsh-llm')

  /** @type {Promise<DshLlmModule | null> | null} */
  let modulePromise = null
  /** @type {string | null} */
  let moduleFailure = null
  /** @type {Set<AbortController>} */
  const active = new Set()
  const stats = { calls: 0, ok: 0, failures: 0, timeouts: 0, aborts: 0, disposed: 0 }
  let disposed = false

  /**
   * Lazily import @deepseek-ai/dsh-llm once. A failed import is cached so the
   * adapter stays inert instead of retrying on every call.
   *
   * @returns {Promise<DshLlmModule | null>}
   */
  function ensureModule() {
    if (moduleFailure !== null) return Promise.resolve(null)
    if (modulePromise === null) {
      modulePromise = Promise.resolve()
        .then(() => loadModule('@deepseek-ai/dsh-llm'))
        .then((module) => (module && typeof module === 'object' ? module : null))
        .catch((error) => {
          moduleFailure = `dsh-llm module could not be loaded: ${redactText(errorMessage(error), 300)}`
          return null
        })
    }
    return modulePromise
  }

  /**
   * @param {string} code
   * @param {string} message
   * @returns {SideCallFailure}
   */
  function failure(code, message) {
    stats.failures += 1
    return { ok: false, code, error: redactText(message, 500) }
  }

  /**
   * Run one bounded side call. Never rejects.
   *
   * @param {SideCallRequest} request
   * @returns {Promise<SideCallResult>}
   */
  async function call(request) {
    stats.calls += 1
    if (disposed) {
      stats.disposed += 1
      return { ok: false, code: SIDE_CALL_CODES.DISPOSED, error: 'side call adapter is disposed' }
    }
    const prompt = typeof request?.prompt === 'string' ? request.prompt : ''
    if (prompt.trim() === '') return failure(SIDE_CALL_CODES.INVALID_PROMPT, 'side call requires a non-empty prompt string')

    const llm = /** @type {LlmRuntime | undefined} */ (readService(ctx, 'llm'))
    if (llm === undefined) return failure(SIDE_CALL_CODES.LLM_UNAVAILABLE, 'ctx.llm is not mounted; optional model features are off')
    const module = await ensureModule()
    if (module === null) return failure(SIDE_CALL_CODES.MODULE_UNAVAILABLE, moduleFailure ?? 'dsh-llm module unavailable')

    const explicitProvider = typeof request.provider === 'string' ? request.provider : ''
    const explicitModel = typeof request.model === 'string' ? request.model : ''
    const route =
      explicitProvider !== '' && explicitModel !== ''
        ? { provider: explicitProvider, model: explicitModel }
        : routeFromAgent(request.agent)
    if (route === null) {
      return failure(
        SIDE_CALL_CODES.NO_ROUTE,
        'no provider/model route: pass both explicitly or call after the agent has logged a request',
      )
    }
    const sessionId = typeof request.sessionId === 'string' && request.sessionId !== ''
      ? request.sessionId
      : routeSessionId(request.agent)
    const maxTokens = numberOption(request.maxTokens, maxOutputTokens)
    const system = typeof request.system === 'string' && request.system !== '' ? request.system : undefined

    const controller = new AbortController()
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    let timedOut = false
    /** @type {(() => void) | undefined} */
    let onExternalAbort
    const external = request.signal
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error(`side call timed out after ${timeoutMs} ms`))
      }, timeoutMs)
    }
    if (external !== undefined) {
      if (external.aborted) controller.abort(abortReason(external))
      else {
        onExternalAbort = () => controller.abort(abortReason(external))
        external.addEventListener('abort', onExternalAbort, { once: true })
      }
    }
    active.add(controller)

    /** @type {AsyncIterator<unknown> | undefined} */
    let iterator
    try {
      const callConfig = { provider: route.provider, model: route.model, maxTokens }
      const prepared = await withAbort(Promise.resolve(llm.prepareCall(callConfig, controller.signal)), controller.signal)

      const messages = [
        module.createUserMessage({
          content: [{ type: 'text', text: prompt }],
          // The typed MessageSource union is closed to core producers; a custom
          // kind is valid at runtime and stays confined to this request-only
          // message (side calls are never appended to model history).
          source: /** @type {any} */ ({ kind: SIDE_CALL_SOURCE_KIND }),
        }),
      ]
      /** @type {Record<string, unknown>} */
      const streamOptions = {
        ...prepared.config,
        messages,
        ...(sessionId === undefined ? {} : { sessionId }),
        purpose,
        signal: controller.signal,
      }
      if (system !== undefined) streamOptions.system = system

      const assembler = new module.BlockAssembler()
      const stream = prepared.stream(/** @type {any} */ (streamOptions))
      iterator = stream[Symbol.asyncIterator]()
      await consumeStream(iterator, assembler, controller.signal)

      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        const detail = finish.kind === 'error' ? finish.failure?.message : finish.failure?.message
        throw Object.assign(new Error(typeof detail === 'string' && detail !== '' ? detail : `model request ended with ${finish.kind}`), { sideCallCode: SIDE_CALL_CODES.FINISH_ERROR })
      }
      stats.ok += 1
      return {
        ok: true,
        text: blocksToText(assembler.blocks()),
        usage: normalizeSideCallUsage(assembler.usage),
        finish: finish.kind,
        provider: route.provider,
        model: route.model,
      }
    } catch (error) {
      if (timedOut) {
        stats.timeouts += 1
        return failure(SIDE_CALL_CODES.TIMEOUT, `side call timed out after ${timeoutMs} ms`)
      }
      if (controller.signal.aborted) {
        stats.aborts += 1
        return failure(
          SIDE_CALL_CODES.ABORTED,
          disposed ? 'side call adapter disposed while the call was in flight' : `side call aborted: ${errorMessage(abortReason(controller.signal))}`,
        )
      }
      const code = /** @type {{sideCallCode?: string}} */ (error)?.sideCallCode
      return failure(typeof code === 'string' ? code : SIDE_CALL_CODES.ERROR, `side call failed: ${errorMessage(error)}`)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (external !== undefined && onExternalAbort !== undefined) external.removeEventListener('abort', onExternalAbort)
      active.delete(controller)
      if (iterator !== undefined && typeof iterator.return === 'function') {
        // Do not await an adapter that ignores cancellation; just request cleanup.
        try {
          Promise.resolve(iterator.return()).catch(() => {})
        } catch {
          /* ignored: teardown is best-effort */
        }
      }
    }
  }

  /**
   * Consume the provider stream, racing each `next()` against the abort signal
   * so a non-cooperative adapter cannot outlive the deadline.
   *
   * @param {AsyncIterator<unknown>} iterator
   * @param {BlockAssembler} assembler
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   */
  async function consumeStream(iterator, assembler, signal) {
    for (;;) {
      const step = await withAbort(Promise.resolve(iterator.next()), signal)
      if (step.done === true) return
      assembler.push(/** @type {any} */ (step.value))
    }
  }

  /**
   * @param {AgentLike | undefined} agent
   * @returns {string | undefined}
   */
  function routeSessionId(agent) {
    try {
      const session = /** @type {{id?: unknown}} */ (/** @type {unknown} */ (agent?.session))
      return typeof session?.id === 'string' && session.id !== '' ? session.id : undefined
    } catch {
      return undefined
    }
  }

  /** @type {SideCallAdapter} */
  const adapter = {
    call,
    dispose() {
      if (disposed) return
      disposed = true
      for (const controller of active) {
        try {
          controller.abort(new Error('side call adapter disposed'))
        } catch {
          /* abort never throws in practice; containment only */
        }
      }
      active.clear()
    },
    get disposed() {
      return disposed
    },
    get activeCalls() {
      return active.size
    },
    get stats() {
      return { ...stats }
    },
  }

  // Release in-flight calls when the owning plugin fiber unloads. A context
  // without effects (unit stubs) simply uses explicit dispose().
  try {
    const effect = /** @type {{effect?: (execute: () => () => void, label?: string) => unknown}} */ (ctx)?.effect
    if (typeof effect === 'function') {
      effect.call(ctx, () => () => adapter.dispose(), 'tokeneconomizer.sidecall()')
    }
  } catch {
    /* containment: an inactive context means the owner is already unloading */
  }

  return adapter
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOption(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function stringOption(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}
