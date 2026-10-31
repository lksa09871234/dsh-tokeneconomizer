/**
 * Ported from upstream `tests/test_envfacts.py`,
 * `tests/test_envfacts_args.py` and `tests/test_generic_microskills.py`
 * (observe half), Apache-2.0, microsoft/TokenEconomizer @ e428fc9.
 *
 * Expected values were cross-checked by replaying the same commands through
 * upstream `observe.classify_command` / `observe_task`.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  BUILD_SUBS,
  ERROR_CLASSES,
  GENERIC,
  NODE_WEB,
  PYTHON_GIT,
  cdTarget,
  classifyCommand,
  editedFiles,
  editedPyfiles,
  envCalls,
  errorClass,
  formFailed,
  formWorked,
  isBare,
  isShellTool,
  labelFailed,
  labelRule,
  observeSession,
  repositoryTop,
  segments,
  stripRtkPrefix,
  testLabels,
  unwrap,
} from '../../../lib/microskills/observe.js'
import { at, cmd, edit, observe, PROJ } from './helpers.js'

/**
 * @param {string} command
 * @param {object} [options]
 * @returns {Array<[string, string]>}
 */
function intentForms(command, options) {
  return classifyCommand(command, options).map((observation) => [observation.intent, observation.form])
}

test('classifyFormsAndIntents: forms, wrappers, activation prefixes, heredocs, probes', () => {
  const pythonGit = { vocab: PYTHON_GIT }
  assert.deepEqual(
    intentForms('/bin/bash -lc "source /opt/env/bin/activate proj && python -m pytest tests -q"', pythonGit),
    [['run_tests', 'source activate proj && python -m pytest']],
  )
  assert.deepEqual(
    intentForms("conda run -n proj python - <<'PY'\nimport x\nPY", pythonGit),
    [['run_interpreter', 'conda run -n proj python']],
  )
  assert.deepEqual(
    intentForms('PYTHONPATH=/testbed ./tests/runtests.py auth_tests -v 1', pythonGit),
    [['run_tests', 'python tests/runtests.py']],
  )
  assert.deepEqual(
    intentForms(`${PROJ} bin/test sympy/core/tests/test_a.py`, pythonGit),
    [['run_tests', `${PROJ} bin/test`]],
  )
  const probes = classifyCommand('git remote -v; git tag --contains HEAD | head; git log --oneline -3', pythonGit)
  assert.deepEqual(probes.map((observation) => [observation.intent, observation.probe]), [
    ['probe_vcs_refs', 'remote'],
    ['probe_vcs_refs', 'tag'],
  ])
  const fetch = classifyCommand('curl -sS https://api.example.org/x | head -3', pythonGit)
  assert.equal(fetch[0].intent, 'fetch_remote')
  assert.deepEqual(fetch[0].hosts, ['api.example.org'])
  // A plain `git tag` lists ALL tags, past ones included: not a beyond-HEAD probe.
  assert.deepEqual(classifyCommand('git tag | tail -5', pythonGit), [])
  // Heredoc bodies never become commands.
  assert.equal(classifyCommand("python - <<'PY'\npytest_is_a_word = 1\nPY", pythonGit)[0].intent, 'run_interpreter')
})

test('errorClassesAreEnvironmentalOnly: only environmental phrases classify', () => {
  assert.equal(errorClass("ModuleNotFoundError: No module named 'x'"), 'module_missing')
  assert.equal(errorClass('bash: pytest: command not found'), 'command_missing')
  assert.equal(errorClass('curl: (7) Failed to connect to h port 443: Connection refused'), 'connection_refused')
  assert.equal(errorClass('AssertionError: 1 != 2\nFAILED tests/test_a.py::t'), null)
  assert.equal(errorClass("python: can't open file 'runtests.py': [Errno 2] No such file or directory"), 'script_missing')
  assert.equal(errorClass('Permission denied'), 'permission_denied')
  assert.equal(errorClass('usage: runtests.py [-h]\nruntests.py: error: unrecognized arguments: x'), 'usage_error')
  assert.equal(errorClass('Could not resolve host: example.org'), 'name_resolution')
  assert.equal(errorClass('Network is unreachable'), 'unreachable')
  assert.equal(errorClass('plain text'), null)
  assert.equal(ERROR_CLASSES.length, 8)
})

test('envAssignmentForms: a leading assignment is part of how the command was typed', () => {
  const [envAssign] = classifyCommand('env PYTHONPATH=. pytest -q')
  assert.deepEqual([envAssign.intent, envAssign.form, envAssign.env], ['run_tests', 'pytest', true])
  const [prefixAssign] = classifyCommand('PYTHONPATH=. python -m pytest -q')
  assert.deepEqual([prefixAssign.form, prefixAssign.env], ['python -m pytest', true])
  const [plain] = classifyCommand('python -m pytest -q')
  assert.equal(plain.env, false)
})

