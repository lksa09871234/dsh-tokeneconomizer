/**
 * Configuration values, defaults and environment overrides for the
 * dsh-tokeneconomizer plugin.
 *
 * This module intentionally has no imports: the terminal CLI (`bin/te.js`) and
 * every mechanism import it, so it must load in a plain Node process without
 * any DSH package present. The Cordis loader schema lives in
 * `lib/config-schema.js`, which is imported only by the plugin entry.
 *
 * Defaults follow the upstream TokenEconomizer settings wherever the mechanism
 * is ported (see docs/UPSTREAM.md). Every setting has a `TE_`-prefixed
 * environment override, matching the upstream convention, so a single session
 * can be changed without editing the profile patch.
 *
 * @module dsh-tokeneconomizer/config
 */

/** Mechanism switch values accepted for `microskills`. */
export const MICROSKILLS_MODES = ['off', 'envfacts', 'on']
/** Mechanism switch values accepted for `toolprune`. */
export const TOOLPRUNE_MODES = ['off', 'propose', 'apply']
/** Mechanism switch values accepted for `loopguard`. */
export const LOOPGUARD_MODES = ['off', 'on']

/**
 * @typedef {object} TokenEconomizerConfig
 * @property {boolean} enabled Whole-plugin switch; false keeps the plugin inert.
 * @property {string} dataDir Absolute state directory; empty means `<DSH home>/tokeneconomizer`.
 * @property {'off'|'envfacts'|'on'} microskills Micro-skills mode: off, deterministic only, or on (adds optional model proposer).
 * @property {'off'|'propose'|'apply'} toolprune Tool pruning mode: off, suggest only, or hide pruned tools from the model.
 * @property {'off'|'on'} loopguard Failure-loop intervention switch.
 * @property {number} microskillsProposeEvery Sessions between model-proposer runs (upstream k).
 * @property {number} microskillsMaxChars Maximum characters injected as learned notes per session.
 * @property {number} microskillsMaxFacts Maximum facts injected per session.
 * @property {number} toolpruneEvidence Unused prompts required before proposing a tool (upstream p).
 * @property {number} toolpruneMinSessions Sessions those prompts must span (upstream m).
 * @property {number} toolpruneSessions Session count that alone is enough evidence (upstream s).
 * @property {number} toolpruneQuietMinutes Idle minutes before an applied deny list changes (upstream q).
 * @property {string[]} protectedTools Tools that are never pruned.
 * @property {number} loopguardEnvelopeMinSamples Well-behaved turns before the guard acts (upstream e).
 * @property {number} loopguardJudgeConfidence Minimum judge confidence (upstream c).
 * @property {number} loopguardNudges Redirects per turn before the guard only reports (upstream r).
 * @property {number} loopguardBackstopMultiplier Multiple of the usual turn length that permits a judge-free redirect (upstream b).
 * @property {number} loopguardJudgeMinIntervalMs Minimum milliseconds between optional judge calls in one turn.
 * @property {boolean} loopguardJudge Whether the optional model judge may be called at all.
 * @property {boolean} usageRecord Record actual token usage reported by the harness.
 * @property {boolean} diagnosticsRecord Write redacted diagnostics for plugin failures.
 * @property {'redacted'|'off'} diagnostics Verbosity of diagnostics records.
 * @property {number} diagnosticsMaxBytes Maximum bytes retained for the diagnostics file.
 */

/**
 * Default configuration. Values here are the documented defaults; changing one
 * is a user-visible behavior change and must update README + CHANGELOG.
 * @type {TokenEconomizerConfig}
 */
export const DEFAULTS = {
  enabled: true,
  dataDir: '',
  microskills: 'off',
  toolprune: 'propose',
  loopguard: 'on',
  microskillsProposeEvery: 3,
  microskillsMaxChars: 600,
  microskillsMaxFacts: 4,
  toolpruneEvidence: 10,
  toolpruneMinSessions: 2,
  toolpruneSessions: 5,
  toolpruneQuietMinutes: 60,
  protectedTools: [],
  loopguardEnvelopeMinSamples: 5,
  loopguardJudgeConfidence: 0.7,
  loopguardNudges: 1,
  loopguardBackstopMultiplier: 2.5,
  loopguardJudgeMinIntervalMs: 120_000,
  loopguardJudge: true,
  usageRecord: true,
  diagnosticsRecord: true,
  diagnostics: 'redacted',
  diagnosticsMaxBytes: 65_536,
}

/**
 * Map of configuration key -> environment variable name, following upstream's
 * `TE_` convention. Booleans use 1/0/on/off/true/false; mechanism modes accept
 * their documented strings.
 * @type {Readonly<Record<keyof TokenEconomizerConfig, string>>}
 */
