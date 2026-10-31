#!/usr/bin/env node
/**
 * Packaging check for `npm run pack:check`.
 *
 * Verifies the published artifact without publishing anything:
 * - required manifest fields and files exist;
 * - the Cordis patch row matches the package name;
 * - lib/version.js matches package.json;
 * - the tarball `npm pack --dry-run` would produce contains no secrets,
 *   machine-specific paths, or repository-only files;
 * - required docs/license/attribution files are present;
 * - the package declares no runtime dependencies beyond the documented peer
 *   surface (the plugin is intentionally dependency-free at install time).
 *
 * Exit code 0 = pass; non-zero = the first failing check with an explanation.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const failures = []
const notes = []

/**
 * @param {boolean} condition
 * @param {string} message
 */
function check(condition, message) {
  if (condition) notes.push(`ok   ${message}`)
  else failures.push(`FAIL ${message}`)
}

/**
 * @param {string} file
 * @returns {string}
 */
function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8')
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function exists(file) {
  return fs.existsSync(path.join(root, file))
}

const pkg = JSON.parse(read('package.json'))

// --- manifest ---------------------------------------------------------------
check(pkg.name === 'dsh-tokeneconomizer', 'package name is dsh-tokeneconomizer')
check(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version), 'package version is semver')
check(pkg.type === 'module', 'package is ESM (type: module)')
check(pkg.main === 'lib/index.js', 'main entry is lib/index.js')
check(pkg.exports?.['.'] === './lib/index.js', 'exports "." maps to lib/index.js')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch points at cordis.patch.yml')
check(pkg.dsh?.manifestVersion === 1, 'dsh.manifestVersion is the DSH format 1')
check(typeof pkg.engines?.dsh === 'string' && pkg.engines.dsh.length > 0, 'engines.dsh is declared')
check(typeof pkg.engines?.node === 'string', 'engines.node is declared')
check(pkg.license === 'Apache-2.0', 'license is Apache-2.0')
check(Array.isArray(pkg.files) && pkg.files.includes('lib') && pkg.files.includes('bin'), 'files includes lib and bin')
check(pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0, 'no runtime dependencies (peer-only install)')
check(!pkg.dsh?.bundle?.patch?.includes('..'), 'bundle patch path is package-relative without traversal')

// --- version sync -----------------------------------------------------------
const versionSource = read('lib/version.js')
const versionMatch = /export const VERSION = '([^']+)'/.exec(versionSource)
check(versionMatch?.[1] === pkg.version, `lib/version.js VERSION matches package.json (${pkg.version})`)

// --- required files ---------------------------------------------------------
for (const file of [
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  '.gitignore',
  'cordis.patch.yml',
  'lib/index.js',
  'bin/te.js',
  'docs/ARCHITECTURE.md',
  'docs/PORTING.md',
  'docs/VERIFICATION.md',
]) {
  check(exists(file), `required file present: ${file}`)
}
check(!exists('dsh-plugin.json'), 'no dsh-plugin.json (DSH 0.2.1 does not read it; document instead)')

// --- cordis patch -----------------------------------------------------------
const patch = read('cordis.patch.yml')
check(patch.includes(`name: ${pkg.name}`), 'cordis.patch.yml mounts the package by name')
check(/^- insert:/m.test(patch), 'cordis.patch.yml uses an insert list (bundle layer format)')

// --- license/attribution content -------------------------------------------
const license = read('LICENSE')
check(license.includes('Apache License') && license.includes('Version 2.0'), 'LICENSE contains the Apache-2.0 text')
const notice = read('NOTICE')
check(/microsoft\/TokenEconomizer/.test(notice) && /e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9/.test(notice), 'NOTICE names the upstream project and commit')
check(/not an official Microsoft product/i.test(notice), 'NOTICE states this is not an official Microsoft product')
check(/Apache License/i.test(read('THIRD_PARTY_NOTICES.md')), 'third-party notice references the license')