test('prefixWrappers: rtk prefixes are invisible to the classifier, exactness pinned', () => {
  const cases = ['python -m pytest tests/ -q', 'pytest -q', 'bin/test sympy/x.py', 'K=1 pytest -q',
    'pip install foo', 'curl https://x', 'git status', 'rg -n foo src']
  for (const bare of cases) {
    for (const prefix of ['rtk ', 'rtk proxy ', 'rtk K=2 ']) {
      assert.deepEqual(intentForms(`${prefix}${bare}`), intentForms(bare), `${prefix}${bare}`)
    }
  }
  assert.equal(stripRtkPrefix('rtk pytest -q'), 'pytest -q')
  assert.equal(stripRtkPrefix('rtk proxy make'), 'make')
  assert.equal(stripRtkPrefix('rtk'), 'rtk')
  assert.equal(stripRtkPrefix('rtkfoo bar'), 'rtkfoo bar')
  assert.equal(stripRtkPrefix('pytest'), 'pytest')
})

test('labelRule: only a shape rewrite counts as a repair', () => {
  const cases = /** @type {Array<[string, string, [string, string]|null]>} */ ([
    ['tests.model_inheritance', 'model_inheritance', ['strip', 'tests.']],
    ['tests.admin_views.tests', 'admin_views.tests', ['strip', 'tests.']],
    ['db.datetime.test_x::DateTests::test_a', 'db.datetime.test_x.DateTests.test_a', ['sep', '::']],
    ['db.datetime.test_x::DateTests', 'db.datetime.test_x', ['sep', '::']],
    ['model_fields.DurationFieldTests', 'model_fields', null],
    ['admin_views.ChangeListTests', 'admin_views', null],
    ['app.tests', 'other.tests', null],
  ])
  for (const [a, b, expected] of cases) assert.deepEqual(labelRule(a, b), expected, `${a} -> ${b}`)
})

test('testLabels: structured positional arguments after the runner, option values skipped', () => {
  const [script] = classifyCommand('python tests/runtests.py tests.app -v 2 --settings=x 2>&1 | tail')
  assert.deepEqual(testLabels(script), ['tests.app'])
  const [pytest] = classifyCommand('python -m pytest pkg/test_a.py::T::test_b -q > /tmp/o.log')
  assert.deepEqual(testLabels(pytest), ['pkg/test_a.py::T::test_b'])
  const [cdChange] = classifyCommand('cd tests && python runtests.py forms -v 2')
  assert.equal(cdChange.form, 'cd tests && python runtests.py')
  assert.deepEqual(testLabels(cdChange), ['forms'])
})

test('labelFailed: a missing runner is not a failing label', () => {
  assert.equal(labelFailed(['tests/test_a.py'], '/usr/bin/python3: No module named pytest'), false)
  assert.equal(labelFailed(['tests.app'], "ModuleNotFoundError: No module named 'tests'"), true)
  assert.equal(labelFailed(['app.tests.Missing'], "AttributeError: module 'app.tests' has no attribute 'Missing'"), true)
  assert.equal(labelFailed(['app.tests'], "AttributeError: 'NoneType' object has no attribute 'pk'"), false)
})

test('cdHandling: a cd into the start directory by absolute path is no cd', () => {
  /** @param {string} command @param {object} options @returns {string} */
  const form = (command, options) => classifyCommand(command, options)[0].form
  assert.equal(form('cd /r && python tests/runtests.py app', { cwd: '', root: '/r' }), 'python tests/runtests.py')
  assert.equal(form('cd /r/tests && python runtests.py app', { cwd: '', root: '/r' }), 'cd tests && python runtests.py')
  assert.equal(form('cd .. && python runtests.py app', { cwd: 'tests', root: '/r' }), 'python runtests.py')
  assert.equal(form('python runtests.py app', { cwd: 'tests', root: '/r' }), 'cd tests && python runtests.py')
  // Left the session's start: taken as typed.
  assert.equal(form('cd /elsewhere && python runtests.py app', { cwd: '', root: '/r' }), 'cd /elsewhere && python runtests.py')
})

