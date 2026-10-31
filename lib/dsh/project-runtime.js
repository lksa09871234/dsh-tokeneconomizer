/**
 * Per-project runtime state for the DSH adapter.
 *
 * One instance owns the state directory of one project root: the snapshot of a
 * DSH session, the learned mechanism documents, project-scoped configuration
 * overrides, the session-fold bookkeeping and the usage ledger.
 *
 * Failure policy: every filesystem operation goes through {@link JsonStore},
 * which never throws; a corrupt document is quarantined and the mechanism
 * restarts from empty state.
 *
 * @module dsh-tokeneconomizer/dsh/project-runtime
 */

import fs from 'node:fs'
import path from 'node:path'

import { JsonStore } from '../store.js'
import { STATE_SCHEMA_VERSION } from '../version.js'
import { detectProjectRoot, displayPath, projectKey, projectStateDir } from '../project.js'

/** Mechanism document file names (kept stable: users' learned state survives upgrades). */
export const FILES = Object.freeze({
  project: 'project.json',
  microskills: 'microskills.json',
  toolprune: 'toolprune.json',
  envelope: 'envelope.json',
  ledger: 'ledger.jsonl',
  folded: 'folded.json',
})

/**
 * @typedef {object} ProjectRecord
 * @property {number} schemaVersion
 * @property {string} label Human label (directory basename or remote-looking form).
 * @property {string} cwdDisplay Symbolic path only; no machine home path is stored.
 * @property {string} firstSeen ISO timestamp.
 * @property {string} lastSeen ISO timestamp.
 */

/** @typedef {import('../config.js').TokenEconomizerConfig} TokenEconomizerConfig */

/**
 * One project's state.
 */
export class ProjectRuntime {
  /**
   * @param {object} options
   * @param {string} options.dataDir Plugin data directory.
   * @param {string} options.root Normalized absolute project root.
   * @param {TokenEconomizerConfig} options.config Base plugin configuration.
   */
  constructor({ dataDir, root, config }) {
    this.dataDir = dataDir
    this.root = root
    this.key = projectKey(root)
    this.dir = projectStateDir(dataDir, root)
    this.config = config
    this.store = new JsonStore(this.dir, { maxJsonlBytes: config.diagnosticsMaxBytes > 0 ? 1_048_576 : 1_048_576 })
    /** @type {ProjectRecord | undefined} */
    this._project = undefined
    /** @type {Record<string, unknown> | undefined} */
    this._microskills = undefined
    /** @type {Record<string, unknown> | undefined} */
    this._toolprune = undefined
    /** @type {Record<string, unknown> | undefined} */
    this._envelope = undefined
    /** @type {Record<string, unknown> | undefined} */
    this._overrides = undefined
  }

  /**
   * Open (or create) the runtime for one project root.
   *
   * @param {string} dataDir
   * @param {string} root
   * @param {TokenEconomizerConfig} config
   * @returns {ProjectRuntime}
   */
  static open(dataDir, root, config) {
    const runtime = new ProjectRuntime({ dataDir, root, config })
    try {
      fs.mkdirSync(runtime.dir, { recursive: true })
    } catch {
      // A read-only data directory leaves the runtime memory-only.
    }
    runtime.recordProject()
    return runtime
  }

  /** @returns {ProjectRecord} */
  recordProject() {
    if (this._project) return this._project
    const now = new Date().toISOString()
    /** @type {ProjectRecord} */
    const fallback = {
      schemaVersion: STATE_SCHEMA_VERSION,
      label: path.basename(this.root) || 'project',
      cwdDisplay: displayPath(this.root),
      firstSeen: now,
      lastSeen: now,
    }
    const existing = this.store.readJson(FILES.project, fallback, (value) => Boolean(value && typeof value === 'object'))
    /** @type {ProjectRecord} */
    const record = {
      schemaVersion: STATE_SCHEMA_VERSION,
      label: typeof existing.label === 'string' && existing.label !== '' ? existing.label : fallback.label,
      cwdDisplay: typeof existing.cwdDisplay === 'string' ? existing.cwdDisplay : fallback.cwdDisplay,
      firstSeen: typeof existing.firstSeen === 'string' ? existing.firstSeen : now,
      lastSeen: now,
    }
    this._project = record
    this.store.writeJson(FILES.project, record)
    return record
  }

  /** @returns {Record<string, unknown>} Persisted project configuration overrides. */
  overrides() {
    if (this._overrides) return this._overrides
    const doc = this.store.readJson(FILES.project, {}, (value) => Boolean(value && typeof value === 'object'))
    const record = /** @type {Record<string, any>} */ (doc && typeof doc === 'object' ? doc : {})
    const overrides = record.config && typeof record.config === 'object'
      ? /** @type {Record<string, unknown>} */ (record.config)
      : {}
    this._overrides = { ...overrides }
    return this._overrides
  }