// --- no secrets / personal paths in shipped content ------------------------
const shippedFiles = []
for (const entry of pkg.files) {
  const absolute = path.join(root, entry)
  if (!fs.existsSync(absolute)) continue
  const stat = fs.statSync(absolute)
  if (stat.isFile()) shippedFiles.push(entry)
  else if (stat.isDirectory()) {
    for (const child of fs.readdirSync(absolute, { recursive: true })) {
      const relative = path.join(entry, String(child)).split(path.sep).join('/')
      if (fs.statSync(path.join(root, relative)).isFile()) shippedFiles.push(relative)
    }
  }
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
]
// Machine-specific absolute paths. Documentation may legitimately mention
// generic forms, so user names are rejected while `~`/`$DSH_HOME` are fine.
const PRIVATE_PATH_PATTERNS = [
  /C:\\Users\\[^\\\s]+/i,
  /\/Users\/[A-Za-z0-9._-]+\//,
  /\/home\/[A-Za-z0-9._-]+\//,
]
let scanned = 0
for (const file of shippedFiles) {
  const text = read(file)
  scanned += 1
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) failures.push(`FAIL shipped file contains something that looks like a secret: ${file}`)
  }
  for (const pattern of PRIVATE_PATH_PATTERNS) {
    if (pattern.test(text)) failures.push(`FAIL shipped file contains a machine-specific user path: ${file}`)
  }
  if (/\b(TODO|TBD)\b/.test(text) && !file.startsWith('docs/UPSTREAM')) {
    failures.push(`FAIL shipped file contains a TODO/TBD placeholder: ${file}`)
  }
}
notes.push(`scanned ${scanned} shipped file(s) for secrets/personal paths/placeholders`)

// --- npm pack can produce the artifact -------------------------------------
try {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-pack-cache-'))
  const outFile = path.join(cacheDir, 'pack-stdout.json')
  const errFile = path.join(cacheDir, 'pack-stderr.txt')
  // Some sandboxed environments deny piped stdio to child processes; redirect to
  // files instead of capturing pipes.
  const outFd = fs.openSync(outFile, 'w')
  const errFd = fs.openSync(errFile, 'w')
  const { spawnSync } = await import('node:child_process')
  const run = spawnSync(process.execPath, [resolveNpmCli(), 'pack', '--dry-run', '--json'], {
    cwd: root,
    env: { ...process.env, npm_config_cache: cacheDir },
    stdio: ['ignore', outFd, errFd],
    timeout: 60_000,
    windowsHide: true,
  })
  fs.closeSync(outFd)
  fs.closeSync(errFd)
  if (run.error) throw run.error
  if (run.status !== 0) {
    const stderr = fs.readFileSync(errFile, 'utf8').slice(0, 400)
    throw new Error(`npm pack exited ${run.status}: ${stderr}`)
  }
  const result = JSON.parse(fs.readFileSync(outFile, 'utf8'))
  const packedFiles = new Set((/** @type {{files?: {path: string}[]}[]} */ (result)[0]?.files ?? []).map((entry) => entry.path))
  check(packedFiles.has('lib/index.js'), 'npm pack includes lib/index.js')
  check(packedFiles.has('cordis.patch.yml'), 'npm pack includes cordis.patch.yml')
  check(packedFiles.has('LICENSE') && packedFiles.has('NOTICE'), 'npm pack includes LICENSE and NOTICE')
  check(![...packedFiles].some((file) => file.startsWith('test/')), 'npm pack excludes test files')
  check(![...packedFiles].some((file) => file.startsWith('research/')), 'npm pack excludes research files')
  check(![...packedFiles].some((file) => file.startsWith('upstream-te/')), 'npm pack excludes upstream checkout')
  notes.push(`npm pack dry-run would include ${packedFiles.size} file(s)`)
} catch (error) {
  failures.push(`FAIL npm pack --dry-run failed: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * Resolve the npm CLI that ships with the running Node installation.
 * @returns {string}
 */
function resolveNpmCli() {
  // `npm` is on PATH in supported environments; `npm pack` only needs the CLI.
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((value) => typeof value === 'string' && fs.existsSync(value))
  if (candidates.length > 0) {
    const found = candidates[0]
    if (found !== undefined) return found
  }
  throw new Error('cannot locate npm-cli.js; run this check through `npm run pack:check`')
}

// --- report -----------------------------------------------------------------
for (const line of notes) process.stdout.write(`${line}\n`)
if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} packaging check(s) failed:\n${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\npack:check passed\n')
}