test('cdHandling: a cd up to the repository from a subdirectory is no cd', () => {
  /** @param {string} command @param {object} options @returns {string} */
  const form = (command, options) => classifyCommand(command, options)[0].form
  const kw = { cwd: '', root: '/r/pkg', top: '/r' }
  assert.equal(form('cd /r && pytest -q', kw), 'pytest')
  assert.equal(form('cd .. && pytest -q', kw), 'pytest')
  assert.equal(form('cd /r && cd tests && python runtests.py app', kw), 'cd tests && python runtests.py')
  // Anywhere else above the start is taken as typed.
  assert.equal(form('cd /r/tests && python runtests.py app', kw), 'cd /r/tests && python runtests.py')
  assert.equal(form('cd /elsewhere && pytest -q', kw), 'cd /elsewhere && pytest')
  assert.equal(form('cd /r && pytest -q', { cwd: '', root: '/r/pkg' }), 'cd /r && pytest')
})

test('cdTarget: null cases leave the session-relative state unknown', () => {
  assert.equal(cdTarget('', '~'), null)
  assert.equal(cdTarget('', '$HOME/build'), null)
  assert.equal(cdTarget('', '-'), null)
  assert.equal(cdTarget('', '/abs/path'), null) // no root known
  assert.equal(cdTarget('', '.'), '')
  assert.equal(cdTarget('tests', '..', '/r', '/r'), '')
})

