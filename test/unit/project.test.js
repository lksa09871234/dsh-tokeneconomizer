import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { displayPath, detectProjectRoot, normalizeProjectRoot, projectKey, projectStateDir, resolveDshHome, stateDirForConfig } from '../../lib/project.js'

/** @returns {string} */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'te-project-'))
}

test('resolveDshHome prefers explicit config, then DSH_HOME, then ~/.dsh', () => {
  const explicit = path.join(tempDir(), 'explicit')
  assert.equal(resolveDshHome(explicit, { DSH_HOME: 'C:\\ignored' }), path.resolve(explicit))
  assert.equal(resolveDshHome('', { DSH_HOME: 'C:\\custom-dsh-home' }), path.resolve('C:\\custom-dsh-home'))
  assert.equal(resolveDshHome('', { DSH_HOME: '   ' }), path.join(os.homedir(), '.dsh'))
})

test('stateDirForConfig defaults under the DSH home and never under a project', () => {
  const home = path.join(tempDir(), 'home')
  const dir = stateDirForConfig('', { DSH_HOME: home })
  assert.equal(dir, path.join(home, 'tokeneconomizer'))
})

test('stateDirForConfig accepts an explicit dataDir and expands a leading tilde', () => {
  const targeted = path.join(tempDir(), 'state')
  assert.equal(stateDirForConfig(targeted, {}), path.resolve(targeted))
  assert.equal(stateDirForConfig('~/te-state', {}), path.join(os.homedir(), 'te-state'))
})

test('projectKey is stable, path-safe, and differs per project', () => {
  const rootA = normalizeProjectRoot(tempDir())
  const rootB = normalizeProjectRoot(tempDir())
  const keyA = projectKey(rootA)
  assert.match(keyA, /^[0-9a-f]{32}$/)
  assert.equal(projectKey(rootA), keyA)
  assert.notEqual(projectKey(rootB), keyA)
})

test('normalizeProjectRoot resolves relative paths and is idempotent', () => {
  const dir = tempDir()
  const normalized = normalizeProjectRoot('.', dir)
  assert.equal(normalizeProjectRoot(normalized), normalized)
  assert.ok(path.isAbsolute(normalized))
})

test('projectStateDir keeps project directories under the state root', () => {
  const state = tempDir()
  const root = normalizeProjectRoot(tempDir())
  const dir = projectStateDir(state, root)
  assert.ok(dir.startsWith(path.join(state, 'projects')))
})

test('detectProjectRoot prefers the nearest .git ancestor and falls back to cwd', () => {
  const repo = tempDir()
  fs.mkdirSync(path.join(repo, '.git'))
  const nested = path.join(repo, 'packages', 'app')
  fs.mkdirSync(nested, { recursive: true })
  assert.equal(detectProjectRoot(nested), normalizeProjectRoot(repo))
  assert.equal(detectProjectRoot(repo), normalizeProjectRoot(repo))
  const plain = tempDir()
  assert.equal(detectProjectRoot(plain), normalizeProjectRoot(plain))
})

test('displayPath never leaks the machine home prefix', () => {
  const home = os.homedir()
  const dshHome = path.join(home, '.dsh')
  assert.equal(displayPath(path.join(dshHome, 'tokeneconomizer')), '$DSH_HOME/tokeneconomizer')
  assert.match(displayPath(path.join(home, 'elsewhere', 'file')), /^~\//)
})
