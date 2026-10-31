/**
 * Shared fixtures for the micro-skills unit tests.
 *
 * The scenarios mirror upstream `tests/test_envfacts.py` and
 * `tests/test_envfacts_args.py`; the expected values in the test files were
 * cross-checked against the upstream Python implementation by replaying the
 * same sessions through both (see docs/PORT-NOTES-microskills.md).
 *
 * @module dsh-tokeneconomizer/test/unit/microskills/helpers
 */

import { GENERIC, observeSession } from '../../../lib/microskills/observe.js'

export const PYTHON_BASE = '/opt/env/base/bin/python'
export const PROJ = '/opt/env/proj/bin/python'
export const LOCAL_PYTEST = '~/.local/bin/pytest'
export const OK = 'Ran 4 tests in 0.1s\n\nOK'
export const NEED = 'Traceback (most recent call last):\n  ...\nRuntimeError: settings are missing. Define the environment variable APP_SETTINGS before importing app.'
export const CANT_OPEN = "Exit code 2\npython: can't open file 'runtests.py': [Errno 2] No such file or directory"

/**
 * @typedef {import('../../../lib/microskills/observe.js').NormalizedCall} NormalizedCall
 */

/**
 * One normalized bash tool call.
 *
 * @param {string} command
 * @param {string} [output]
 * @param {number} [code]
 * @returns {NormalizedCall}
 */
export function cmd(command, output = '', code = 0) {
  return { tool: 'bash', args: { command }, resultText: output, failed: code !== 0, exitCode: code }
}

/**
 * One normalized edit-tool call.
 *
 * @param {string} file
 * @returns {NormalizedCall}
 */
export function edit(file) {
  return { tool: 'edit', args: { file_path: file }, resultText: 'ok', failed: false, exitCode: 0 }
}

/**
 * Attach a per-call working directory (the DSH adapter may report one; upstream
 * got it from Claude Code's transcript).
 *
 * @param {NormalizedCall} call
 * @param {string} cwd
 * @returns {NormalizedCall}
 */
export function at(call, cwd) {
  return { ...call, cwd }
}

/**
 * Classify one session's calls with the plugin's generic vocabulary.
 *
 * @param {NormalizedCall[]} calls
 * @param {{cwd?: string, repoRoot?: string|null}} [options]
 * @returns {ReturnType<typeof observeSession>}
 */
export function observe(calls, options = {}) {
  return observeSession(calls, { vocab: GENERIC, ...options })
}

/**
 * Upstream `_stream`: render a block for the next session, then fold one session.
 *
 * @param {import('../../../lib/microskills/envfacts.js').EnvFactsModel} model
 * @param {number} count
 * @param {(index: number) => NormalizedCall[]} maker
 * @returns {import('../../../lib/microskills/envfacts.js').EnvFactsModel}
 */
export function stream(model, count, maker) {
  for (let index = 0; index < count; index += 1) {
    model.render()
    model.update(observe(maker(index)), { iid: `t-${index}`, resolved: true })
  }
  return model
}

// ---- session makers (upstream test_envfacts.py) ------------------------------------------

/**
 * Bare runner fails on the base interpreter; the explicit path works.
 *
 * @param {number} index
 * @returns {NormalizedCall[]}
 */
export function brokenEnv(index) {
  return [
    edit(`pkg/mod${index}.py`),
    cmd('python -m pytest tests/test_a.py -q', `${PYTHON_BASE}: No module named pytest`, 1),
    cmd(`${PROJ} -m pytest tests/test_a.py -q`, '1 passed in 0.2s', 0),
  ]
}

/**
 * @param {number} index
 * @returns {NormalizedCall[]}
 */
export function cleanEnv(index) {
  return [edit(`pkg/m${index}.py`), cmd('python -m pytest tests/test_a.py -q', '1 passed', 0)]
}

/**
 * The bare runner is missing; `python -m pytest` works at once.
 *
 * @param {number} index
 * @returns {NormalizedCall[]}
 */
export function cleanRunner(index) {
  return [
    edit(`pkg/c${index}.py`),
    cmd('pytest -q', 'bash: pytest: command not found', 127),
    cmd('python -m pytest -q', '4 passed in 0.01s', 0),
  ]
}

/**
 * The environment was fixed: the bare runner works again.
 *
 * @param {number} index
 * @returns {NormalizedCall[]}
 */
export function fixedEnv(index) {
  return [edit(`pkg/f${index}.py`), cmd('python -m pytest tests/test_a.py -q', '1 passed', 0)]
}

/**
 * Seen live on Claude Code: the bare runner fails twice, a user-site pytest
 * stops at collection, and only `PYTHONPATH=. ~/.local/bin/pytest` passes.
 *
 * @param {number} index
 * @returns {NormalizedCall[]}
 */
export function messyEnv(index) {
  const collectionError = "E   ModuleNotFoundError: No module named 'stock'\nInterrupted: 1 error during collection\n1 error in 0.08s"
  return [
    edit(`pkg/m${index}.py`),
    cmd('pytest -q', 'bash: pytest: command not found', 127),
    cmd('pytest -q', 'bash: pytest: command not found', 127),
    cmd(`${LOCAL_PYTEST} -q`, collectionError, 2),
    cmd(`PYTHONPATH=. ${LOCAL_PYTEST} -q`, '4 passed in 0.01s', 0),
    cmd(`PYTHONPATH=. ${LOCAL_PYTEST} -q`, '4 passed in 0.01s', 0),
  ]
}

/**
 * The environment lost pytest altogether.
 *
 * @param {number} index
 * @returns {NormalizedCall[]}
 */
export function goneEnv(index) {
  return [
    edit(`pkg/g${index}.py`),
    cmd('pytest -q', 'bash: pytest: command not found', 127),
    cmd('python -m pytest -q', `${PYTHON_BASE}: No module named pytest`, 1),
  ]
}

/**
 * Three bare failures, then the same repair twice (one evidence per form).
 *
 * @param {number} index
 * @returns {NormalizedCall[]}
 */
export function repeatedEnv(index) {
  return [
    edit(`pkg/r${index}.py`),
    cmd('pytest -q', 'bash: pytest: command not found', 127),
    cmd('pytest -q', 'bash: pytest: command not found', 127),
    cmd('pytest -q', 'bash: pytest: command not found', 127),
    cmd(`${PROJ} -m pytest -q`, '1 passed', 0),
    cmd(`${PROJ} -m pytest -q`, '1 passed', 0),
  ]
}

/**
 * One test-runner call through `tests/runtests.py` with an output.
 *
 * @param {string} label
 * @param {string} output
 * @param {number} [code]
 * @returns {NormalizedCall}
 */
export function argRun(label, output, code = 0) {
  return cmd(`python tests/runtests.py ${label} -v 2 2>&1 | tail -20`, output, code)
}

/**
 * One `python -c` call, optionally with an inline assignment.
 *
 * @param {string} code
 * @param {string} [envPrefix]
 * @param {string} [output]
 * @param {number} [exitCode]
 * @returns {NormalizedCall}
 */
export function pyCmd(code, envPrefix = '', output = '', exitCode = 0) {
  return cmd(`${envPrefix}python -c '${code}'`, output, exitCode)
}
