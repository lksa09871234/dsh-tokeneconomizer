/**
 * Crash-safe JSON/JSONL state storage for the plugin.
 *
 * Design constraints:
 * - The state directory may be shared by several DSH sessions in one process
 *   and occasionally by two profiles (for example TUI and Web) at once, so blob
 *   writes are atomic and guarded by a short-lived lock file.
 * - A corrupt file must degrade to its fallback and be quarantined for
 *   inspection instead of crashing the session.
 * - JSONL streams (usage samples) are appended and rotated so a long-lived
 *   install cannot grow without bound.
 *
 * @module dsh-tokeneconomizer/store
 */

import fs from 'node:fs'
import path from 'node:path'

import { STATE_SCHEMA_VERSION } from './version.js'

/**
 * @typedef {object} StoreOptions
 * @property {number} [maxJsonlBytes] Rotation threshold for append streams.
 * @property {number} [lockTimeoutMs] How long a writer waits for the lock.
 * @property {number} [lockStaleMs] Age after which a lock is considered abandoned.
 */

/**
 * One project's state directory. All methods are synchronous: the writes are
 * tiny and called from event hooks where async ordering would be harder to
 * reason about.
 */
export class JsonStore {
  /**
   * @param {string} dir Absolute project state directory.
   * @param {StoreOptions} [options]
   */
  constructor(dir, options = {}) {
    this.dir = dir
    this.maxJsonlBytes = options.maxJsonlBytes ?? 1_048_576
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000
    this.lockStaleMs = options.lockStaleMs ?? 30_000
    /** @type {string[]} Last corruption observations, newest last. */
    this.corruptions = []
  }

  /** @returns {string} */
  get dirPath() {
    return this.dir
  }

  /**
   * @param {string} name File name inside the state directory.
   * @returns {string}
   */
  file(name) {
    return path.join(this.dir, name)
  }

