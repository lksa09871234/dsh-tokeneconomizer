/**
 * Test helper for the process-level DSH integration test.
 *
 * Everything here is offline: it only locates an installed DSH CLI, creates an
 * isolated `DSH_HOME` in the operating-system temp directory (never inside the
 * repo, so a profile `link:` install cannot form a junction cycle), and
 * runs the CLI with stdout/stderr redirected to real files. Piped child stdio
 * is intentionally avoided: under the DSH file sandbox a piped spawn can fail
 * with EPERM (the same workaround the research smoke scripts use).
 *
 * @module dsh-tokeneconomizer/test/integration/helpers/dsh-cli
 */

import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root (`dsh-tokeneconomizer/`). */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)))

/**
 * Isolated `DSH_HOME` for the process-level test.
 *
 * It lives in the operating-system temp directory, not inside the repo: the
 * profile installs this repo as a `link:` dependency, and a link target inside a
 * directory that also contains the profile would create a junction cycle
 * (Windows), which breaks archiving and cleanup tooling. Keeping the test home
 * outside the checkout avoids that entirely.
 */
export const TEST_HOME = path.join(
  mkdtempSync(path.join(os.tmpdir(), 'dsh-te-integration-')),
  'home',
)

/**
 * @typedef {object} DshCli
 * @property {string} node Absolute Node executable to run the CLI with.
 * @property {string} cli Absolute path of `@deepseek-ai/dsh/lib/bin.js`.
 * @property {string} pnpmDir Directory that must be on PATH so the CLI can find pnpm.
 * @property {string} source How it was found (`DSH_CLI` or `known-install`).
 */

/**
 * @param {string} file
 * @returns {boolean}
 */
function isFile(file) {
  try {
    return existsSync(file) && path.basename(file) !== ''
  } catch {
    return false
  }
}

/**
 * The Node executable belonging to a DSH install whose CLI is at
 * `<root>/npm/node_modules/@deepseek-ai/dsh/lib/bin.js`:
 * `<root>/node/node.exe` (Windows) / `<root>/node/node` (POSIX).
 *
 * @param {string} cli
 * @returns {{ node: string, pnpmDir: string }|null}
 */
function deriveInstall(cli) {
  const npmDir = path.resolve(path.dirname(cli), '..', '..', '..', '..')
  const root = path.dirname(npmDir)
  const candidates = [
    path.join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
    process.execPath,
  ]
  const node = candidates.find((candidate) => isFile(candidate))
  return node === undefined ? null : { node, pnpmDir: npmDir }
}

/**
 * Locate the DSH CLI used by the process-level test.
 *
 * Search order:
 * 1. `DSH_CLI` (absolute path to `bin.js`) with optional `DSH_NODE`;
 * 2. the known local RC2 install `D:/Apps/dsh-TUI/npm/node_modules/@deepseek-ai/dsh/lib/bin.js`;
 * 3. `node_modules/@deepseek-ai/dsh/lib/bin.js` inside this repo.
 *
 * Returns `null` when none is usable, so the test can skip with a clear message.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {DshCli|null}
 */
export function findDshCli(env = process.env) {
  /** @type {Array<{ cli: string, node?: string, pnpmDir?: string, source: string }>} */
  const candidates = []
  const fromEnv = (env.DSH_CLI ?? '').trim()
  if (fromEnv !== '') candidates.push({ cli: fromEnv, node: env.DSH_NODE, source: 'DSH_CLI' })
  candidates.push({
    cli: 'D:/Apps/dsh-TUI/npm/node_modules/@deepseek-ai/dsh/lib/bin.js',
    source: 'known-install',
  })
  candidates.push({
    cli: path.join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    source: 'repo-node-modules',
  })

  for (const candidate of candidates) {
    if (!isFile(candidate.cli)) continue
    const derived = candidate.node !== undefined && isFile(candidate.node)
      ? { node: candidate.node, pnpmDir: candidate.pnpmDir ?? path.dirname(path.dirname(candidate.cli)) }
      : deriveInstall(candidate.cli)
    if (derived === null) continue
    return {
      node: derived.node,
      cli: candidate.cli,
      pnpmDir: candidate.pnpmDir ?? derived.pnpmDir,
      source: candidate.source,
    }
  }
  return null
}

/**
 * Recreate the isolated `DSH_HOME` for a process test.
 * @returns {string}
 */
export function resetTestHome() {
  rmSync(TEST_HOME, { recursive: true, force: true })
  mkdirSync(TEST_HOME, { recursive: true })
  return TEST_HOME
}

/** @typedef {object} SpawnResult
 * @property {number|null} status
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} [error]
 */

/**
 * Run the DSH CLI with the isolated home and file-redirected stdio.
 *
 * @param {DshCli} cli
 * @param {ReadonlyArray<string>} args CLI arguments after `bin.js` (`--profile`, ...).
 * @param {{ timeoutMs?: number, extraEnv?: Record<string, string>, label?: string }} [options]
 * @returns {SpawnResult}
 */
export function runDsh(cli, args, options = {}) {
  const logDir = path.join(TEST_HOME, '_logs')
  mkdirSync(logDir, { recursive: true })
  const label = (options.label ?? 'run').replace(/[^A-Za-z0-9._-]+/g, '-')
  const outPath = path.join(logDir, `${label}.out.log`)
  const errPath = path.join(logDir, `${label}.err.log`)
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  /** @type {import('node:child_process').SpawnSyncOptionsWithStringEncoding} */
  const spawnOptions = {
    cwd: REPO_ROOT,
    timeout: options.timeoutMs ?? 180_000,
    encoding: 'utf8',
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
    env: {
      ...process.env,
      DSH_HOME: TEST_HOME,
      PATH: `${cli.pnpmDir}${path.delimiter}${process.env.PATH ?? ''}`,
      NO_COLOR: '1',
      ...options.extraEnv,
    },
  }
  let result
  try {
    result = spawnSync(cli.node, [cli.cli, ...args], spawnOptions)
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  return {
    status: result.status,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
    ...(result.error === undefined ? {} : { error: String(result.error) }),
  }
}

/**
 * @param {string} file
 * @param {unknown} [fallback]
 * @returns {any}
 */
export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * @param {string} file
 * @param {number} [intervalMs]
 * @param {number} [timeoutMs]
 * @returns {boolean}
 */
export function waitForFile(file, intervalMs = 100, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    if (existsSync(file)) return true
    // Synchronous sleep keeps the test deterministic without timers.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs)
  }
  return existsSync(file)
}

/**
 * Async variant for tests that wait on a plugin's own asynchronous `apply()`:
 * blocking the event loop would starve the plugin's pending microtasks/timers.
 *
 * @param {string} file
 * @param {number} [intervalMs]
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function waitForFileAsync(file, intervalMs = 100, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    if (existsSync(file)) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return existsSync(file)
}
