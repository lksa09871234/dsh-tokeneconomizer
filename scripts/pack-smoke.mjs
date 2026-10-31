#!/usr/bin/env node
/**
 * Packaging smoke test: pack the plugin exactly as npm would publish it, extract
 * the tarball into a temporary directory, and run the shipped terminal CLI and a
 * minimal import of the plugin entry from that extracted tree.
 *
 * This catches the class of bug where the plugin works from a development
 * checkout (where devDependencies exist) but the published package cannot load
 * because an optional DSH peer is absent from a plain Node process.
 *
 * Child processes are spawned with file-redirected stdio because some sandboxed
 * environments deny piped stdio.
 *
 * @module dsh-tokeneconomizer/scripts/pack-smoke
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
/** @type {string[]} */
const failures = []

/**
 * @param {boolean} condition
 * @param {string} message
 */
function check(condition, message) {
  if (condition) process.stdout.write(`ok   ${message}\n`)
  else failures.push(`FAIL ${message}`)
}

/**
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number}} [options]
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function run(args, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'te-pack-smoke-'))
  const outFile = path.join(temp, 'stdout.txt')
  const errFile = path.join(temp, 'stderr.txt')
  const outFd = fs.openSync(outFile, 'w')
  const errFd = fs.openSync(errFile, 'w')
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', outFd, errFd],
    timeout: options.timeoutMs ?? 120_000,
    windowsHide: true,
  })
  fs.closeSync(outFd)
  fs.closeSync(errFd)
  return {
    status: result.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  }
}

/**
 * Resolve the npm CLI that ships with the running Node installation.
 * @returns {string}
 */
function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((value) => typeof value === 'string' && fs.existsSync(value))
  const found = candidates[0]
  if (found === undefined) throw new Error('cannot locate npm-cli.js; run through `npm run pack:smoke`')
  return found
}

// --- pack -------------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'te-pack-artifact-'))
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'te-pack-cache-'))
const pack = run([resolveNpmCli(), 'pack', '--pack-destination', work, '--json'], {
  env: { ...process.env, npm_config_cache: cache },
})
check(pack.status === 0, 'npm pack exits 0')
const tarballName = (fs.existsSync(work) ? fs.readdirSync(work).find((name) => name.endsWith('.tgz')) : undefined)
check(typeof tarballName === 'string', 'npm pack produced a tarball')

if (typeof tarballName === 'string') {
  const tarball = path.join(work, tarballName)
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-pack-extract-'))
  const tar = spawnSync('tar', ['-xzf', tarball, '-C', extractDir], { stdio: 'ignore', windowsHide: true })
  check(tar.status === 0, 'tarball extracts with tar')
  const packageDir = path.join(extractDir, 'package')

  // 1. The shipped CLI must load and run in a plain Node process: no
  //    devDependencies, no DSH profile, no installed peer packages.
  const help = run([path.join(packageDir, 'bin', 'te.js'), 'help'], { cwd: packageDir, env: { ...process.env } })
  check(help.status === 0, 'shipped `te` CLI exits 0 from the packed tarball')
  check(/dsh-tokeneconomizer \d+\.\d+\.\d+/.test(help.stdout), 'shipped `te` CLI prints its version banner')
  check(/Usage: te/.test(help.stdout), 'shipped `te` CLI prints usage')
  check(help.stderr.trim() === '', 'shipped `te` CLI writes no stderr for help')

  const status = run([path.join(packageDir, 'bin', 'te.js'), '--data-dir', path.join(extractDir, 'state'), 'status'], {
    cwd: packageDir,
  })
  check(status.status === 0, 'shipped `te status` exits 0 with an empty state directory')
  check(/toolprune:/.test(status.stdout), 'shipped `te status` renders the mechanism summary')

  const reset = run([path.join(packageDir, 'bin', 'te.js'), '--data-dir', path.join(extractDir, 'state'), 'reset', '--yes'], {
    cwd: packageDir,
  })
  check(
    reset.status === 0,
    `\`te reset --yes\` is accepted by the argument parser (exit ${reset.status}; stdout=${JSON.stringify(reset.stdout.slice(0, 160))}; stderr=${JSON.stringify(reset.stderr.slice(0, 160))})`,
  )
  check(
    /reset: deleted/.test(reset.stdout),
    `\`te reset --yes\` reports the reset (stdout=${JSON.stringify(reset.stdout.slice(0, 160))})`,
  )

  // 2. The plugin entry itself must import from the packed tree in a plain
  //    Node process. It imports the Cordis schema library, which is an optional
  //    peer in DSH; without it the entry must fail with a clear module error
  //    rather than a crash — but the CLI above must never depend on it.
  const entryUrl = pathToFileURL(path.join(packageDir, 'lib', 'index.js')).href
  const importEntry = run([
    '--input-type=module',
    '-e',
    `import(${JSON.stringify(entryUrl)})
      .then(() => console.log('ENTRY_OK'))
      .catch((error) => { console.log('ENTRY_ERROR:' + (error && error.code)); process.exit(3) })`,
  ], { cwd: packageDir })
  if (importEntry.stdout.includes('ENTRY_OK')) {
    process.stdout.write('ok   plugin entry imports from the packed tree\n')
  } else {
    // DSH provides the schema peer at runtime; a plain Node import is expected
    // to fail cleanly, which must not be a crash without a code.
    check(
      /ENTRY_ERROR:ERR_MODULE_NOT_FOUND/.test(importEntry.stdout),
      `plugin entry fails cleanly outside DSH (schema peer is host-provided; stdout=${JSON.stringify(importEntry.stdout.slice(0, 160))})`,
    )
  }
}

// --- report -----------------------------------------------------------------
if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} packaging smoke check(s) failed:\n${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\npack:smoke passed\n')
}
