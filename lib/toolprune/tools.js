/**
 * Tool sets that tool pruning never touches, plus the high-risk evidence factor.
 *
 * Ported from `tokeneconomizer/toolprune/tools.py` (Apache-2.0,
 * microsoft/TokenEconomizer @ e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9).
 * Modified for the DSH port: tool names are DSH/DeepSeek Harness names (with the
 * upstream work-surface spellings kept as aliases because learned state and
 * fixtures may still carry them), the list is exported as data instead of being
 * hard-wired into the stage, and the per-task LLM judge is not ported (DSH has
 * no problem-statement source at pruning time; see docs/PORT-NOTES-toolprune.md).
 *
 * Upstream rules preserved here:
 * - `PROTECTED_TOOLS` is the work surface (shell, read, edit, search) on every
 *   agent; nothing prunes it (`upstream toolprune/tools.py:40-48`).
 * - `HIGH_RISK_FACTOR` is the evidence multiplier for a tool whose loss would
 *   break a run (upstream: `plugin/adapter.py:59-61`, `HIGH_RISK` =
 *   `{"NotebookEdit"}`, factor 3).
 * - `INAPPLICABLE_TOOLS` are tools that cannot help one sealed headless task by
 *   construction (orchestration, scheduling, session memory, interactive
 *   questions). The DSH port keeps the concept for documentation and for the
 *   adapter's optional "never even load" list; this module does not prune them
 *   by itself.
 *
 * @module dsh-tokeneconomizer/toolprune/tools
 */

/**
 * Evidence multiplier for a tool in {@link HIGH_RISK_TOOLS}: it must go unused
 * for this many times the normal prompt/session evidence before it is proposed
 * (upstream `HIGH_RISK_FACTOR = 3`).
 */
export const HIGH_RISK_FACTOR = 3

/**
 * The work surface: tools that must always stay available regardless of usage.
 * Both DSH names and the upstream spellings are included; the DSH adapter may
 * extend the set per profile through `protectedTools` configuration.
 * @type {ReadonlyArray<string>}
 */
export const PROTECTED_TOOLS = Object.freeze([
  // --- DSH work-surface names ------------------------------------------------
  'bash',
  'pwsh',
  'ops_bash',
  'read',
  'write',
  'edit',
  'multi_edit',
  'glob',
  'grep',
  'read_file',
  'list_dir',
  'run_code',
  // Web access is protected upstream in the live plugin ("the web tools ...
  // become protected"; `plugin/fold.py:139-151`), so a learned rule for it is
  // given back rather than kept.
  'web_search',
  'web_fetch',
  // --- upstream spellings, kept as aliases ----------------------------------
  'shell',
  'view',
  'create',
  'str_replace',
  'str_replace_editor',
  'multiedit',
  'apply_patch',
  'read_bash',
  'stop_bash',
  'list_bash',
  'Bash',
  'Edit',
  'Write',
  'Read',
  'Grep',
  'Glob',
  'MultiEdit',
])

/**
 * Tools whose loss is expensive to discover ("a wrong belief would break the
 * run"): they need {@link HIGH_RISK_FACTOR} times the evidence. Upstream's set
 * is `{"NotebookEdit"}`; the DSH port keeps the name as an alias and adds the
 * snake-case spelling an MCP/DSH tool registry may use.
 * @type {ReadonlySet<string>}
 */
export const HIGH_RISK_TOOLS = new Set(['NotebookEdit', 'notebook_edit'])

/**
 * Tools inapplicable by construction for a single headless task (kept for the
 * adapter's optional pre-filter and for documentation). Names are the upstream
 * list's semantics; the DSH adapter should extend with its own orchestration /
 * scheduling / interactive tool names. Nothing here is pruned by this module.
 * @type {ReadonlyArray<string>}
 */
export const INAPPLICABLE_TOOLS = Object.freeze([
  // sub-agent orchestration: nothing to delegate to in one sealed task
  'task',
  'subagent',
  'list_agents',
  'read_agent',
  'write_agent',
  'workflow',
  // session DB / scheduling / skills / CLI self-docs
  'sql',
  'session_store_sql',
  'manage_schedule',
  'schedule_create',
  'schedule_delete',
  'schedule_list',
  'schedule_update',
  'skill',
  'fetch_copilot_cli_documentation',
  // persistent memory and its vote tool
  'store_memory',
  'vote_memory',
  // interactive Q&A: a headless run can never get an answer
  'ask_user',
  'ask_user_question',
  // plan-mode / worktree session controls
  'enter_plan_mode',
  'exit_plan_mode',
  'enter_worktree',
  'exit_worktree',
])

/**
 * @param {ReadonlyArray<string>} [extra] Additional protected tool names from configuration.
 * @returns {Set<string>} The effective protected set.
 */
export function effectiveProtectedTools(extra = []) {
  const set = new Set(PROTECTED_TOOLS)
  for (const name of extra) {
    if (typeof name === 'string' && name.length > 0) set.add(name)
  }
  return set
}

/**
 * @param {string} name Tool name.
 * @param {ReadonlyArray<string>} [extra] Additional protected tool names.
 * @returns {boolean} True when the tool must never be proposed or pruned.
 */
export function isProtectedTool(name, extra = []) {
  if (typeof name !== 'string' || name.length === 0) return false
  return effectiveProtectedTools(extra).has(name)
}

/**
 * @param {string} name Tool name.
 * @returns {boolean} True when the tool needs {@link HIGH_RISK_FACTOR} times the evidence.
 */
export function isHighRiskTool(name) {
  return typeof name === 'string' && HIGH_RISK_TOOLS.has(name)
}
