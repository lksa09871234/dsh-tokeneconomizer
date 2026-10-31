/**
 * Normalization of DSH session records into the host-neutral shapes the
 * ported mechanisms consume.
 *
 * Everything here is pure: session events in, plain objects out. The shapes are
 * documented in docs/INTERFACES.md and covered by test/unit/dsh/.
 *
 * @module dsh-tokeneconomizer/dsh/normalize
 */

/**
 * Parse a raw model-produced tool-call argument string. DSH persists the exact
 * JSON string the model produced (`tool/call.arguments`); invalid JSON is
 * treated as an empty argument object rather than an error.
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
export function parseArguments(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return /** @type {Record<string, unknown>} */ (raw)
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? /** @type {Record<string, unknown>} */ (parsed)
      : {}
  } catch {
    return {}
  }
}

/**
 * Render model-facing content blocks to plain text. Tool results persist their
 * complete rendered content, so this is exactly what the model saw.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  /** @type {string[]} */
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const typed = /** @type {Record<string, unknown>} */ (block)
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
    else if (typed.type === 'reasoning' && typeof typed.text === 'string') parts.push(typed.text)
    else if (typed.type === 'image') parts.push('[image]')
    else if (typed.type === 'file') parts.push('[file]')
  }
  return parts.join('\n')
}

/**
 * Detect a shell exit code from persisted result content or tool-private meta.
 * DSH tools report failure through `isError`; where a tool also records a code
 * (in meta, or in the rendered text as `exit code: N`) this helper recovers it.
 * Absence means unknown, never success.
 *
 * @param {string} text
 * @param {unknown} [meta]
 * @returns {number|null}
 */
export function exitCodeFromResult(text, meta) {
  if (meta !== null && typeof meta === 'object') {
    const record = /** @type {Record<string, unknown>} */ (meta)
    for (const key of ['exitCode', 'exit_code', 'status']) {
      const value = record[key]
      if (typeof value === 'number' && Number.isInteger(value)) return value
    }
  }
  const match = /\bexit(?:\s+code)?[:=]\s*(-?\d+)\b/i.exec(text)
  if (match) {
    const code = Number.parseInt(match[1], 10)
    return Number.isFinite(code) ? code : null
  }
  return null
}

/**
 * One normalized tool call consumed by the micro-skills observer and the loop
 * guard.
 *
 * @typedef {object} NormalizedToolCall
 * @property {string} tool Canonical-ish tool name as the host reported it.
 * @property {Record<string, unknown>} args Parsed tool arguments.
 * @property {string} resultText Model-facing result text.
 * @property {boolean} failed Host-reported failure (`isError`).
 * @property {number|null} exitCode Shell exit code when recoverable.
 * @property {string} callId
 */

/**
 * Pair a persisted `tool/call` event with its `tool/result` event.
 *
 * @param {{callId: string, name: string, arguments: string}} callData
 * @param {{message: {content: unknown, isError?: boolean}, meta?: unknown}} resultData
 * @returns {NormalizedToolCall}
 */
export function normalizeToolCall(callData, resultData) {
  const text = contentToText(resultData.message?.content)
  return {
    tool: String(callData.name),
    args: parseArguments(callData.arguments),
    resultText: text,
    failed: resultData.message?.isError === true,
    exitCode: exitCodeFromResult(text, resultData.meta),
    callId: String(callData.callId),
  }
}

/**
 * Normalize provider token usage from an `assistant/message` event.
 *
 * @param {{usage?: Record<string, unknown>}} data
 * @returns {{inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number, totalTokens: number}|null}
 */
export function normalizeUsage(data) {
  const usage = data?.usage
  if (!usage || typeof usage !== 'object') return null
  /** @param {string} key */
  const num = (key) => {
    const value = /** @type {Record<string, unknown>} */ (usage)[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  }
  const normalized = {
    inputTokens: num('inputTokens'),
    outputTokens: num('outputTokens'),
    cacheReadTokens: num('cacheReadTokens'),
    cacheWriteTokens: num('cacheWriteTokens'),
    reasoningTokens: num('reasoningTokens'),
    totalTokens: num('totalTokens'),
  }
  const any = normalized.inputTokens + normalized.outputTokens + normalized.cacheReadTokens + normalized.cacheWriteTokens
  if (any === 0 && normalized.totalTokens === 0) return null
  return normalized
}

/**
 * Extract the visible tool catalog from a persisted `request/header` event.
 *
 * @param {{tools?: {name?: unknown, description?: unknown}[]}} header
 * @returns {{name: string, description: string}[]}
 */
export function catalogFromHeader(header) {
  if (!header || !Array.isArray(header.tools)) return []
  /** @type {{name: string, description: string}[]} */
  const out = []
  for (const tool of header.tools) {
    if (!tool || typeof tool.name !== 'string' || tool.name === '') continue
    out.push({ name: tool.name, description: typeof tool.description === 'string' ? tool.description : '' })
  }
  return out
}

/**
 * Whether a persisted user message is a direct human prompt. Injected context,
 * notices, goals, and plugin steering carry other source kinds and must not
 * count as prompts.
 *
 * @param {unknown} source
 * @returns {boolean}
 */
export function isHumanPromptSource(source) {
  return Boolean(source && typeof source === 'object' && /** @type {Record<string, unknown>} */ (source).kind === 'user')
}

/**
 * Canonical tool-name families used by the mechanisms. DSH ships several tool
 * renderings across plugins (built-in fs tools, dsh-ops native tools); the
 * mechanisms only need a coarse family, so prefixes are mapped here once.
 *
 * @param {string} name
 * @returns {'bash'|'view'|'edit'|'create'|'grep'|'glob'|'other'}
 */
export function toolFamily(name) {
  const lower = String(name).toLowerCase()
  if (/(^|_)(bash|shell|pwsh|powershell|terminal)(_|$)/.test(lower)) return 'bash'
  if (/(read_file|read_files|inspect_local_file|view|read_text|^read$)/.test(lower)) return 'view'
  if (/(edit_file|str_replace|replace_|apply_patch|^edit$|multiedit)/.test(lower)) return 'edit'
  if (/(write_file|create_file|^write$|^create$)/.test(lower)) return 'create'
  if (/(grep|search_files|search_content)/.test(lower)) return 'grep'
  if (/(glob|list_files|find_files)/.test(lower)) return 'glob'
  return 'other'
}