export const ENV_VARS = Object.freeze({
  enabled: 'TE_ENABLED',
  dataDir: 'TE_DATA_DIR',
  microskills: 'TE_MICROSKILLS',
  toolprune: 'TE_TOOLPRUNE',
  loopguard: 'TE_LOOPGUARD',
  microskillsProposeEvery: 'TE_MICROSKILLS_PROPOSE_EVERY',
  microskillsMaxChars: 'TE_MICROSKILLS_MAX_CHARS',
  microskillsMaxFacts: 'TE_MICROSKILLS_MAX_FACTS',
  toolpruneEvidence: 'TE_TOOLPRUNE_EVIDENCE',
  toolpruneMinSessions: 'TE_TOOLPRUNE_MIN_SESSIONS',
  toolpruneSessions: 'TE_TOOLPRUNE_SESSIONS',
  toolpruneQuietMinutes: 'TE_TOOLPRUNE_QUIET_MINUTES',
  protectedTools: 'TE_TOOLPRUNE_PROTECTED',
  loopguardEnvelopeMinSamples: 'TE_LOOPGUARD_ENVELOPE_MIN_SAMPLES',
  loopguardJudgeConfidence: 'TE_LOOPGUARD_JUDGE_CONFIDENCE',
  loopguardNudges: 'TE_LOOPGUARD_NUDGES',
  loopguardBackstopMultiplier: 'TE_LOOPGUARD_BACKSTOP_MULT',
  loopguardJudgeMinIntervalMs: 'TE_LOOPGUARD_JUDGE_MIN_INTERVAL_MS',
  loopguardJudge: 'TE_LOOPGUARD_JUDGE',
  usageRecord: 'TE_USAGE_RECORD',
  diagnosticsRecord: 'TE_DIAGNOSTICS_RECORD',
  diagnostics: 'TE_DIAGNOSTICS',
  diagnosticsMaxBytes: 'TE_DIAGNOSTICS_MAX_BYTES',
})

/**
 * Whole-plugin kill switch. `TE_DISABLE=1` turns the plugin off without
 * touching the profile configuration, like upstream.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isDisabledByEnv(env = process.env) {
  const raw = env.TE_DISABLE
  if (raw === undefined) return false
  return parseBool(raw)
}

/**
 * Parse a boolean-ish environment value. Unrecognized text falls back to false
 * so a typo never silently enables an expensive mechanism.
 * @param {string} raw
 * @returns {boolean}
 */
export function parseBool(raw) {
  const text = String(raw).trim().toLowerCase()
  return text === '1' || text === 'on' || text === 'true' || text === 'yes'
}

/**
 * @param {string} raw
 * @param {number} fallback
 * @returns {number}
 */
function parseNumber(raw, fallback) {
  const n = Number.parseFloat(String(raw).trim())
  return Number.isFinite(n) ? n : fallback
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
function parseList(raw) {
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/**
 * Apply `TE_*` environment overrides on top of a validated config. Unknown
 * environment values keep the previous value and are reported in `warnings`
 * instead of failing the whole plugin.
 *
 * @param {TokenEconomizerConfig} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ config: TokenEconomizerConfig, warnings: string[] }}
 */
export function applyEnvOverrides(config, env = process.env) {
  /** @type {TokenEconomizerConfig} */
  const next = { ...config }
  /** @type {string[]} */
  const warnings = []

  for (const [key, envName] of Object.entries(ENV_VARS)) {
    const raw = env[envName]
    if (raw === undefined || raw.trim() === '') continue
    const typedKey = /** @type {keyof TokenEconomizerConfig} */ (key)
    switch (typedKey) {
      case 'enabled':
        next.enabled = parseBool(raw)
        break
      case 'microskills': {
        const value = raw.trim().toLowerCase()
        if (value === 'on' || value === 'off' || value === 'envfacts') next.microskills = value
        else warnings.push(`${envName} must be on, off, or envfacts; ignored`)
        break
      }
      case 'toolprune': {
        const value = raw.trim().toLowerCase()
        if (value === 'on') next.toolprune = 'apply'
        else if (value === 'off' || value === 'propose' || value === 'apply') next.toolprune = value
        else warnings.push(`${envName} must be off, propose, or apply; ignored`)
        break
      }
      case 'loopguard': {
        const value = raw.trim().toLowerCase()
        if (value === 'on' || value === 'off') next.loopguard = value
        else warnings.push(`${envName} must be on or off; ignored`)
        break
      }
      case 'protectedTools':
        next.protectedTools = parseList(raw)
        break
      case 'diagnostics': {
        const value = raw.trim().toLowerCase()
        if (value === 'redacted' || value === 'off') next.diagnostics = value
        else warnings.push(`${envName} must be redacted or off; ignored`)
        break
      }
      case 'diagnosticsRecord':
        next.diagnosticsRecord = parseBool(raw)
        break
      case 'loopguardJudge':
        next.loopguardJudge = parseBool(raw)
        break
      case 'usageRecord':
        next.usageRecord = parseBool(raw)
        break
      case 'dataDir':
        next.dataDir = raw.trim()
        break
      default: {
        const current = next[typedKey]
        if (typeof current === 'number') {
          const parsed = parseNumber(raw, current)
          ;/** @type {Record<string, unknown>} */ (next)[typedKey] = parsed
        }
        break
      }
    }
  }
  return { config: next, warnings }
}

/**
 * Resolve the effective configuration for one plugin load: defaults, then the
 * profile-provided config, then environment overrides. Validation errors are
 * thrown to the caller (the plugin entry) which degrades to inert instead of
 * crashing the host.
 *
 * @param {Partial<TokenEconomizerConfig> | undefined} provided
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ config: TokenEconomizerConfig, warnings: string[] }}
 */
export function resolveEffectiveConfig(provided, env = process.env) {
  const merged = { ...DEFAULTS, ...(provided ?? {}) }
  const { config, warnings } = applyEnvOverrides(merged, env)
  if (isDisabledByEnv(env)) config.enabled = false
  return { config, warnings }
}