  /**
   * Persist one project-scoped setting override.
   * @param {string} key
   * @param {unknown} value
   * @returns {boolean}
   */
  setOverride(key, value) {
    const next = { ...this.overrides(), [key]: value }
    this._overrides = next
    const record = this.recordProject()
    const doc = { ...record, config: next }
    return this.store.writeJson(FILES.project, doc)
  }

  /**
   * Remove one project-scoped override.
   * @param {string} key
   * @returns {boolean}
   */
  unsetOverride(key) {
    const next = { ...this.overrides() }
    delete next[key]
    this._overrides = next
    const doc = { ...this.recordProject(), config: next }
    return this.store.writeJson(FILES.project, doc)
  }

  /** @returns {Record<string, unknown>} */
  microskills() {
    if (this._microskills) return this._microskills
    this._microskills = this.store.readJson(FILES.microskills, {}) 
    return this._microskills
  }

  /** @param {Record<string, unknown>} doc */
  saveMicroskills(doc) {
    this._microskills = doc
    return this.store.writeJson(FILES.microskills, doc)
  }

  /** @returns {Record<string, unknown>} */
  toolprune() {
    if (this._toolprune) return this._toolprune
    this._toolprune = this.store.readJson(FILES.toolprune, {})
    return this._toolprune
  }

  /** @param {Record<string, unknown>} doc */
  saveToolprune(doc) {
    this._toolprune = doc
    return this.store.writeJson(FILES.toolprune, doc)
  }

  /** @returns {Record<string, unknown>} */
  envelope() {
    if (this._envelope) return this._envelope
    this._envelope = this.store.readJson(FILES.envelope, {})
    return this._envelope
  }

  /** @param {Record<string, unknown>} doc */
  saveEnvelope(doc) {
    this._envelope = doc
    return this.store.writeJson(FILES.envelope, doc)
  }

  /**
   * Persist one session snapshot. The file name is the DSH session id, made
   * filesystem-safe; the snapshot carries the original id.
   *
   * @param {{sessionId: string}} snapshot
   * @param {{folded?: boolean, updated?: string}} [extra]
   * @returns {string} The session file name.
   */
  saveSessionSnapshot(snapshot, extra = {}) {
    const name = sessionFileName(snapshot.sessionId)
    const doc = {
      schemaVersion: STATE_SCHEMA_VERSION,
      updated: new Date().toISOString(),
      folded: extra.folded === true,
      snapshot,
    }
    this.store.writeJson(path.join('sessions', name), doc)
    return name
  }

  /**
   * @param {string} sessionId
   * @returns {boolean} True when this session's learning fold already happened.
   */
  isFolded(sessionId) {
    const doc = this.store.readJson(FILES.folded, { folded: {} })
    return Boolean(doc && typeof doc === 'object' && doc.folded && typeof doc.folded === 'object' && sessionId in doc.folded)
  }

  /**
   * Mark one session as folded (idempotence guard).
   * @param {string} sessionId
   * @param {string} [reason]
   * @returns {boolean}
   */
  markFolded(sessionId, reason = 'folded') {
    const current = this.store.readJson(FILES.folded, { folded: {} })
    const folded = current && typeof current === 'object' && current.folded && typeof current.folded === 'object'
      ? /** @type {Record<string, unknown>} */ (current.folded)
      : {}
    folded[sessionId] = { at: new Date().toISOString(), reason }
    return this.store.writeJson(FILES.folded, { schemaVersion: STATE_SCHEMA_VERSION, folded })
  }