test('repositoryTop: the nearest directory holding .git wins', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'te-observe-'))
  try {
    fs.mkdirSync(path.join(base, 'repo', '.git'), { recursive: true })
    fs.mkdirSync(path.join(base, 'repo', 'pkg', 'sub'), { recursive: true })
    fs.mkdirSync(path.join(base, 'wt', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(base, 'wt', '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n')
    assert.equal(repositoryTop(path.join(base, 'repo', 'pkg', 'sub')), path.join(base, 'repo'))
    assert.equal(repositoryTop(path.join(base, 'wt', 'pkg')), path.join(base, 'wt'))
    assert.equal(repositoryTop('relative/path'), null)
    assert.equal(repositoryTop(path.join(base, 'repo', 'gone')), null)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('genericVocabulary: the plugin reading knows builds and other ecosystems', () => {
  /**
   * @param {string} command
   * @param {import('../../../lib/microskills/observe.js').Vocabulary} vocab
   * @returns {string[]}
   */
  const form = (command, vocab) => {
    const [observation] = classifyCommand(command, { vocab })
    return [observation.intent, observation.form]
  }
  assert.deepEqual(form('npm run build', GENERIC), ['run_build', 'npm run build'])
  assert.deepEqual(form('npm run test:unit', GENERIC), ['run_tests', 'npm run test:unit'])
  assert.deepEqual(form('cargo build --release', GENERIC), ['run_build', 'cargo build'])
  assert.deepEqual(form('tsc -p .', GENERIC), ['run_build', 'tsc'])
  assert.deepEqual(form('go test ./...', GENERIC), ['run_tests', 'go test'])
  assert.deepEqual(form('./gradlew test', GENERIC), ['run_tests', 'gradlew test'])
  assert.deepEqual(form('bundle install', GENERIC), ['package_tool', 'bundle'])
  // The narrower upstream vocabularies read as they did.
  assert.deepEqual(classifyCommand('tsc -p .', { vocab: PYTHON_GIT }), [])
  assert.deepEqual(form('npm run build', NODE_WEB), ['package_tool', 'npm'])
  assert.deepEqual(classifyCommand('./gradlew test', { vocab: PYTHON_GIT }), [])
  assert.ok(BUILD_SUBS.has('typecheck'))
})

test('isBare: no path, no activation, no explicit wrapper', () => {
  assert.equal(isBare('python'), true)
  assert.equal(isBare('pytest'), true)
  assert.equal(isBare(`${PROJ} -m pytest`), false)
  assert.equal(isBare('source activate x && python -m pytest'), false)
  assert.equal(isBare('cd tests && python runtests.py'), true)
  assert.equal(isBare('conda run -n proj python'), false)
  assert.equal(isBare('poetry run pytest'), false)
  assert.equal(isBare('npx tsc'), false)
  assert.equal(isBare('npx'), true)
})

test('unwrap and segments: wrappers, quoting and heredocs', () => {
  assert.equal(unwrap('/bin/bash -lc "python -m pytest -q"'), 'python -m pytest -q')
  assert.equal(unwrap("/bin/bash -lc 'cd tests && pytest'"), 'cd tests && pytest')
  assert.equal(unwrap('python -m pytest'), 'python -m pytest')
  assert.deepEqual(segments('cd tests && python runtests.py app'), ['cd tests', 'python runtests.py app'])
  assert.deepEqual(segments('a; b || c | d'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(segments("echo 'a;b' && true"), ["echo 'a;b'", 'true'])
  // A heredoc body is replaced by a marker, never parsed as commands.
  assert.deepEqual(segments("python - <<'PY'\npytest_is_a_word = 1\nPY"), ["python - <<'PY' <heredoc>"])
})

test('isShellTool and tool-name families cover DSH spellings', () => {
  for (const name of ['bash', 'shell', 'stop_bash', 'ops_bash', 'dsh_ops_bash', 'pwsh', 'powershell', 'terminal']) {
    assert.equal(isShellTool(name), true, name)
  }
  for (const name of ['edit', 'read', 'grep', 'glob', 'todo_write', 'write_file']) {
    assert.equal(isShellTool(name), false, name)
  }
})

test('observeSession: edited files by editing family (generic vs python-git)', () => {
  const calls = [
    edit('/r/src/main.go'),
    { tool: 'write_file', args: { path: '/r/web/app.ts' }, resultText: 'ok', failed: false },
    { tool: 'Edit', args: { file_path: '/r/pkg/m.py' }, resultText: 'ok', failed: false },
    cmd('ls', 'x'),
  ]
  assert.deepEqual(observeSession(calls, { vocab: GENERIC }).edited, ['app.ts', 'm.py', 'main.go'])
  assert.deepEqual(observeSession(calls, { vocab: PYTHON_GIT }).edited, ['m.py'])
})

test('observeSession: a call stopped by its own cd teaches nothing', () => {
  const calls = [cmd('cd tests && python runtests.py app',
    'Exit code 1\n/bin/bash: line 1: cd: tests: No such file or directory', 1)]
  assert.deepEqual(observe(calls).obs, [])
})

test('observeSession: outcome attribution inside a compound command', () => {
  // An infrastructure error is attributed to the segment whose executable the error names.
  const named = observe([cmd('python -m pytest -q; echo done', '/usr/bin/python: No module named pytest', 1)])
  assert.deepEqual(named.obs.map((observation) => [observation.intent, observation.outcome]), [['run_tests', 'module_missing']])
  // A failed call with no environmental error marks only the first relevant segment as run.
  const failedChain = observe([cmd('python -m pytest -q && echo ok', 'boom', 1)])
  assert.deepEqual(failedChain.obs.map((observation) => [observation.form, observation.outcome]), [['python -m pytest', 'ran']])
  const failedMixed = observe([cmd('pytest -q; git status', 'boom', 1)])
  assert.deepEqual(failedMixed.obs.map((observation) => [observation.form, observation.outcome]), [['pytest', 'ran']])
  // A network error is attributed to the fetch whose host the error names.
  const network = observe([cmd('curl -sS https://a.example/x && curl -sS https://b.example/y',
    'curl: (7) Failed to connect to b.example port 443: Connection refused', 7)])
  assert.deepEqual(network.obs.map((observation) => [observation.hosts[0], observation.outcome]), [
    ['a.example', null],
    ['b.example', 'connection_refused'],
  ])
  // An `exit code: 0` hint overrides a host-reported failure.
  const hint = observe([cmd('pytest -q', 'exit code: 0', 1)])
  assert.equal(hint.obs[0].outcome, 'ran')
})

test('observeSession: probes are judged only in a homogeneous call', () => {
  assert.equal(observe([cmd('git remote -v', '', 0)]).obs[0].outcome, 'empty')
  assert.equal(observe([cmd('git remote -v', 'origin\tgit@x (fetch)\n', 0)]).obs[0].outcome, 'hit')
  assert.equal(observe([cmd('git remote -v; sed -n 1p x', 'origin\tgit@x (fetch)', 0)]).obs[0].outcome, null)
})

test('observeSession: fetch reachability needs a homogeneous, quiet, non-empty call', () => {
  assert.equal(observe([cmd('curl -sS https://a.example/x', 'hello', 0)]).obs[0].outcome, 'ran')
  // A compound fetch keeps `ran`: the trailing `head` is a pass-through segment.
  assert.equal(observe([cmd('curl -sS https://a.example/x | head -2', 'hello', 0)]).obs[0].outcome, 'ran')
  // Empty output proves nothing about reachability.
  assert.equal(observe([cmd('curl -sS https://a.example/x', '', 0)]).obs[0].outcome, null)
})

test('observeSession: test labels and test-run evidence', () => {
  const filtered = observe([cmd('python runtests.py app 2>&1 | grep FAILED', '(Bash completed with no output)', 0)]).obs[0]
  assert.deepEqual(filtered.labels, ['app'])
  assert.equal(filtered.loaded, false)
  assert.equal(filtered.testsRan, false)
  assert.equal(formWorked(filtered), false)

  const ran = observe([cmd('python tests/runtests.py app -v 2', 'Ran 4 tests in 0.1s\n\nOK', 0)]).obs[0]
  assert.equal(ran.loaded, true)
  assert.equal(ran.testsRan, true)
  assert.equal(formWorked(ran), true)

  const labelErr = observe([cmd('python tests/runtests.py tests.app', "ModuleNotFoundError: No module named 'tests'", 1)]).obs[0]
  assert.equal(labelErr.labelErr, true)
  assert.equal(formFailed(labelErr), false) // a label mistake is not a failing form
})

test('observeSession: environment-variable evidence', () => {
  const needed = observe([cmd("python -c 'import app'", 'RuntimeError: settings are missing. Define the environment variable APP_SETTINGS before importing app.', 1)])
  assert.deepEqual(needed.env, [{ need: ['APP_SETTINGS'], sets: {}, ok: false, call: 0 }])
  const assigned = observe([cmd("APP_SETTINGS=conf.dev python -c 'import app'", 'ran', 0)])
  assert.deepEqual(assigned.env, [{ need: [], sets: { APP_SETTINGS: 'conf.dev' }, ok: true, call: 0 }])
  assert.equal(assigned.obs[0].env, true)
})

test('observeSession: per-call cwd reproduces a persistent shell cd', () => {
  // Claude Code's shell keeps its directory: a bare runner after `cd tests` runs in tests/.
  const calls = [
    at(edit('/r/pkg/mod0.py'), '/r'),
    at(cmd('cd tests && python runtests.py app0 -v 2', 'Ran 4 tests in 0.1s\n\nOK'), '/r'),
    at(cmd('python runtests.py app0.tests -v 2', 'Ran 4 tests in 0.1s\n\nOK'), '/r/tests'),
  ]
  const digest = observe(calls, { cwd: '/r' })
  assert.deepEqual(digest.obs.map((observation) => observation.form), [
    'cd tests && python runtests.py',
    'cd tests && python runtests.py',
  ])
})

test('observeSession: a session started in a subdirectory learns the repository plain form', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'te-observe-repo-'))
  try {
    const repo = path.join(base, 'repo')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'pkg'))
    const start = path.join(repo, 'pkg')
    const calls = [
      at(edit(path.join(repo, 'pkg', 'm.py')), start),
      at(cmd(`cd ${repo} && pytest -q`, 'bash: line 1: pytest: command not found', 127), start),
      at(cmd(`cd ${repo} && python -m pytest -q`, '1 passed in 0.1s', 0), start),
    ]
    const digest = observe(calls, { cwd: start })
    assert.deepEqual(digest.obs.map((observation) => observation.form), ['pytest', 'python -m pytest'])
    assert.deepEqual(digest.obs.map((observation) => observation.outcome), ['command_missing', 'ran'])
    // The repository path itself never reaches a form.
    assert.equal(digest.obs.some((observation) => observation.form.includes(repo)), false)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('editedFiles/editedPyfiles accept apply_patch path lists', () => {
  /** @type {Array<[string, Record<string, unknown>, string]>} */
  const triples = [
    ['apply_patch', { paths: ['/r/a.py', '/r/b.ts'] }, ''],
    ['multiedit', { path: '/r/c.py' }, ''],
    ['todo_write', { path: '/r/d.py' }, ''],
  ]
  assert.deepEqual([...editedFiles(triples)].sort(), ['a.py', 'b.ts', 'c.py'])
  assert.deepEqual([...editedPyfiles(triples)].sort(), ['a.py', 'c.py'])
})

test('errorLine naming is case-insensitive and line-based (used by attribution)', () => {
  // A lowercase error line inside a large output still names the failing segment.
  const digest = observe([cmd('python -m pytest -q', 'collected 0 items\nusage: pytest [-h]\nunrecognized arguments: --x', 2)])
  assert.equal(digest.obs[0].outcome, 'usage_error')
})

test('envCalls reports needed variables and code-set values', () => {
  const needed = envCalls("python -c 'import app'", 'Define the environment variable APP_SETTINGS.', false)
  assert.deepEqual(needed.need, ['APP_SETTINGS'])
  assert.equal(needed.ok, false)
  const code = 'import os; os.environ.setdefault("APP_SETTINGS", "conf.dev"); import app'
  const sets = envCalls(`python -c '${code}'`, 'ran', true)
  assert.deepEqual(sets.sets, { APP_SETTINGS: 'conf.dev' })
  assert.equal(sets.ok, true)
})
