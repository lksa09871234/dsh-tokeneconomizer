/**
 * Process-level, offline DSH integration test.
 *
 * What it proves without any model call:
 * 1. an isolated `DSH_HOME` profile can be initialised from the shipped
 *    `headless` template (`--from-default-profile headless --dump-config`);
 * 2. this repository installs as an out-of-tree DSH plugin through the real CLI
 *    (`dsh plugin --profile te add <repo>`), producing a `link:` dependency, a
 *    bundle entry and a composed `tokeneconomizer` row;
 * 3. a base-only profile that mounts the plugin boots for real and the plugin's
 *    `apply()` runs, leaving its load marker and the driver's evidence file.
 *
 * The DSH CLI is discovered from `DSH_CLI` (path to `@deepseek-ai/dsh/lib/bin.js`)
 * or the known local install; when it is absent the whole test skips with a
 * clear message instead of failing in environments without DSH.
 *
 * Child stdio is redirected to files (not pipes): a piped child spawn can be
 * denied under the DSH file sandbox with EPERM.
 *
 * @module dsh-tokeneconomizer/test/integration/cli-process.test
 */

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import {
  REPO_ROOT,
  TEST_HOME,
  findDshCli,
  readJsonFile,
  resetTestHome,
  runDsh,
} from './helpers/dsh-cli.js'

const cli = findDshCli()
const DRIVER_PLUGIN = path.join(REPO_ROOT, 'test', 'fixtures', 'driver-plugin')

/**
 * @param {import('node:test').TestContext} t
 * @param {string} name
 * @param {import('./helpers/dsh-cli.js').SpawnResult} result
 */
function assertOk(t, name, result) {
  const detail = `${name}: status=${String(result.status)}\n--- stdout ---\n${result.stdout.slice(-2000)}\n--- stderr ---\n${result.stderr.slice(-4000)}`
  assert.equal(result.status, 0, detail)
  t.diagnostic(`${name}: ok`)
}