  /**
   * Read a JSON document written by {@link writeJson}. A missing file is not an
   * error (returns the fallback). A corrupt file is quarantined and returns the
   * fallback.
   *
   * @template T
   * @param {string} name File name inside the state directory.
   * @param {T} fallback Value used when absent or unreadable.
   * @param {(value: unknown) => boolean} [validate] Optional shape check.
   * @returns {T}
   */
  readJson(name, fallback, validate) {
    const file = this.file(name)
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (isMissing(error)) return clone(fallback)
      this.recordCorruption(name, 'unreadable', error)
      return clone(fallback)
    }
    try {
      const parsed = JSON.parse(raw)
      if (!isEnvelope(parsed)) {
        this.recordCorruption(name, 'missing envelope')
        return clone(fallback)
      }
      if (validate && !validate(parsed.value)) {
        this.recordCorruption(name, 'invalid value shape')
        return clone(fallback)
      }
      return /** @type {T} */ (parsed.value)
    } catch (error) {
      this.recordCorruption(name, 'invalid json', error)
      return clone(fallback)
    }
  }

  /**
   * Atomically write a JSON document. The write is `tmp` + `rename`, so a crash
   * can leave at most one stale temp file and never a truncated document.
   *
   * @param {string} name File name inside the state directory.
   * @param {unknown} value JSON-serializable value.
   * @param {{ locked?: boolean }} [options] Pass `locked: true` when already inside {@link withLock}.
   * @returns {boolean} True when persisted.
   */
  writeJson(name, value, options = {}) {
    const file = this.file(name)
    /** @type {() => boolean} */
    const write = () => {
      try {
        fs.mkdirSync(this.dir, { recursive: true })
        const payload = `${JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, value }, null, 2)}\n`
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
        fs.writeFileSync(tmp, payload, 'utf8')
        fs.renameSync(tmp, file)
        return true
      } catch {
        return false
      }
    }
    if (options.locked) return write()
    return this.withLock(name, write) === true
  }

  /**
   * Read-modify-write one JSON document under the state lock.
   *
   * @template T
   * @param {string} name File name inside the state directory.
   * @param {T} fallback Value used when the document is absent or corrupt.
   * @param {(current: T) => T} mutate Pure mutation: return the next value.
   * @param {(value: unknown) => boolean} [validate]
   * @returns {{ ok: boolean, value: T }}
   */
  updateJson(name, fallback, mutate, validate) {
    let value = clone(fallback)
    const ok = this.withLock(name, () => {
      value = mutate(this.readJson(name, fallback, validate))
      return this.writeJson(name, value, { locked: true })
    }) === true
    return { ok, value }
  }

  /**
   * Append one JSONL record, rotating the stream when it grows past
   * `maxJsonlBytes`. Rotation keeps the previous stream as `<name>.1` so a
   * report can still read recent history.
   *
   * @param {string} name File name inside the state directory.
   * @param {Record<string, unknown>} record
   * @returns {boolean}
   */
  appendJsonl(name, record) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const file = this.file(name)
      let size = 0
      try {
        size = fs.statSync(file).size
      } catch {
        size = 0
      }
      if (size > this.maxJsonlBytes) {
        try {
          fs.renameSync(file, `${file}.1`)
        } catch {
          // Rotation failure must not lose the new record; keep appending.
        }
      }
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
      return true
    } catch {
      return false
    }
  }

  /**
   * Read JSONL records, newest last. Corrupt lines are skipped. When the
   * stream was rotated, `<name>.1` is read first.
   *
   * @param {string} name File name inside the state directory.
   * @param {number} [limit] Maximum records to return (newest kept).
   * @returns {Record<string, unknown>[]}
   */
  readJsonl(name, limit = 10_000) {
    const records = []
    for (const candidate of [`${name}.1`, name]) {
      let raw
      try {
        raw = fs.readFileSync(this.file(candidate), 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        try {
          const parsed = JSON.parse(line)
          if (parsed && typeof parsed === 'object') records.push(parsed)
        } catch {
          // Skip a torn line.
        }
      }
    }
    return records.slice(-limit)
  }

  /**
   * Run `fn` while holding an exclusive lock file next to `name`. Re-entrant
   * calls in one process are not tracked: keep the critical section short.
   *
   * @template T
   * @param {string} name Lock identity (extension is appended).
   * @param {() => T} fn
   * @returns {T} The callback result, or `undefined` when the lock could not be acquired.
   */
  withLock(name, fn) {
    const lockFile = this.file(`${name}.lock`)
    try {
      fs.mkdirSync(this.dir, { recursive: true })
    } catch {
      return /** @type {T} */ (undefined)
    }
    const deadline = Date.now() + this.lockTimeoutMs
    let acquired = false
    while (Date.now() <= deadline) {
      try {
        const fd = fs.openSync(lockFile, 'wx')
        fs.writeSync(fd, String(process.pid))
        fs.closeSync(fd)
        acquired = true
        break
      } catch (error) {
        if (!isExists(error)) break
        // Stale lock recovery: a crashed process leaves the lock behind.
        try {
          const age = Date.now() - fs.statSync(lockFile).mtimeMs
          if (age > this.lockStaleMs) {
            fs.unlinkSync(lockFile)
            continue
          }
        } catch {
          continue
        }
        sleep(10)
      }
    }
    if (!acquired) return /** @type {T} */ (undefined)
    try {
      return fn()
    } finally {
      try {
        fs.unlinkSync(lockFile)
      } catch {
        // Already removed or never created after the final rename; harmless.
      }
    }
  }

  /**
   * @param {string} name
   * @param {string} reason
   * @param {unknown} [error]
   */
  recordCorruption(name, reason, error) {
    const suffix = new Date().toISOString().replace(/[:.]/g, '-')
    const original = this.file(name)
    try {
      fs.renameSync(original, `${original}.corrupt-${suffix}`)
    } catch {
      // If the file cannot be moved it is still unreadable; continue.
    }
    this.corruptions.push(`${name}: ${reason}${error ? ` (${error instanceof Error ? error.message : String(error)})` : ''}`)
    if (this.corruptions.length > 20) this.corruptions.shift()
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissing(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isExists(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isEnvelope(value) {
  return Boolean(value && typeof value === 'object' && 'schemaVersion' in value && Number.isInteger(value.schemaVersion))
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  if (value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value))
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // Busy-wait is acceptable for the ~2 ms typical lock hold; avoid a timer
    // dependency in this synchronous store.
  }
}