  /**
   * Session snapshots that still need a learning fold, oldest first.
   * @param {number} [limit]
   * @returns {{sessionId: string, snapshot: Record<string, unknown>, file: string}[]}
   */
  unfoldedSessions(limit = 50) {
    const sessionsDir = path.join(this.dir, 'sessions')
    let names = []
    try {
      names = fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.json'))
    } catch {
      return []
    }
    const out = []
    for (const name of names.sort()) {
      const doc = /** @type {Record<string, any>} */ (this.store.readJson(path.join('sessions', name), {}))
      if (!doc || typeof doc !== 'object' || doc.folded === true) continue
      const snapshot = doc.snapshot
      if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.sessionId !== 'string') continue
      if (this.isFolded(snapshot.sessionId)) continue
      out.push({ sessionId: snapshot.sessionId, snapshot: /** @type {Record<string, unknown>} */ (snapshot), file: name })
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * @param {Record<string, unknown>} record
   * @returns {boolean}
   */
  appendLedger(record) {
    return this.store.appendJsonl(FILES.ledger, record)
  }

  /**
   * @param {number} [limit]
   * @returns {Record<string, unknown>[]}
   */
  readLedger(limit = 500) {
    return this.store.readJsonl(FILES.ledger, limit)
  }

  /**
   * Read any JSON document in the project state directory (extension added when
   * `name` has no `.json` suffix). Missing/corrupt documents yield the fallback.
   *
   * @template T
   * @param {string} name
   * @param {T} fallback
   * @returns {T}
   */
  readDoc(name, fallback) {
    return this.store.readJson(name.endsWith('.json') ? name : `${name}.json`, fallback)
  }

  /**
   * Write any JSON document in the project state directory.
   * @param {string} name
   * @param {unknown} value
   * @returns {boolean}
   */
  writeDoc(name, value) {
    return this.store.writeJson(name.endsWith('.json') ? name : `${name}.json`, value)
  }

  /**
   * Recent session snapshots, newest last (bounded). Used by the optional model
   * proposer's digest input.
   * @param {number} [limit]
   * @returns {Record<string, any>[]}
   */
  recentSessionSnapshots(limit = 8) {
    const sessionsDir = path.join(this.dir, 'sessions')
    /** @type {{mtime: number, snapshot: Record<string, any>}[]} */
    const found = []
    try {
      for (const name of fs.readdirSync(sessionsDir)) {
        if (!name.endsWith('.json')) continue
        const full = path.join(sessionsDir, name)
        try {
          const stat = fs.statSync(full)
          const doc = this.store.readJson(path.join('sessions', name), {})
          const snapshot = doc && typeof doc === 'object' ? /** @type {Record<string, any>} */ (doc).snapshot : undefined
          if (snapshot && typeof snapshot === 'object') found.push({ mtime: stat.mtimeMs, snapshot })
        } catch {
          // Skip a file removed concurrently.
        }
      }
    } catch {
      return []
    }
    found.sort((a, b) => a.mtime - b.mtime)
    return found.slice(-limit).map((entry) => entry.snapshot)
  }

  /**
   * Latest activity timestamp across persisted session snapshots, in epoch
   * milliseconds. Used by the tool-pruning quiet period; 0 when nothing exists.
   * @returns {number}
   */
  lastSessionActivityMs() {
    const sessionsDir = path.join(this.dir, 'sessions')
    let newest = 0
    try {
      for (const name of fs.readdirSync(sessionsDir)) {
        if (!name.endsWith('.json')) continue
        try {
          const stat = fs.statSync(path.join(sessionsDir, name))
          if (stat.mtimeMs > newest) newest = stat.mtimeMs
        } catch {
          // Ignore a file removed concurrently.
        }
      }
    } catch {
      return 0
    }
    return newest
  }

  /**
   * Delete one project's learned state (sessions, facts, evidence, ledger) but
   * keep the project record. Used by the explicit reset command only.
   * @returns {boolean}
   */
  reset() {
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (name === FILES.project || name === 'sessions') continue
        fs.rmSync(path.join(this.dir, name), { recursive: true, force: true })
      }
      fs.rmSync(path.join(this.dir, 'sessions'), { recursive: true, force: true })
      this._microskills = undefined
      this._toolprune = undefined
      this._envelope = undefined
      return true
    } catch {
      return false
    }
  }
}

/**
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionFileName(sessionId) {
  return `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160) || 'session'}.json`
}

/**
 * Registry of per-project runtimes for one plugin instance.
 */
export class ProjectRegistry {
  /**
   * @param {string} dataDir
   * @param {TokenEconomizerConfig} config
   */
  constructor(dataDir, config) {
    this.dataDir = dataDir
    this.config = config
    /** @type {Map<string, ProjectRuntime>} */
    this.projects = new Map()
  }

  /**
   * Open (or reuse) the runtime for a session's recorded project root.
   *
   * @param {string} cwd Absolute working directory from the session header.
   * @returns {ProjectRuntime|undefined} Undefined when the session has no cwd.
   */
  forCwd(cwd) {
    if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
    let root
    try {
      root = detectProjectRoot(cwd)
    } catch {
      return undefined
    }
    const key = projectKey(root)
    const existing = this.projects.get(key)
    if (existing) return existing
    const runtime = ProjectRuntime.open(this.dataDir, root, this.config)
    this.projects.set(key, runtime)
    return runtime
  }

  /**
   * Every open project runtime.
   * @returns {ProjectRuntime[]}
   */
  list() {
    return [...this.projects.values()]
  }
}
