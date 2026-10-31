/**
 * DSH integration for dsh-tokeneconomizer.
 *
 * This is the only module that talks to the harness. Mechanism logic lives in
 * dependency-free modules; this adapter maps durable DSH events to their inputs
 * and applies their outputs to the live session:
 *
 * - `agent/created` (serial, before the first request): load the project state,
 *   inject the learned note as an agent-scoped system-prompt section, and apply
 *   the project's pruning deny list as an agent-scoped tool restriction.
 * - `session/event`: fold `tool/call`/`tool/result`, `request/header`,
 *   `assistant/message`, `user/message` and `turn/*` into a per-session
 *   accumulator and a live loop guard.
 * - `session/disposed` / `agent/disposed`: snapshot the session, fold it once
 *   into micro-skills and tool-pruning state, and append the usage ledger record.
 *
 * Every host callback is failure-isolated: an error is recorded as a redacted
 * diagnostic and never thrown into a session or agent-creation path.
 *
 * @module dsh-tokeneconomizer/dsh/install
 */

import fs from 'node:fs'
import path from 'node:path'

import { runCommand } from '../commands.js'
import { applyEnvOverrides } from '../config.js'
import { writeDiagnostic } from '../diagnostics.js'
import { stateDirForConfig } from '../project.js'
import { VERSION } from '../version.js'
import { Mechanisms } from './mechanisms.js'
import { ProjectRegistry } from './project-runtime.js'
import { SessionAccumulator } from './session-accumulator.js'

/**
 * @typedef {import('../config.js').TokenEconomizerConfig} TokenEconomizerConfig
 * @typedef {import('./project-runtime.js').ProjectRuntime} ProjectRuntime
 * @typedef {import('@deepseek-ai/cordis').Context} Context
 */

/**
 * @typedef {object} SessionState
 * @property {string} sessionId
 * @property {import('@deepseek-ai/dsh-agent').Agent} agent
 * @property {ProjectRuntime} project
 * @property {TokenEconomizerConfig} config
 * @property {SessionAccumulator} accumulator
 * @property {any} guard
 * @property {number} guardTurn
 * @property {any} envelope
 * @property {{ dispose: () => void, deny: string[] } | null} restriction
 * @property {{ text: string, ids: string[] }} microskills
 * @property {number} nudges
 * @property {number} notices
 * @property {number} judgeTokens
 * @property {number} writerTokens
 * @property {{ deny: string[], absent: string[], present: string[] }} verification
 * @property {number} lastActivity
 */

/**
 * Install the plugin into a live host context.
 *
 * @param {Context} ctx Host context.
 * @param {TokenEconomizerConfig} config Effective configuration from the profile.
 * @returns {Promise<boolean>}
 */
