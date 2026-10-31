/**
 * Bounded, redacted diagnostics.
 *
 * The plugin must never store prompts, tool output, environment values, or
 * credentials. Diagnostics therefore carry a short classified message and an
 * error string that passes through {@link redactText}; they are appended to a
 * single bounded JSONL file so repeated failures cannot grow without limit.
 *
 * @module dsh-tokeneconomizer/diagnostics
 */

import fs from 'node:fs'
import path from 'node:path'

/** Default cap for the diagnostics file. */
export const DEFAULT_MAX_BYTES = 65_536

/**
 * Patterns that look like credentials or personal absolute paths. They are
 * redacted before anything is persisted or printed.
 */
const REDACTION_RULES = [
  // Common token shapes: sk-..., ghp_..., xoxb-..., AKIA..., Bearer ...
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, '[redacted-token]'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}\b/g, '[redacted-token]'],
  [/\bxox[abpsr]-[A-Za-z0-9-]{8,}\b/g, '[redacted-token]'],
  [/\b(AKIA|ASIA)[A-Z0-9]{12,}\b/g, '[redacted-key-id]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted-token]'],
  // key=value / "key": "value" forms for credential-ish names
  [/\b(api[_-]?key|secret|token|password|passwd|authorization|credential|cookie)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]'],
  // e-mail addresses (personal data) and long absolute user paths
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]'],
  [/\b[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\s]+\\[^\\\s]*/g, '[redacted-path]'],
  [/\/(?:home|Users)\/[^/\s]+\/[^\s]*/g, '[redacted-path]'],
]

/**
 * Redact credentials and personal paths from text and cap its length.
 *
 * @param {string} text
 * @param {number} [maxLength]
 * @returns {string}
 */
export function redactText(text, maxLength = 2000) {
  let out = String(text)
  for (const [pattern, replacement] of REDACTION_RULES) {
    out = out.replace(/** @type {RegExp} */ (pattern), /** @type {string} */ (replacement))
  }
  out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  if (out.length > maxLength) out = `${out.slice(0, maxLength)}…`
  return out
}

/**
 * Append one diagnostic record, keeping the file bounded. Failures are
 * swallowed: diagnostics must never break the session.
 *
 * @param {string} stateDir Plugin state directory.
 * @param {{ level: 'info'|'warn'|'error', scope: string, message: string, error?: string }} record
 * @param {number} [maxBytes]
 * @returns {boolean} True when the record was persisted.
 */
export function writeDiagnostic(stateDir, record, maxBytes = DEFAULT_MAX_BYTES) {
  return appendBounded(path.join(stateDir, 'diagnostics.jsonl'), {
    at: new Date().toISOString(),
    level: record.level,
    scope: record.scope,
    message: redactText(record.message, 500),
    ...(record.error === undefined ? {} : { error: redactText(record.error, 800) }),
  }, maxBytes)
}

/**
 * Append one JSON line to a bounded file, trimming the oldest lines when the
 * new content would exceed `maxBytes`.
 *
 * @param {string} file Absolute file path.
 * @param {Record<string, unknown>} record JSON-serializable record.
 * @param {number} maxBytes
 * @returns {boolean}
 */
export function appendBounded(file, record, maxBytes) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = `${JSON.stringify(record)}\n`
    let previous = ''
    try {
      previous = fs.readFileSync(file, 'utf8')
    } catch {
      previous = ''
    }
    let next = previous + line
    if (Buffer.byteLength(next, 'utf8') > maxBytes) {
      // Drop whole leading lines until the budget is met; keep the newest.
      const lines = next.split('\n').filter((entry) => entry.length > 0)
      while (lines.length > 1 && Buffer.byteLength(lines.join('\n'), 'utf8') + 1 > maxBytes) lines.shift()
      next = `${lines.join('\n')}\n`
    }
    fs.writeFileSync(file, next, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Read persisted diagnostics, newest last. Returns [] when the file is absent
 * or unparsable lines are skipped.
 *
 * @param {string} stateDir Plugin state directory.
 * @param {number} [limit] Maximum records to return (newest kept).
 * @returns {Record<string, unknown>[]}
 */
export function readDiagnostics(stateDir, limit = 50) {
  try {
    const raw = fs.readFileSync(path.join(stateDir, 'diagnostics.jsonl'), 'utf8')
    /** @type {Record<string, unknown>[]} */
    const records = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed === 'object') records.push(parsed)
      } catch {
        // A truncated trailing line after a crash is expected; ignore it.
      }
    }
    return records.slice(-limit)
  } catch {
    return []
  }
}
