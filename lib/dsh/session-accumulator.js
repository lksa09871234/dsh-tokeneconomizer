/**
 * Incremental, replayable accumulation of one DSH session's facts.
 *
 * The adapter feeds persisted `session/event` records in log order. Everything
 * the mechanisms need is computed here once, from durable facts, so a session
 * that is resumed or inspected later yields the same result as a live one.
 *
 * This module has no DSH imports: event objects are plain `{type, data}` records.
 *
 * @module dsh-tokeneconomizer/dsh/session-accumulator
 */

import {
  catalogFromHeader,
  isHumanPromptSource,
  normalizeToolCall,
  normalizeUsage,
} from './normalize.js'

/** Maximum normalized calls retained in memory for one session. */
export const MAX_RETAINED_CALLS = 4_000

/**
 * @typedef {import('./normalize.js').NormalizedToolCall} NormalizedToolCall
 */

/**
 * Accumulate one session from its durable events.
 */
export class SessionAccumulator {
  /**
   * @param {{sessionId: string, cwd?: string, origin?: string, startedAt?: number}} options
   */
  constructor(options) {
    this.sessionId = options.sessionId
    this.cwd = options.cwd ?? ''
    this.origin = options.origin ?? ''
    this.startedAt = options.startedAt ?? 0
    /** @type {Map<string, {callId: string, name: string, arguments: string}>} */
    this.pendingCalls = new Map()
    /** @type {NormalizedToolCall[]} */
    this.calls = []
    this.truncatedCalls = 0
    this.prompts = 0
    this.turns = { total: 0, completed: 0, aborted: 0, errored: 0, maxTokens: 0 }
    this.usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      requests: 0,
    }
    /** @type {Set<string>} */
    this.toolsUsed = new Set()
    /** @type {Map<string, string>} */
    this.catalog = new Map()
    this.model = ''
    this.provider = ''
    this.lastEventAt = 0
    this.finishedReason = ''
  }

  /**
   * Fold one persisted event. Unknown event types are ignored; malformed data is
   * ignored rather than thrown so a corrupt host log cannot break the plugin.
   *
   * @param {{type: string, time?: number, data?: any, seq?: number}} event
   * @returns {void}
   */
  onEvent(event) {
    if (!event || typeof event.type !== 'string') return
    const time = typeof event.time === 'number' ? event.time : 0
    if (time > this.lastEventAt) this.lastEventAt = time
    const data = event.data ?? {}
    switch (event.type) {
      case 'tool/call': {
        const callId = String(data.callId ?? '')
        if (callId === '') return
        this.pendingCalls.set(callId, {
          callId,
          name: String(data.name ?? ''),
          arguments: typeof data.arguments === 'string' ? data.arguments : '',
        })
        this.toolsUsed.add(String(data.name ?? ''))
        return
      }
      case 'tool/result': {
        const callId = String(data.message?.toolCallId ?? '')
        const pending = this.pendingCalls.get(callId)
        if (!pending) return
        this.pendingCalls.delete(callId)
        const normalized = normalizeToolCall(pending, data)
        if (this.calls.length < MAX_RETAINED_CALLS) this.calls.push(normalized)
        else this.truncatedCalls += 1
        return
      }
      case 'user/message': {
        if (isHumanPromptSource(data.source)) this.prompts += 1
        return
      }
      case 'turn/start':
        this.turns.total += 1
        return
      case 'turn/end': {
        const kind = data.reason?.kind
        if (kind === 'completed') this.turns.completed += 1
        else if (kind === 'aborted') this.turns.aborted += 1
        else if (kind === 'error') this.turns.errored += 1
        else if (kind === 'max-tokens') this.turns.maxTokens += 1
        return
      }
      case 'assistant/message': {
        const usage = normalizeUsage(data)
        if (usage) {
          this.usage.inputTokens += usage.inputTokens
          this.usage.outputTokens += usage.outputTokens
          this.usage.cacheReadTokens += usage.cacheReadTokens
          this.usage.cacheWriteTokens += usage.cacheWriteTokens
          this.usage.reasoningTokens += usage.reasoningTokens
          this.usage.totalTokens += usage.totalTokens
          this.usage.requests += 1
        }
        return
      }
      case 'request/header': {
        for (const tool of catalogFromHeader(data.header)) this.catalog.set(tool.name, tool.description)
        const config = data.header?.config
        if (config && typeof config === 'object') {
          if (typeof config.model === 'string' && config.model !== '') this.model = config.model
          if (typeof config.provider === 'string' && config.provider !== '') this.provider = config.provider
        }
        return
      }
      case 'request/context': {
        if (typeof data.provider === 'string' && data.provider !== '') this.provider = data.provider
        if (typeof data.model === 'string' && data.model !== '') this.model = data.model
        return
      }
      default:
        return
    }
  }

  /** @returns {boolean} True when a normal tool result was paired with a call. */
  isSubagentSession() {
    return this.origin === 'subagent'
  }

  /**
   * Mark the session as finished. The reason is opaque bookkeeping.
   * @param {string} reason
   */
  markFinished(reason) {
    this.finishedReason = reason
  }

  /**
   * Deep, serializable snapshot for persistence and mechanism input.
   * @returns {{
   *   sessionId: string, cwd: string, origin: string, startedAt: number,
   *   prompts: number, calls: NormalizedToolCall[], truncatedCalls: number,
   *   turns: {total:number, completed:number, aborted:number, errored:number, maxTokens:number},
   *   usage: {inputTokens:number, outputTokens:number, cacheReadTokens:number, cacheWriteTokens:number, reasoningTokens:number, totalTokens:number, requests:number},
   *   toolsUsed: string[], toolsVisible: string[],
   *   catalog: {name:string, description:string}[],
   *   model: string, provider: string,
   *   lastEventAt: number, finishedReason: string,
   * }}
   */
  snapshot() {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      origin: this.origin,
      startedAt: this.startedAt,
      prompts: this.prompts,
      calls: this.calls.map((call) => ({ ...call, args: { ...call.args } })),
      truncatedCalls: this.truncatedCalls,
      turns: { ...this.turns },
      usage: { ...this.usage },
      toolsUsed: [...this.toolsUsed].sort(),
      toolsVisible: [...this.catalog.keys()].sort(),
      catalog: [...this.catalog.entries()]
        .map(([name, description]) => ({ name, description }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      model: this.model,
      provider: this.provider,
      lastEventAt: this.lastEventAt,
      finishedReason: this.finishedReason,
    }
  }
}