export async function install(ctx, config) {
  const logger = safeLogger(ctx)
  const profileContext = safeGet(ctx, 'profileContext')
  const dataDir = stateDirForConfig(config.dataDir, process.env, profileContext?.home)
  try {
    fs.mkdirSync(dataDir, { recursive: true })
  } catch (error) {
    logger?.warn?.('state directory unavailable (%s); plugin stays inert', errorMessage(error))
    return false
  }

  const host = new Host(ctx, config, dataDir, logger, await optionalSidecall(ctx, config))
  try {
    host.start()
  } catch (error) {
    writeDiagnostic(dataDir, { level: 'error', scope: 'install', message: 'adapter installation failed', error: errorMessage(error) }, config.diagnosticsMaxBytes)
    logger?.warn?.('adapter installation failed: %s', errorMessage(error))
    return false
  }

  try {
    const marker = {
      schemaVersion: 1,
      plugin: 'dsh-tokeneconomizer',
      version: VERSION,
      loadedAt: new Date().toISOString(),
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      config: {
        microskills: config.microskills,
        toolprune: config.toolprune,
        loopguard: config.loopguard,
        dataDirDisplay: profileContext?.home === undefined ? undefined : '$DSH_HOME/tokeneconomizer',
      },
    }
    fs.writeFileSync(path.join(dataDir, 'plugin-load.json'), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  } catch (error) {
    logger?.warn?.('could not write load marker: %s', errorMessage(error))
  }

  logger?.info?.('loaded (microskills=%s toolprune=%s loopguard=%s)', config.microskills, config.toolprune, config.loopguard)
  return true
}

/**
 * The live adapter: event wiring and per-session state.
 */
class Host {
  /**
   * @param {Context} ctx
   * @param {TokenEconomizerConfig} config
   * @param {string} dataDir
   * @param {any} logger
   * @param {any} [sidecall]
   */
  constructor(ctx, config, dataDir, logger, sidecall) {
    this.ctx = ctx
    this.config = config
    this.dataDir = dataDir
    this.logger = logger
    this.sidecall = sidecall ?? null
    this.registry = new ProjectRegistry(dataDir, config)
    this.mechanisms = new Mechanisms({ config, dataDir, logger, diagnostic: (record) => this.diagnostic(record), sidecall: this.sidecall })
    /** @type {Map<string, SessionState>} */
    this.sessions = new Map()
    /** @type {Map<string, import('@deepseek-ai/dsh-agent').Agent>} */
    this.agentsBySession = new Map()
  }

  start() {
    this.ctx.on('agent/created', (payload) => {
      this.safe('agent/created', () => this.onAgentCreated(payload.agent, payload.source))
      return undefined
    })
    this.ctx.on('agent/disposed', (payload) => {
      this.safe('agent/disposed', () => this.onAgentDisposed(payload.agent))
    })
    this.ctx.on('session/event', (session, event) => {
      this.safe('session/event', () => this.onSessionEvent(session, event))
    })
    this.ctx.on('session/disposed', (session) => {
      this.safe('session/disposed', () => this.onSessionDisposed(session))
    })
    if (typeof this.ctx.inject === 'function') {
      this.ctx.inject(['commands'], (childCtx) => {
        this.safe('commands', () => this.registerCommands(childCtx))
      })
    }
  }

  /**
   * Effective per-project configuration: profile config, then project overrides,
   * then `TE_*` environment overrides (upstream precedence).
   *
   * @param {ProjectRuntime} project
   * @returns {TokenEconomizerConfig}
   */
  effectiveConfig(project) {
    const overrides = project.overrides()
    /** @type {TokenEconomizerConfig} */
    const merged = { ...this.config }
    for (const [key, value] of Object.entries(overrides)) {
      if (key in merged) /** @type {Record<string, unknown>} */ (merged)[key] = value
    }
    return applyEnvOverrides(merged, process.env).config
  }

  /**
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {string} source
   */
  onAgentCreated(agent, source) {
    const session = agent?.session
    if (!session) return
    if (session.header?.origin === 'subagent') return
    const project = this.registry.forCwd(session.header?.cwd ?? '')
    if (!project) return
    const config = this.effectiveConfig(project)
    if (!config.enabled) return
    /** @type {SessionState} */
    const state = {
      sessionId: session.id,
      agent,
      project,
      config,
      accumulator: new SessionAccumulator({
        sessionId: session.id,
        cwd: session.header?.cwd ?? '',
        origin: session.header?.origin ?? '',
        startedAt: session.header?.createdAt ?? 0,
      }),
      guard: null,
      guardTurn: -1,
      envelope: this.mechanisms.loadEnvelope(project, config),
      restriction: null,
      microskills: { text: '', ids: [] },
      nudges: 0,
      notices: 0,
      judgeTokens: 0,
      writerTokens: 0,
      verification: { deny: [], absent: [], present: [] },
      lastActivity: Date.now(),
    }
    this.sessions.set(session.id, state)
    this.agentsBySession.set(session.id, agent)

    // Catch-up: fold any snapshot from an earlier process that never got folded.
    this.safe('startup-fold', () => this.foldPendingSessions(project, config))

    // Micro-skills: stable, capped, clearly delimited note for this session.
    if (config.microskills !== 'off') {
      const rendered = this.mechanisms.renderMicroskills(project, config)
      state.microskills = rendered
      if (rendered.text !== '') {
        const text = rendered.text
        agent.ctx.systemPrompt.section({
          name: 'tokeneconomizer:microskills',
          order: 15000,
          text: () => text,
          interpolate: false,
        })
      }
    }

    // Tool pruning: hide the project's applied deny list from this agent's model
    // requests. Only names currently in the global tool universe are used.
    if (config.toolprune === 'apply') {
      this.applyRestriction(state)
    }

    // Pending quiet-period writes from an earlier session may now be due.
    this.safe('pending-toolprune', () => this.maybeApplyPending(project, config))
    void source
  }

  /**
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   */
  onAgentDisposed(agent) {
    const sessionId = agent?.session?.id
    if (sessionId === undefined) return
    const state = this.sessions.get(sessionId)
    if (state) {
      this.finalizeSession(state, 'agent-disposed')
      this.sessions.delete(sessionId)
    }
    this.agentsBySession.delete(sessionId)
  }

  /**
   * @param {import('@deepseek-ai/dsh-session').Session} session
   * @param {import('@deepseek-ai/dsh-session').SessionEvent} event
   */
  onSessionEvent(session, event) {
    const state = this.sessions.get(session.id)
    if (!state || !event || typeof event.type !== 'string') return
    state.lastActivity = Date.now()
    state.accumulator.onEvent(event)
    const config = state.config

    if (event.type === 'request/header') {
      this.recordPruningVerification(state, event)
    }
    if (event.type === 'tool/result' && config.loopguard === 'on') {
      this.onToolResult(state, event)
    }
    if (event.type === 'turn/end') {
      this.onTurnEnd(state, event)
    }
    if (event.type === 'turn/start') {
      state.guard = null
      state.guardTurn = -1
    }
  }

  /**
   * @param {SessionState} state
   * @param {any} event
   */
  onToolResult(state, event) {
    const callId = String(event.data?.message?.toolCallId ?? '')
    const call = [...state.accumulator.calls].reverse().find((candidate) => candidate.callId === callId)
    if (!call) return
    const turn = typeof event.data?.turn === 'number' ? event.data.turn : -1
    if (state.guard === null || state.guardTurn !== turn) {
      state.guard = this.mechanisms.createTurnGuard(state.config)
      state.guardTurn = turn
    }
    const decision = this.mechanisms.foldGuard(state.guard, call, {
      config: state.config,
      envelope: state.envelope,
      judge: this.mechanisms.judgeForSession(),
    })
    if (!decision || decision.action === null) return
    if (decision.action === 'nudge') {
      state.nudges += 1
      this.deliverSteer(state, decision.text)
      this.logger?.info?.('loop guard redirected a repetitive turn (%s)', truncate(decision.reason, 120))
    } else if (decision.action === 'notice') {
      state.notices += 1
      this.logger?.warn?.('turn still looks stuck after a redirect (%s); the plugin never stops a turn', truncate(decision.reason, 120))
      this.diagnostic({ level: 'warn', scope: 'loopguard', message: `still stuck: ${truncate(decision.reason, 160)}` })
    }
  }

  /**
   * @param {SessionState} state
   * @param {string} text
   */
  deliverSteer(state, text) {
    const agent = state.agent
    if (!agent || agent.status !== 'running') return
    try {
      if (typeof agent.steer !== 'function') return
      this.mechanisms.createUserMessage(text).then((message) => {
        if (!message) return
        this.safe('steer', () => agent.steer(message))
      }).catch(() => {})
    } catch (error) {
      this.diagnostic({ level: 'warn', scope: 'loopguard', message: 'could not deliver redirect', error: errorMessage(error) })
    }
  }

  /**
   * @param {SessionState} state
   * @param {any} event
   */
  onTurnEnd(state, event) {
    if (state.guard !== null) {
      const endedGreen = event.data?.reason?.kind === 'completed'
      const summary = this.mechanisms.finishTurn(state.guard, {
        endedGreen,
        envelope: state.envelope,
      })
      if (summary?.recorded && state.envelope) {
        this.mechanisms.saveEnvelope(state.project, state.envelope)
      }
      if (summary?.summary) {
        state.judgeTokens += numberOrZero(summary.summary.judge_tokens)
        state.writerTokens += numberOrZero(summary.summary.writer_tokens)
      }
      state.guard = null
      state.guardTurn = -1
    }
    // Crash-safe snapshot after every turn; folding happens once at session end
    // (or at the next session's catch-up run).
    this.safe('snapshot', () => state.project.saveSessionSnapshot(/** @type {{sessionId: string}} */ (this.sessionSnapshot(state))))
  }

  /**
   * @param {import('@deepseek-ai/dsh-session').Session} session
   */
  onSessionDisposed(session) {
    const state = this.sessions.get(session.id)
    if (!state) return
    this.finalizeSession(state, 'session-disposed')
    this.sessions.delete(session.id)
    this.agentsBySession.delete(session.id)
  }

  /**
   * Persist, fold and account one session exactly once.
   *
   * @param {SessionState} state
   * @param {string} reason
   */
  finalizeSession(state, reason) {
    const config = state.config
    try {
      state.accumulator.markFinished(reason)
      const snapshot = this.sessionSnapshot(state)
      state.project.saveSessionSnapshot(/** @type {{sessionId: string}} */ (snapshot))
      this.foldSession(state.project, snapshot, config)
    } catch (error) {
      this.diagnostic({ level: 'error', scope: 'session-fold', message: 'session finalization failed', error: errorMessage(error) })
    }
  }

  /**
   * Fold one session snapshot into the learning state and usage ledger, once.
   *
   * @param {ProjectRuntime} project
   * @param {Record<string, any>} snapshot
   * @param {TokenEconomizerConfig} config
   */
  foldSession(project, snapshot, config) {
    const sessionId = String(snapshot.sessionId)
    if (project.isFolded(sessionId)) return
    if (config.microskills !== 'off') {
      const folded = this.mechanisms.foldMicroskills(project, snapshot, config)
      if (folded) project.saveMicroskills(folded)
    }
    if (config.toolprune !== 'off') {
      const folded = this.mechanisms.foldToolprune(project, snapshot, config)
      if (folded) project.saveToolprune(folded)
    }
    if (config.microskills !== 'off') {
      this.mechanisms.evaluateManualFacts(project, snapshot)
    }
    if (config.usageRecord) {
      const record = this.mechanisms.buildLedgerRecord(project, snapshot, {
        config,
        model: snapshot.model,
        nudges: snapshot.nudges ?? 0,
        aborts: snapshot.notices ?? 0,
        injectedChars: snapshot.injectedChars ?? 0,
        overhead: {
          ...this.mechanisms.overheadFor(sessionId),
          spiral_judge_tokens: numberOrZero(snapshot.judgeTokens),
          spiral_nudge_writer_tokens: numberOrZero(snapshot.writerTokens),
        },
      })
      project.appendLedger(record)
    }
    project.markFolded(sessionId, 'session-fold')
    if (config.microskills === 'on') {
      const micro = project.microskills()
      const sessions = typeof micro.sessions === 'number' ? micro.sessions : 0
      void this.mechanisms
        .maybeProposeMicroskills(project, config, sessions)
        .catch((error) => this.diagnostic({ level: 'info', scope: 'proposer', message: 'proposer failed', error: errorMessage(error) }))
    }
  }

  /**
   * Fold snapshots left unfolded by a crashed process.
   *
   * @param {ProjectRuntime} project
   * @param {TokenEconomizerConfig} config
   */
  foldPendingSessions(project, config) {
    for (const entry of project.unfoldedSessions(20)) {
      this.foldSession(project, entry.snapshot, config)
    }
  }

  /**
   * @param {SessionState} state
   * @returns {Record<string, any>}
   */
  sessionSnapshot(state) {
    const snapshot = state.accumulator.snapshot()
    return {
      ...snapshot,
      nudges: state.nudges,
      notices: state.notices,
      judgeTokens: state.judgeTokens,
      writerTokens: state.writerTokens,
      injectedIds: state.microskills.ids,
      injectedChars: state.microskills.text.length,
      toolprune: { ...state.verification },
    }
  }

  /**
   * Apply (or re-apply) the project's deny list to this agent.
   *
   * @param {SessionState} state
   * @returns {string[]}
   */
  applyRestriction(state) {
    const { project, config, agent } = state
    const runtime = this.mechanisms.denyListFor(project, config, this.globalToolNames())
    if (runtime.length === 0) {
      if (state.restriction) {
        this.safe('restriction-lift', () => state.restriction?.dispose())
        state.restriction = null
      }
      return []
    }
    try {
      if (state.restriction) state.restriction.dispose()
      const dispose = agent.ctx.tools.restrict({ deny: runtime })
      state.restriction = { dispose: typeof dispose === 'function' ? dispose : () => {}, deny: runtime }
      state.verification.deny = runtime
    } catch (error) {
      this.diagnostic({ level: 'warn', scope: 'toolprune', message: 'tool restriction refused by DSH', error: errorMessage(error) })
    }
    return runtime
  }

  /**
   * @param {SessionState} state
   * @param {any} event
   */
  recordPruningVerification(state, event) {
    if (state.restriction === null) return
    const tools = /** @type {{name?: unknown}[]} */ (Array.isArray(event.data?.header?.tools) ? event.data.header.tools : [])
    const visible = new Set(tools.map((tool) => tool?.name).filter((name) => typeof name === 'string'))
    state.verification.present = state.restriction.deny.filter((name) => visible.has(name))
    state.verification.absent = state.restriction.deny.filter((name) => !visible.has(name))
  }

  /**
   * @returns {string[]} Names in the global tool universe.
   */
  globalToolNames() {
    try {
      const tools = safeGet(this.ctx, 'tools')
      if (!tools || typeof tools.schemas !== 'function') return []
      const schemas = /** @type {{name?: unknown}[]} */ (tools.schemas())
      return schemas.map((schema) => schema?.name).filter((name) => typeof name === 'string')
    } catch {
      return []
    }
  }

  /**
   * Quiet-period handling for `toolprune=apply`.
   *
   * @param {ProjectRuntime} project
   * @param {TokenEconomizerConfig} config
   */
  maybeApplyPending(project, config) {
    if (config.toolprune !== 'apply') return
    const result = this.mechanisms.maybeApplyToolprune(project, config, Date.now())
    if (result?.applied?.length > 0) {
      project.saveToolprune(result.state)
      this.logger?.info?.('toolprune applied: %s', result.applied.join(', '))
    } else if (result?.state) {
      project.saveToolprune(result.state)
    }
  }

  /**
   * @param {any} childCtx
   */
  registerCommands(childCtx) {
    childCtx.commands.register({
      name: 'tokeneconomizer',
      description: 'Inspect or configure learned project knowledge, tool pruning, loop guard and token usage',
      input: { hint: '[status|microskills|toolprune|config|usage|diagnostics|reset] [args]' },
      handler: async (/** @type {{agent?: any, rawInput?: string}} */ { agent, rawInput }) => {
        try {
          const argv = splitCommand(rawInput ?? '')
          const sessionState = agent?.session?.id === undefined ? undefined : this.sessions.get(agent.session.id)
          const project = sessionState?.project ?? this.registry.forCwd(agent?.session?.header?.cwd ?? '')
          if (!project) return { kind: 'error', text: 'tokeneconomizer: this session has no project directory to identify.' }
          const effective = sessionState?.config ?? this.effectiveConfig(project)
          return await runCommand({
            runtime: project,
            config: effective,
            dataDir: this.dataDir,
            argv,
            hooks: this.commandHooks(project, sessionState),
          })
        } catch (error) {
          this.diagnostic({ level: 'error', scope: 'command', message: 'command failed', error: errorMessage(error) })
          return { kind: 'error', text: `tokeneconomizer: command failed (${truncate(errorMessage(error), 200)})` }
        }
      },
    })
  }

  /**
   * @param {ProjectRuntime} project
   * @param {SessionState|undefined} sessionState
   */
  commandHooks(project, sessionState) {
    const self = this
    return {
      effectiveConfig: () => (sessionState ? sessionState.config : self.effectiveConfig(project)),
      /** @param {string} key @param {unknown} value @returns {boolean} */
      setOverride: (key, value) => {
        const ok = project.setOverride(key, value)
        if (ok && sessionState) sessionState.config = self.effectiveConfig(project)
        return ok
      },
      /** @param {string} key @returns {boolean} */
      unsetOverride: (key) => {
        const ok = project.unsetOverride(key)
        if (ok && sessionState) sessionState.config = self.effectiveConfig(project)
        return ok
      },
      applyToolprune: async () => {
        const result = self.mechanisms.applyToolpruneNow(project, sessionState ? sessionState.config : self.effectiveConfig(project), self.globalToolNames(), Date.now())
        if (result.state) project.saveToolprune(result.state)
        if (sessionState) self.applyRestriction({ ...sessionState, config: sessionState.config })
        return { applied: result.applied, error: result.error }
      },
      /** @param {string[]} tools */
      restoreToolprune: async (tools) => {
        const result = self.mechanisms.restoreToolprune(project, tools, Date.now())
        if (result.state) project.saveToolprune(result.state)
        if (sessionState) self.applyRestriction(sessionState)
        return { restored: result.restored, error: result.error }
      },
      refreshCatalog: async () => ({ tools: self.globalToolNames().length }),
      resetProject: async () => project.reset(),
      /** @param {string} id */
      forgetFact: (id) => self.mechanisms.forgetFact(project, id),
    }
  }

  /**
   * @param {{level?: string, scope: string, message: string, error?: string}} record
   */
  diagnostic(record) {
    if (this.config.diagnostics === 'off') return
    if (!this.config.diagnosticsRecord) return
    writeDiagnostic(this.dataDir, {
      level: /** @type {'info'|'warn'|'error'} */ (record.level ?? 'error'),
      scope: record.scope,
      message: record.message,
      ...(record.error === undefined ? {} : { error: record.error }),
    }, this.config.diagnosticsMaxBytes)
  }

  /**
   * Run one adapter callback; failures never escape.
   *
   * @param {string} scope
   * @param {() => unknown} fn
   */
  safe(scope, fn) {
    try {
      const result = fn()
      if (result && typeof (/** @type {Promise<unknown>} */ (result).catch) === 'function') {
        /** @type {Promise<unknown>} */ (result).catch((error) => {
          this.diagnostic({ scope, message: 'async adapter callback failed', error: errorMessage(error) })
        })
      }
    } catch (error) {
      this.diagnostic({ scope, message: 'adapter callback failed', error: errorMessage(error) })
    }
  }
}

/**
 * Create the optional side-call adapter when the profile provides `ctx.llm`.
 * Any failure leaves model-assisted features off; the mechanisms stay usable.
 *
 * @param {Context} ctx
 * @param {TokenEconomizerConfig} config
 * @returns {Promise<any|null>}
 */
async function optionalSidecall(ctx, config) {
  const needsModel = config.microskills === 'on' || config.loopguardJudge
  if (!needsModel) return null
  try {
    const llm = safeGet(ctx, 'llm')
    if (!llm) return null
    const mod = await import('./sidecall.js')
    return mod.createSideCall(ctx, { timeoutMs: 60_000, purpose: 'tokeneconomizer', maxOutputTokens: 512 })
  } catch {
    return null
  }
}

/**
 * @param {Context} ctx
 * @returns {any}
 */
function safeLogger(ctx) {
  try {
    return typeof ctx.logger === 'function' ? ctx.logger('tokeneconomizer') : ctx.logger
  } catch {
    return undefined
  }
}

/**
 * @param {Context} ctx
 * @param {string} name
 * @returns {any}
 */
function safeGet(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name, false) : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {string} rawInput
 * @returns {string[]}
 */
function splitCommand(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (text === '') return ['status']
  return text.split(/\s+/)
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