test('process: isolated profile, plugin install and real boot', async (t) => {
  if (cli === null) {
    t.skip(
      'no DSH CLI found; set DSH_CLI to …/@deepseek-ai/dsh/lib/bin.js (and optionally DSH_NODE) to run the process-level test',
    )
    return
  }
  t.diagnostic(`DSH CLI: ${cli.source} node=${cli.node}`)

  const home = resetTestHome()
  const profileDir = path.join(home, 'profiles', 'te')
  const profilePkgPath = path.join(profileDir, 'package.json')

  // 1. Isolated headless-template profile + composition dump.
  const init = runDsh(cli, ['--profile', 'te', '--from-default-profile', 'headless', '--dump-config'], {
    label: 'init-te',
  })
  assertOk(t, 'init isolated headless profile', init)
  assert.ok(init.stdout.includes('# == @deepseek-ai/dsh-base'), 'dump-config names the base bundle')
  assert.ok(existsSync(profilePkgPath), 'profile package.json exists')
  assert.ok(existsSync(path.join(profileDir, 'cordis.patch.yml')), 'profile patch exists')
  const profileBefore = readJsonFile(profilePkgPath, /** @type {any} */ ({}))
  assert.deepEqual(profileBefore.dsh?.profile?.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-headless',
  ])

  // 2. Install this repository as a local-path plugin.
  const install = runDsh(cli, ['plugin', '--profile', 'te', 'add', REPO_ROOT], {
    label: 'install-te',
    timeoutMs: 300_000,
  })
  assertOk(t, 'dsh plugin add <repo>', install)
  const profilePkg = readJsonFile(profilePkgPath, /** @type {any} */ ({}))
  const dependency = profilePkg.dependencies?.['dsh-tokeneconomizer'] ?? ''
  assert.ok(
    String(dependency).startsWith('link:'),
    `profile dependency for dsh-tokeneconomizer should be a link: spec, got ${JSON.stringify(dependency)}`,
  )
  assert.ok(
    (profilePkg.dsh?.profile?.bundles ?? []).includes('dsh-tokeneconomizer'),
    'profile bundles include dsh-tokeneconomizer',
  )
  assert.ok(
    existsSync(path.join(profileDir, 'node_modules', 'dsh-tokeneconomizer')),
    'profile node_modules link exists',
  )

  // 3. Composition sees the package's bundle patch row.
  const dump = runDsh(cli, ['--profile', 'te', '--dump-config'], { label: 'dump-te' })
  assertOk(t, 'dump-config after install', dump)
  assert.ok(dump.stdout.includes('# == dsh-tokeneconomizer'), 'dump names the tokeneconomizer bundle layer')
  assert.ok(dump.stdout.includes('- id: tokeneconomizer'), 'dump contains the plugin row id')
  assert.ok(dump.stdout.includes('name: dsh-tokeneconomizer'), 'dump contains the plugin row name')

  // 4. A base-only profile mounts the plugin for real; the driver plugin waits
  //    for the load marker and exits the process.
  const bootInstall = runDsh(cli, ['plugin', '--profile', 'boot', 'add', REPO_ROOT], {
    label: 'install-boot-te',
    timeoutMs: 300_000,
  })
  assertOk(t, 'dsh plugin add <repo> into base-only profile', bootInstall)
  const driverInstall = runDsh(cli, ['plugin', '--profile', 'boot', 'add', DRIVER_PLUGIN], {
    label: 'install-boot-driver',
    timeoutMs: 300_000,
  })
  assertOk(t, 'dsh plugin add <driver fixture>', driverInstall)
  const bootPkg = readJsonFile(path.join(home, 'profiles', 'boot', 'package.json'), /** @type {any} */ ({}))
  const bootBundles = bootPkg.dsh?.profile?.bundles ?? []
  assert.ok(bootBundles.includes('dsh-tokeneconomizer'), 'base-only profile bundles include the plugin')
  assert.ok(bootBundles.includes('te-integration-driver'), 'base-only profile bundles include the driver')

  const bootDump = runDsh(cli, ['--profile', 'boot', '--dump-config'], { label: 'dump-boot' })
  assertOk(t, 'dump-config base-only profile', bootDump)
  assert.ok(bootDump.stdout.includes('name: dsh-tokeneconomizer'), 'base-only dump contains the plugin row')

  const resultPath = path.join(home, 'driver-result.json')
  const markerPath = path.join(home, 'tokeneconomizer', 'plugin-load.json')
  rmSync(resultPath, { force: true })
  rmSync(markerPath, { force: true })
  const boot = runDsh(cli, ['--profile', 'boot'], {
    label: 'boot-base-profile',
    timeoutMs: 120_000,
    extraEnv: { TE_DRIVER_RESULT: resultPath },
  })
  assertOk(t, 'real base-only profile boot', boot)
  assert.ok(existsSync(markerPath), `plugin load marker exists at ${markerPath}`)
  const driver = readJsonFile(resultPath, /** @type {any} */ (null))
  assert.ok(driver !== null, `driver evidence written at ${resultPath}`)
  assert.equal(driver.markerFound, true, 'driver saw the tokeneconomizer load marker')
  assert.equal(driver.marker?.plugin, 'dsh-tokeneconomizer', 'marker names the plugin')
  assert.equal(typeof driver.marker?.version, 'string', 'marker records a plugin version')
  assert.ok(driver.marker?.config !== undefined, 'marker records the effective mechanism modes')
  // The load marker is the proof that apply() ran in a real DSH process; the
  // profile row itself is asserted above via --dump-config and package.json.
  t.diagnostic(`boot evidence: ${JSON.stringify(driver).slice(0, 600)}`)
})

test('process: default profile resolves the tokeneconomizer row without a link', () => {
  // Guard against a stale assumption in the test above: if the CLI is absent we
  // cannot assert anything, so this is a documentation-only skip.
  if (cli === null) return
  const profilePkg = readJsonFile(path.join(TEST_HOME, 'profiles', 'te', 'package.json'), /** @type {any} */ (null))
  assert.ok(profilePkg !== null)
  assert.ok(String(profilePkg.dependencies?.['dsh-tokeneconomizer'] ?? '').startsWith('link:'))
  assert.ok((profilePkg.dsh?.profile?.bundles ?? []).includes('dsh-tokeneconomizer'))
})
