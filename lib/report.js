/**
 * Human and machine-readable views over one project's plugin state.
 *
 * Shared by the DSH slash command and the terminal CLI so both render the same
 * facts from the same documents. The views never claim savings or prices: they
 * report what was recorded, and mark missing data as unknown.
 *
 * @module dsh-tokeneconomizer/report
 */

import { displayPath } from './project.js'
import { VERSION } from './version.js'

/**
 * Format a token count compactly. Missing values are `n/a`.
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function fmtTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(Math.round(value))
}

/**
 * @param {number|null|undefined} part
 * @param {number|null|undefined} total
 * @returns {string}
 */
export function fmtFraction(part, total) {
  if (typeof part !== 'number' || typeof total !== 'number' || total <= 0) return 'n/a'
  return `${((part / total) * 100).toFixed(1)}%`
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * Sum the mechanism overhead keys of one ledger record (upstream OVERHEAD_KEYS).
 * @param {Record<string, unknown>} record
 * @returns {number}
 */
export function overheadOf(record) {
  const overhead = isRecord(record.overhead) ? record.overhead : {}
  let sum = 0
  for (const value of Object.values(overhead)) {
    if (typeof value === 'number' && Number.isFinite(value)) sum += value
  }
  return sum
}

/**
 * Summarize ledger records using only recorded values. Tokens are counts, never
 * currency; a session without provider usage contributes no execution tokens.
 *
 * @param {Record<string, unknown>[]} records
 * @returns {{
 *   sessions: number, pricedSessions: number, effectiveTokens: number, overheadTokens: number,
 *   overheadFraction: number|null, requests: number, nudges: number, aborts: number, turns: number,
 *   injectedSessions: number, unknownUsageSessions: number, unpricedSessions: number,
 * }}
 */
export function summarizeLedger(records) {
  let sessions = 0
  let pricedSessions = 0
  let effectiveTokens = 0
  let overheadTokens = 0
  let requests = 0
  let nudges = 0
  let aborts = 0
  let turns = 0
  let injectedSessions = 0
  let unknownUsageSessions = 0
  let unpricedSessions = 0
  for (const record of records) {
    if (!isRecord(record)) continue
    if (record.kind !== 'session' && record.kind !== 'overhead') continue
    overheadTokens += overheadOf(record)
    if (record.kind === 'overhead') continue
    sessions += 1
    requests += numberOrZero(record.requests)
    nudges += numberOrZero(record.nudges)
    aborts += numberOrZero(record.aborts)
    turns += numberOrZero(record.turns)
    if (numberOrZero(record.injected_chars) > 0) injectedSessions += 1
    const pricedBy = typeof record.priced_by === 'string' ? record.priced_by : 'no_usage'
    if (pricedBy === 'no_usage') {
      unknownUsageSessions += 1
      continue
    }
    if (pricedBy === 'fallback') unpricedSessions += 1
    pricedSessions += 1
    if (typeof record.effective_tokens === 'number' && Number.isFinite(record.effective_tokens)) {
      effectiveTokens += record.effective_tokens
    }
  }
  return {
    sessions,
    pricedSessions,
    effectiveTokens,
    overheadTokens,
    overheadFraction: sessions > 0 ? overheadTokens / (effectiveTokens + overheadTokens || 1) : null,
    requests,
    nudges,
    aborts,
    turns,
    injectedSessions,
    unknownUsageSessions,
    unpricedSessions,
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Build the full machine-readable status object for one project. The field names
 * are a compatibility surface: `status --json` uses them verbatim.
 *
 * @param {import('./dsh/project-runtime.js').ProjectRuntime} runtime
 * @param {object} options
 * @param {import('./config.js').TokenEconomizerConfig} options.config Effective configuration.
 * @param {string} options.dataDir Plugin data directory.
 * @param {string} [options.agentNote] Optional per-session note.
 * @returns {Record<string, unknown>}
 */
export function buildStatus(runtime, { config, dataDir, agentNote }) {
  const project = runtime.recordProject()
  const micro = runtime.microskills()
  const tool = runtime.toolprune()
  const envelope = runtime.envelope()
  const ledger = summarizeLedger(runtime.readLedger(2000))

  const facts = isRecord(micro.facts) ? micro.facts : {}
  const factRows = Object.entries(facts).map(([id, value]) => factRow(id, value))
  const renderedIds = Array.isArray(micro.rendered_ids) ? micro.rendered_ids.map(String) : []

  const proposal = Array.isArray(tool.proposal) ? tool.proposal.map(String) : []
  const applied = Array.isArray(tool.applied) ? tool.applied.map(String) : []
  const kept = Array.isArray(tool.kept) ? tool.kept.map(String) : []
  const pending = isRecord(tool.auto_pending) && Array.isArray(tool.auto_pending.items) ? tool.auto_pending.items.map(String) : []
  const resolvedTurns = Array.isArray(envelope.resolved_turns) ? envelope.resolved_turns.filter((v) => typeof v === 'number') : []

  return {
    plugin: { name: 'dsh-tokeneconomizer', version: VERSION },
    repo: {
      label: project.label,
      root: project.cwdDisplay,
      key: runtime.key,
      identifiedBy: 'session cwd',
    },
    stateDir: displayPath(dataDir),
    config: {
      enabled: config.enabled,
      microskills: config.microskills,
      toolprune: config.toolprune,
      loopguard: config.loopguard,
      dataDir: config.dataDir === '' ? '' : displayPath(config.dataDir),
    },
    microskills: {
      profile: config.microskills,
      sessionsFolded: numberOrZero(micro.sessions),
      injectedLines: renderedIds.length,
      renderedChars: numberOrZero(micro.rendered_chars),
      renderedIds,
      activeFacts: factRows.filter((row) => row.state === 'active').length,
      formingFacts: factRows.filter((row) => row.state === 'candidate').length,
      retiredFacts: factRows.filter((row) => row.state === 'retired').length,
      recentFacts: factRows.slice(-20),
      note: agentNote ?? null,
    },
    toolprune: {
      mode: config.toolprune,
      sessions: numberOrZero(tool.sessions),
      prompts: numberOrZero(tool.prompts),
      catalogSource: typeof tool.catalog_source === 'string' ? tool.catalog_source : null,
      catalogTools: Array.isArray(tool.catalog_tools) ? tool.catalog_tools.length : 0,
      proposal,
      pending,
      applied,
      kept,
      refused: typeof tool.auto_apply_refused === 'string' ? tool.auto_apply_refused : null,
    },
    loopguard: {
      mode: config.loopguard,
      endedGreenTurns: resolvedTurns.length,
      envelope: envelopeOf(resolvedTurns, config),
      nudges: ledger.nudges,
      aborts: ledger.aborts,
    },
    ledger,
  }
}

/**
 * @param {string} id
 * @param {unknown} value
 * @returns {{id: string, state: string, claim: string, fireNum: number, fireDen: number, confirms: number, contradicts: number}}
 */
function factRow(id, value) {
  const record = isRecord(value) ? value : {}
  const life = isRecord(record.life) ? record.life : isRecord(record) ? record : {}
  const confirms = Array.isArray(life.confirms) ? life.confirms.length : numberOrZero(life.confirms)
  const contradicts = Array.isArray(life.contradicts) ? life.contradicts.length : numberOrZero(life.contradicts)
  return {
    id,
    state: typeof life.state === 'string' ? life.state.toLowerCase() : 'unknown',
    claim: typeof record.claim === 'string' ? record.claim : typeof record.injection === 'string' ? record.injection : '',
    fireNum: numberOrZero(life.fire_num),
    fireDen: numberOrZero(life.fire_den),
    confirms,
    contradicts,
  }
}

/**
 * Learned envelope = p90(resolved turns) * margin once enough green turns exist.
 * @param {number[]} resolvedTurns
 * @param {import('./config.js').TokenEconomizerConfig} config
 * @returns {number|null}
 */
function envelopeOf(resolvedTurns, config) {
  if (resolvedTurns.length < config.loopguardEnvelopeMinSamples) return null
  const sorted = [...resolvedTurns].sort((a, b) => a - b)
  const p = 90
  const rank = ((sorted.length - 1) * p) / 100
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  const value = sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
  return Math.round(value * 1.25 * 10) / 10
}

/**
 * Render the status view as text.
 * @param {ReturnType<typeof buildStatus>} view
 * @returns {string}
 */
export function renderStatusText(view) {
  const status = /** @type {Record<string, any>} */ (view)
  const lines = []
  lines.push(`dsh-tokeneconomizer ${status.plugin.version}`)
  lines.push(`repo: ${status.repo.label}  (${status.repo.root})`)
  lines.push(`state: ${status.stateDir}`)
  lines.push('')
  lines.push(`microskills: ${status.microskills.profile} — ${status.microskills.sessionsFolded} session(s) folded, ${status.microskills.activeFacts} active fact(s), ${status.microskills.injectedLines} injected`)
  lines.push(`toolprune:   ${status.toolprune.mode} — ${status.toolprune.sessions} session(s), ${status.toolprune.prompts} prompt(s) counted, ${status.toolprune.catalogTools} catalog tool(s)`)
  if (status.toolprune.proposal.length > 0) lines.push(`             proposal: ${status.toolprune.proposal.join(', ')}`)
  if (status.toolprune.applied.length > 0) lines.push(`             applied:  ${status.toolprune.applied.join(', ')}`)
  if (status.toolprune.kept.length > 0) lines.push(`             given back: ${status.toolprune.kept.join(', ')}`)
  if (status.toolprune.pending.length > 0) lines.push(`             pending:  ${status.toolprune.pending.join(', ')}`)
  if (status.toolprune.refused) lines.push(`             last apply refused: ${status.toolprune.refused}`)
  const envelope = status.loopguard.envelope
  lines.push(`loopguard:   ${status.loopguard.mode} — ${status.loopguard.endedGreenTurns} green turn(s); envelope ${envelope === null ? 'not learned yet' : `${envelope} tool calls`}`)
  lines.push('')
  const ledger = status.ledger
  lines.push(`usage recorded: ${ledger.sessions} session(s), ${ledger.requests} request(s), ${ledger.turns} turn(s)`)
  lines.push(`  effective tokens (recorded): ${fmtTokens(ledger.effectiveTokens)}${ledger.unknownUsageSessions > 0 ? ` (${ledger.unknownUsageSessions} session(s) without provider usage — unknown)` : ''}`)
  lines.push(`  plugin overhead tokens:      ${fmtTokens(ledger.overheadTokens)} (${fmtFraction(ledger.overheadTokens, ledger.effectiveTokens + ledger.overheadTokens)} of recorded total)`)
  lines.push(`  redirects/notices: ${ledger.nudges}; still-stuck notices: ${ledger.aborts}`)
  lines.push('')
  lines.push('No prices or savings are computed here: DSH reports tokens, not money.')
  return lines.join('\n')
}

/**
 * Render the micro-skills view.
 * @param {ReturnType<typeof buildStatus>} view
 * @returns {string}
 */
export function renderMicroskillsText(view) {
  const status = /** @type {Record<string, any>} */ (view)
  const lines = [`microskills: ${status.microskills.profile}`]
  if (status.microskills.renderedIds.length === 0) {
    lines.push('(nothing injected yet: no fact has cleared its firing gate)')
  } else {
    lines.push(`injected facts (${status.microskills.renderedIds.length}):`)
    for (const id of status.microskills.renderedIds) lines.push(`  - ${id}`)
  }
  if (status.microskills.recentFacts.length > 0) {
    lines.push('facts tracked:')
    for (const fact of status.microskills.recentFacts) {
      const state = fact.state.toUpperCase()
      lines.push(`  ${state} fire=${fact.fireNum}/${fact.fireDen} confirms=${fact.confirms} contradicts=${fact.contradicts} ${fact.claim || fact.id}`)
    }
  } else {
    lines.push('facts tracked: none yet')
  }
  return lines.join('\n')
}

/**
 * Render the tool-pruning view.
 * @param {ReturnType<typeof buildStatus>} view
 * @returns {string}
 */
export function renderToolpruneText(view) {
  const status = /** @type {Record<string, any>} */ (view)
  const t = status.toolprune
  const lines = [`toolprune: ${t.mode}`, `sessions folded: ${t.sessions}; prompts counted: ${t.prompts}; catalog: ${t.catalogTools} tool(s)${t.catalogSource ? ` (${t.catalogSource})` : ''}`]
  if (t.proposal.length > 0) {
    lines.push(`proposal (${t.proposal.length}): ${t.proposal.join(', ')}`)
    lines.push(`  evidence rule: ${t.mode === 'apply' ? 'applied on the next quiet window' : 'propose only — run `toolprune apply` to enable'}`)
  } else {
    lines.push('proposal: none (insufficient evidence or every loaded tool has been used)')
  }
  if (t.pending.length > 0) lines.push(`pending: ${t.pending.join(', ')}`)
  if (t.applied.length > 0) lines.push(`applied (hidden from this project's model requests): ${t.applied.join(', ')}`)
  if (t.kept.length > 0) lines.push(`given back (never proposed again): ${t.kept.join(', ')}`)
  if (t.refused) lines.push(`last apply refused: ${t.refused}`)
  return lines.join('\n')
}

/**
 * Render the usage ledger view.
 * @param {ReturnType<typeof buildStatus>} view
 * @param {Record<string, unknown>[]} [records]
 * @returns {string}
 */
export function renderUsageText(view, records = []) {
  const status = /** @type {Record<string, any>} */ (view)
  const ledger = status.ledger
  const lines = [`usage for ${status.repo.label}`]
  lines.push(`sessions: ${ledger.sessions}; requests: ${ledger.requests}; turns: ${ledger.turns}`)
  lines.push(`effective tokens: ${fmtTokens(ledger.effectiveTokens)} (recorded cache-aware comparison units, not currency)`)
  lines.push(`plugin overhead tokens: ${fmtTokens(ledger.overheadTokens)} (${fmtFraction(ledger.overheadTokens, ledger.effectiveTokens + ledger.overheadTokens)} of recorded total)`)
  if (ledger.unknownUsageSessions > 0) lines.push(`sessions without provider usage: ${ledger.unknownUsageSessions} — their tokens are unknown, not zero`)
  if (ledger.unpricedSessions > 0) lines.push(`sessions with unpriced model: ${ledger.unpricedSessions} — priced with the labelled fallback weights`)
  if (records.length > 0) {
    lines.push('')
    lines.push('recent sessions:')
    for (const record of records.slice(-8)) {
      const view = /** @type {Record<string, any>} */ (record)
      const when = typeof view.folded_at === 'string' ? view.folded_at : ''
      lines.push(`  ${when} model=${view.model ?? 'unknown'} input=${fmtTokens(view.input_tokens)} cacheRead=${fmtTokens(view.cache_read_input_tokens)} output=${fmtTokens(view.output_tokens)} effective=${fmtTokens(view.effective_tokens)}`)
    }
  }
  lines.push('')
  lines.push('Cost in currency and savings percentages are not available: they are not derivable from tokens alone here.')
  return lines.join('\n')
}

/**
 * Render the effective configuration.
 * @param {import('./config.js').TokenEconomizerConfig} config
 * @param {Record<string, unknown>} [overrides]
 * @returns {string}
 */
export function renderConfigText(config, overrides = {}) {
  const lines = ['configuration in effect:']
  for (const key of Object.keys(config).sort()) {
    const value = /** @type {Record<string, unknown>} */ (config)[key]
    const source = key in overrides ? 'project' : 'default/profile'
    lines.push(`  ${key} = ${JSON.stringify(value)}  (${source})`)
  }
  return lines.join('\n')
}

/**
 * Render the command help.
 * @returns {string}
 */
export function renderHelpText() {
  return [
    'dsh-tokeneconomizer commands:',
    '  status [--json]              what was learned/recorded for this project',
    '  microskills                  learned facts (active and forming)',
    '  microskills forget <id>      delete one learned fact (env-fact or model-assisted)',
    '  toolprune [show]             pruning evidence, proposal and applied list',
    '  toolprune apply              enable the current proposal for this project',
    '  toolprune restore            give pruned tools back (never proposed again)',
    '  toolprune refresh-catalog    re-count catalog usage without a model call',
    '  config show                  every setting in effect',
    '  config set key=value         override a setting for this project',
    '  config unset key             remove a project override',
    '  usage                        recorded token usage (no prices)',
    '  diagnostics                  recent redacted plugin diagnostics',
    '  reset --yes                  delete this project\'s learned state',
    '  help                         this text',
  ].join('\n')
}
