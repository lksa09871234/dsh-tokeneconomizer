/**
 * Real-plugin in-process load test.
 *
 * Mounts the actual `dsh-tokeneconomizer` Cordis plugin in a bare application
 * (real Cordis from this repo's devDependencies) with an isolated `DSH_HOME`,
 * and asserts the plugin's own load marker: this is the in-process counterpart
 * of the process-level boot test, and it is the seam where the Lead will swap in
 * the real mechanism wiring.
 *
 * The plugin entry is intentionally allowed to stay intact and inert: its
 * `apply()` catches its own initialization failures. The test therefore asserts
 * only what the plugin contract promises today (load marker + effective config),
 * not mechanism behavior.
 *
 * @module dsh-tokeneconomizer/test/integration/real-plugin-load.test
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { VERSION } from '../../lib/version.js'
import { waitForFileAsync } from './helpers/dsh-cli.js'

test('real plugin: in-process load writes the load marker with the effective config', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'te-real-plugin-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    rmSync(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
  })

  const plugin = await import('../../lib/index.js')
  // The module default export is the Cordis plugin function (`apply`); mount it
  // explicitly rather than the module namespace object.
  await ctx.plugin(plugin.default, { microskills: 'off', toolprune: 'propose', loopguard: 'on' })

  const markerPath = path.join(home, 'tokeneconomizer', 'plugin-load.json')
  assert.ok(await waitForFileAsync(markerPath), `load marker written at ${markerPath}`)
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  assert.equal(marker.schemaVersion, 1)
  assert.equal(marker.plugin, 'dsh-tokeneconomizer')
  assert.equal(marker.version, VERSION)
  assert.equal(marker.config.microskills, 'off')
  assert.equal(marker.config.toolprune, 'propose')
  assert.equal(marker.config.loopguard, 'on')
  // `dataDirDisplay` is recorded when the real profile provides `profileContext`;
  // in this bare in-process Context the marker path itself proves the default
  // `<DSH_HOME>/tokeneconomizer` resolution.
  if (marker.config.dataDirDisplay !== undefined) {
    assert.match(String(marker.config.dataDirDisplay), /^\$DSH_HOME\//)
  }
  assert.equal(typeof marker.pid, 'number')
  assert.equal(existsSync(path.join(home, 'tokeneconomizer')), true)
})
