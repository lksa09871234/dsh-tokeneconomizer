/**
 * Ported from upstream `tests/test_envfacts.py`, `tests/test_envfacts_args.py`
 * and the generic-vocabulary half of `tests/test_generic_microskills.py`
 * (Apache-2.0, microsoft/TokenEconomizer @ e428fc9).
 *
 * Every session fixture and expected value (claims, firing counters, rendered
 * blocks, fact ids) was cross-checked by replaying the same synthetic sessions
 * through the upstream Python `EnvFactsDistiller`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CONTRADICT_STREAK,
  ERROR_PHRASE,
  EnvFact,
  EnvFactsModel,
  GENERIC_HEADER,
  HEADER,
  MAX_FACTS,
  MAX_TOKENS,
  STATE_SUBDIR,
  foldFact,
  join,
  lintOk,
  rootKey,
  sanitizeOneLine,
  typedOk,
  usage,
  vocabularyByName,
} from '../../../lib/microskills/envfacts.js'
import { GENERIC, PYTHON_GIT, formWorked } from '../../../lib/microskills/observe.js'
import {
  CANT_OPEN,
  LOCAL_PYTEST,
  NEED,
  OK,
  PROJ,
  PYTHON_BASE,
  argRun,
  brokenEnv,
  cleanEnv,
  cleanRunner,
  cmd,
  edit,
  fixedEnv,
  goneEnv,
  messyEnv,
  observe,
  pyCmd,
  repeatedEnv,
  stream,
} from './helpers.js'

/** @returns {EnvFactsModel} */
function newModel(options = {}) {
  return new EnvFactsModel({ repo: 'acme/widget', vocab: GENERIC, ...options })
}

/**
 * @param {EnvFactsModel} model
 * @param {import('../../../lib/microskills/observe.js').NormalizedCall[]} calls
 * @returns {Record<string, any>}
 */
function foldOnce(model, calls) {
  model.render()
  return model.update(observe(calls), { iid: 't', resolved: true })
}

test('constants are upstream values (envfacts.py:43-60,146)', () => {
  assert.equal(STATE_SUBDIR, 'envfacts_state')
  assert.equal(MAX_FACTS, 4)
  assert.equal(MAX_TOKENS, 150)
  assert.equal(CONTRADICT_STREAK, 2)
  assert.equal(HEADER, '# environment facts learned from earlier tasks in this checkout')
  assert.equal(GENERIC_HEADER, '# environment facts learned from earlier sessions in this repository')
  assert.equal(ERROR_PHRASE.script_missing, 'a file-not-found error')
})

// ---- FormRepair -------------------------------------------------------------------------

test('formsInterpreterFact: three drifted confirmations plus four exercised tasks fire', () => {
  const model = stream(newModel(), 3, brokenEnv)
  assert.equal(model.render(), '') // ACTIVE needs 3 confirms AND 4 exercised
  model.render()
  model.update(observe(brokenEnv(3)), { iid: 'w-3', resolved: true })
  const text = model.render()
  assert.ok(text.startsWith(GENERIC_HEADER))
  assert.ok(text.includes(PROJ))
  assert.ok(text.includes('python -m pytest …` fails here'))
  assert.equal(model.optTokens, 0)
  const fact = model.facts.get('form_repair:run_tests:python -m pytest')
  assert.ok(fact)
  assert.equal(fact.state, 'ACTIVE')
  assert.equal(fact.life.fireNum, 4)
  assert.equal(fact.life.fireDen, 4)
  assert.ok(lintOk(text))
})

test('dshAdapterShape: the DSH normalized-call shape yields the same fact', () => {
  // Raw host tool names / failed / exitCode, exactly what lib/dsh/normalize.js returns.
  /** @param {number} index @returns {import('../../../lib/microskills/observe.js').NormalizedCall[]} */
  const claudeSchemaSession = (index) => [
    { tool: 'Edit', args: { file_path: `/testbed/pkg/c${index}.py` }, resultText: 'ok', failed: false, exitCode: 0 },
    {
      tool: 'Bash',
      args: { command: 'python -m pytest tests/test_a.py -q' },
      resultText: `Exit code 1\n${PYTHON_BASE}: No module named pytest`,
      failed: true,
      exitCode: 1,
    },
    {
      tool: 'Bash',
      args: { command: `${PROJ} -m pytest tests/test_a.py -q` },
      resultText: '1 passed',
      failed: false,
      exitCode: 0,
    },
  ]
  const model = stream(newModel(), 4, claudeSchemaSession)
  assert.ok(model.render().includes(PROJ))
  assert.equal(model.facts.get('form_repair:run_tests:python -m pytest')?.state, 'ACTIVE')
})

test('cleanEnvironmentFormsNothing: eight clean sessions learn no fact', () => {
  const model = stream(newModel(), 8, cleanEnv)
  assert.equal(model.facts.size, 0)
  assert.equal(model.render(), '')
})

test('preventedWasteCountsAsFiring: an injected fact keeps counting when the waste is avoided', () => {
  const model = stream(newModel(), 4, brokenEnv)
  assert.notEqual(model.render(), '') // injected for the next session
  // The agent followed the fact: used the working form straight away, nothing failed.
  model.update(observe([
    edit('pkg/z.py'),
    cmd(`${PROJ} -m pytest tests/test_z.py -q`, '3 passed', 0),
  ]), { iid: 'w-9', resolved: true })
  const fact = model.facts.get('form_repair:run_tests:python -m pytest')
  assert.ok(fact)
  assert.equal(fact.life.fireNum, 5)
  assert.equal(fact.life.fireDen, 5)
  assert.notEqual(model.render(), '')
})

test('bareRunnerSuccessRetires: a working bare runner contradicts twice then retires', () => {
  const model = stream(newModel(), 4, brokenEnv)
  assert.notEqual(model.render(), '')
  for (let index = 20; index < 23; index += 1) {
    model.render()
    model.update(observe(fixedEnv(index)), { iid: `w-${index}`, resolved: true })
  }
  const fact = model.facts.get('form_repair:run_tests:python -m pytest')
  assert.ok(fact)
  assert.equal(fact.state, 'RETIRED')
  assert.equal(model.render(), '')
})

test('bareInterpreterOneLinerNotContradiction: a successful bare `python -c` proves nothing', () => {
  const model = stream(newModel(), 4, brokenEnv)
  model.render()
  model.update(observe([
    edit('pkg/q.py'),
    cmd("python -c 'import pkg; print(pkg.__version__)'", '1.0', 0),
    cmd(`${PROJ} -m pytest tests -q`, '2 passed', 0),
  ]), { iid: 'w-9', resolved: true })
  assert.equal(model.facts.get('form_repair:run_tests:python -m pytest')?.state, 'ACTIVE')
})

test('envFactIgnoresEditDrift: the same file every session still promotes', () => {
  const model = stream(newModel(), 4, () => [
    edit('pkg/stock.py'),
    cmd('pytest -q', 'bash: pytest: command not found', 127),
    cmd('python -m pytest -q', '4 passed in 0.01s', 0),
  ])
  assert.equal(model.facts.get('form_repair:run_tests:pytest')?.state, 'ACTIVE')
  const text = model.render()
  assert.ok(text.includes('`pytest …` fails here with command not found'))
  assert.equal(text.includes('stock.py'), false)
})

test('envPrefixedRunNotNamed: a form that only worked with an assignment is not named', () => {
  const model = stream(newModel(), 3, cleanRunner)
  assert.equal(model.render(), '')
  for (let index = 3; index < 6; index += 1) {
    model.render()
    model.update(observe(messyEnv(index)), { iid: `m-${index}`, resolved: true })
  }
  const fact = model.facts.get('form_repair:run_tests:pytest')
  assert.ok(fact)
  assert.equal(Object.prototype.hasOwnProperty.call(fact.params.b_counts, LOCAL_PYTEST), false)
  const text = model.render()
  const lastLine = text.trim().split('\n').pop() ?? ''
  assert.ok(lastLine.endsWith('`python -m pytest …` works.'), lastLine)
})

test('oneEvidencePerFormPerSession: one session adds at most one count per form', () => {
  const model = stream(newModel(), 2, cleanRunner)
  model.render()
  model.update(observe(repeatedEnv(2)), { iid: 'r', resolved: true })
  const fact = model.facts.get('form_repair:run_tests:pytest')
  assert.ok(fact)
  assert.deepEqual(fact.params.b_counts, {
    'python -m pytest': 2,
    [`${PROJ} -m pytest`]: 1,
  })
  assert.equal(fact.workingForm(), 'python -m pytest')
})

test('formStopsWorking: a form that stops working is no longer named', () => {
  const model = stream(newModel(), 4, cleanRunner)
  assert.ok(model.render().includes('`python -m pytest …` works'))
  for (let index = 4; index < 9; index += 1) {
    model.render()
    model.update(observe(goneEnv(index)), { iid: `g-${index}`, resolved: true })
  }
  const fact = model.facts.get('form_repair:run_tests:pytest')
  assert.ok(fact)
  assert.equal(fact.params.b_fails['python -m pytest'], 5)
  assert.equal(fact.workingForm(), null)
  assert.equal(fact.claim(), '')
  assert.equal(model.render().includes('python -m pytest'), false)
})

test('formScriptMissing: a runner script run where it is not becomes a fact', () => {
  const model = stream(newModel(), 6, (index) => [
    edit(`/r/pkg/mod${index}.py`),
    cmd(`python runtests.py app${index}`, CANT_OPEN, 2),
    cmd(`cd tests && python runtests.py app${index}`, OK, 0),
  ])
  const text = model.render()
  assert.ok(text.includes('`python runtests.py …` fails here with a file-not-found error; `(cd tests && python runtests.py …)` works.'), text)
})

test('formOptionRejected: an option the runner rejects is not a failing form', () => {
  const badUsage = 'Exit code 2\nusage: runtests.py [-h] [module [module ...]]\nruntests.py: error: unrecognized arguments: test_x'
  const model = stream(newModel(), 6, (index) => [
    edit(`/r/pkg/mod${index}.py`),
    cmd(`python runtests.py app${index} -k test_x`, badUsage, 2),
    cmd(`python tests/runtests.py app${index}`, OK, 0),
  ])
  assert.equal([...model.facts.values()].filter((fact) => fact.family === 'form_repair').length, 0)
})

test('formOutputFiltered: filtered-away output does not show a form works', () => {
  const model = stream(newModel(), 6, (index) => [
    edit(`/r/pkg/mod${index}.py`),
    cmd('python -m pytest tests/app', 'Exit code 1\n/venv/bin/python: No module named pytest', 1),
    cmd(`python runtests.py app${index} 2>&1 | grep -E '^(OK|FAILED|Ran )'`, '(Bash completed with no output)', 0),
  ])
  assert.equal([...model.facts.values()].filter((fact) => fact.family === 'form_repair').length, 0)
})

test('formWorkingFormPrefersStill: the named working form leaves the shell where it is', () => {
  /** @type {import('../../../lib/microskills/observe.js').NormalizedCall[][]} */
  const tasks = []
  for (let index = 0; index < 6; index += 1) {
    tasks.push([
      edit(`/r/pkg/mod${index}.py`),
      cmd(`python runtests.py app${index}`, CANT_OPEN, 2),
      cmd(`cd tests && python runtests.py app${index}`, OK, 0),
      cmd(`cd tests && python runtests.py app${index}.tests`, OK, 0),
    ])
  }
  tasks[3].push(cmd('python tests/runtests.py app3', OK, 0))
  let cursor = 0
  const model = stream(newModel(), 6, () => tasks[cursor++])
  const fact = model.facts.get('form_repair:run_tests:python runtests.py')
  assert.ok(fact)
  assert.ok(fact.params.b_counts['cd tests && python runtests.py'] > fact.params.b_counts['python tests/runtests.py'])
  assert.ok(model.render().includes('`python tests/runtests.py …` works'))
})

test('formMistypedLabels: mistyped labels do not teach that the runner fails', () => {
  const bad = "tests (unittest.loader._FailedTest) ... ERROR\nImportError: Failed to import test module: tests\nModuleNotFoundError: No module named 'tests.app'"
  const model = stream(newModel(), 6, (index) => [
    edit(`/r/pkg/mod${index}.py`),
    argRun(`tests.app${index}.tests.T`, bad, 1),
    cmd(`cd tests && python runtests.py app${index}.tests.T -v 2`, OK, 0),
  ])
  assert.equal([...model.facts.values()].filter((fact) => fact.family === 'form_repair').length, 0)
  assert.equal(model.render().includes('fails here'), false)
})

// ---- EmptyProbe / Boundary -------------------------------------------------------------

test('emptyProbeFact: empty probes form the history fact; a hit retires it hard', () => {
  const empty = stream(newModel(), 4, (index) => [
    edit(`pkg/e${index}.py`),
    cmd('git remote -v; git tag --contains HEAD | head', '', 0),
    cmd(`${PROJ} -m pytest tests -q`, '1 passed', 0),
  ])
  const text = empty.render()
  assert.ok(text.includes('history ends at the checked-out commit'))

  const leaky = stream(new EnvFactsModel({ repo: 'acme/leaky', vocab: GENERIC }), 4, (index) => [
    edit(`pkg/l${index}.py`),
    cmd('git tag --contains HEAD | head', '0.22\n0.22.1\n0.23.0', 0),
  ])
  assert.equal(leaky.render(), '')
  assert.equal(leaky.facts.get('empty_probe:vcs_refs')?.state, 'RETIRED')
})

test('boundaryRefusedHosts: refused hosts form a boundary fact; a reachable host retires it', () => {
  const model = stream(newModel(), 4, (index) => [
    edit(`pkg/n${index}.py`),
    cmd('curl -sS https://raw.example.org/a/b.py',
      'curl: (7) Failed to connect to raw.example.org port 443: Connection refused', 7),
    cmd('curl -sS https://api.example.org/search?q=x',
      'curl: (7) Failed to connect to api.example.org port 443: Connection refused', 7),
  ])
  const text = model.render()
  assert.ok(text.includes('raw.example.org'))
  assert.ok(text.includes('api.example.org'))
  assert.ok(text.includes('refused'))
  model.render()
  model.update(observe([cmd('curl -sS https://api.example.org/ok', '{"ok": true}', 0)]), { iid: 'w-9', resolved: true })
  assert.equal(model.facts.get('boundary:fetch_remote')?.state, 'RETIRED')
})

// ---- ArgRepair -------------------------------------------------------------------------

test('argRepairPrefix: a label prefix the runner rejects becomes a fact', () => {
  const model = stream(newModel(), 6, (index) => [
    edit(`/r/pkg/mod${index}.py`),
    argRun(`tests.app${index}`, "ModuleNotFoundError: No module named 'tests'", 1),
    argRun(`app${index}`, OK, 0),
  ])
  const text = model.render()
  assert.ok(text.includes('takes test labels without the `tests.` prefix'), text)
  const fact = [...model.facts.values()].find((candidate) => candidate.family === 'arg_repair')
  assert.ok(fact)
  assert.ok(fact.claim().startsWith('`python tests/runtests.py` takes'))
  assert.ok(fact.claim().includes('(`app'))
  assert.ok(lintOk(fact.claim()))
})

test('argRepairSeparators: pytest-style `::` labels become a dotted-label fact', () => {
  const model = stream(newModel(), 6, (index) => [
    edit(`/r/pkg/mod${index}.py`),
    argRun(`app${index}.tests::T::test_x`, `ImportError: Failed to import test module: app${index}.tests::T::test_x`, 1),
    argRun(`app${index}.tests.T.test_x`, OK, 0),
  ])
  assert.ok(model.render().includes('takes dotted test labels'))
  const fact = model.facts.get('arg_repair:python tests/runtests.py:sep:::')
  assert.ok(fact)
  assert.equal(Object.keys(fact.params.examples).length, 6)
  assert.equal(fact.params.examples['app0.tests::T::test_x app0.tests.T.test_x'], 1)
})

test('argPlainMistake: a label naming something that does not exist is not a fact', () => {
  const model = stream(newModel(), 6, (index) => [
    edit(`/r/pkg/mod${index}.py`),
    argRun(`app${index}.tests.Missing`, `AttributeError: module 'app${index}.tests' has no attribute 'Missing'`, 1),
    argRun(`app${index}`, OK, 0),
  ])
  assert.equal([...model.facts.values()].filter((fact) => fact.family === 'arg_repair').length, 0)
  assert.equal(model.render(), '')
})

test('argPrefixedContradicts: a prefixed label that loads contradicts the fact', () => {
  /** @type {import('../../../lib/microskills/observe.js').NormalizedCall[][]} */
  const tasks = []
  for (let index = 0; index < 4; index += 1) {
    tasks.push([
      edit(`/r/pkg/mod${index}.py`),
      argRun(`tests.app${index}`, "ModuleNotFoundError: No module named 'tests'", 1),
      argRun(`app${index}`, OK, 0),
    ])
  }
  tasks.push([edit('/r/pkg/mod9.py'), argRun('tests.app9', OK, 0)])
  let cursor = 0
  const model = stream(newModel(), 5, () => tasks[cursor++])
  assert.equal(model.lastDigest?.verdicts['arg_repair:python tests/runtests.py:strip:tests.']?.verdict, 'contradict')
  assert.equal(model.facts.get('arg_repair:python tests/runtests.py:strip:tests.')?.state, 'RETIRED')
})

test('argFiltered: filtered output neither teaches nor contradicts', () => {
  /** @type {import('../../../lib/microskills/observe.js').NormalizedCall[][]} */
  const tasks = []
  for (let index = 0; index < 4; index += 1) {
    tasks.push([
      edit(`/r/pkg/mod${index}.py`),
      argRun(`app${index}.tests::T::test_x`, `app${index}.tests::T::test_x (unittest.loader._FailedTest) ... ERROR`, 1),
      argRun(`app${index}.tests.T.test_x`, OK, 0),
    ])
  }
  tasks.push([
    edit('/r/pkg/mod8.py'),
    argRun('app8.tests::T::test_x', 'FAILED (errors=1)', 0),
    argRun('app8.tests::T::test_y', '', 0),
  ])
  let cursor = 0
  const model = stream(newModel(), 5, () => tasks[cursor++])
  const factId = 'arg_repair:python tests/runtests.py:sep:::'
  assert.notEqual(model.lastDigest?.verdicts[factId]?.verdict, 'contradict')
  assert.notEqual(model.facts.get(factId)?.state, 'RETIRED')
  assert.equal(model.facts.get(factId)?.life.fireDen, 5)
  assert.equal(model.facts.get(factId)?.life.fireNum, 4)
})

test('argRepairNeedsTestsRan: a repair needs the rewritten label to have run tests', () => {
  const model = stream(newModel(), 6, (index) => [
    edit(`/r/pkg/mod${index}.py`),
    argRun(`tests.app${index}`, "ModuleNotFoundError: No module named 'tests'", 1),
    argRun(`app${index}`, '', 0),
  ])
  assert.equal([...model.facts.values()].filter((fact) => fact.family === 'arg_repair').length, 0)
})

// ---- EnvValue --------------------------------------------------------------------------

test('envValue: a variable the code asks for and its working value become a fact', () => {
  const model = stream(newModel(), 6, (index) => [
    edit(`/r/pkg/mod${index}.py`),
    pyCmd('import app; app.run()', '', NEED, 1),
    pyCmd('import app; app.run()', 'APP_SETTINGS=conf.missing ',
      "Traceback (most recent call last):\nModuleNotFoundError: No module named 'conf.missing'", 1),
    pyCmd('import app; app.run()', 'APP_SETTINGS=conf.dev ', 'ran', 0),
  ])
  const claim = model.facts.get('env_value:APP_SETTINGS')?.claim()
  assert.equal(claim, 'Code that imports the project needs `APP_SETTINGS` set here: `APP_SETTINGS=conf.dev` works, `conf.missing` does not.')
  assert.ok(lintOk(String(claim)))
  assert.ok(model.render().includes('`APP_SETTINGS=conf.dev` works'))
})

test('envValueInCode: a value set in the code counts too', () => {
  const code = 'import os; os.environ.setdefault("APP_SETTINGS", "conf.dev"); import app'
  const model = stream(newModel(), 6, (index) => [
    edit(`/r/pkg/mod${index}.py`),
    pyCmd('import app', '', NEED, 1),
    cmd(`python -c '${code}'`, 'ran', 0),
  ])
  const fact = model.facts.get('env_value:APP_SETTINGS')
  assert.ok(fact)
  assert.deepEqual(fact.params.good, { 'conf.dev': 6 })
})

test('envValueNoGood: no value that worked means no fact', () => {
  const model = stream(newModel(), 6, (index) => [
    edit(`/r/pkg/mod${index}.py`),
    pyCmd('import app', '', NEED, 1),
    pyCmd('import app', 'APP_SETTINGS=conf.missing ', 'Traceback (most recent call last):\nNameError: x', 1),
  ])
  assert.equal(model.facts.has('env_value:APP_SETTINGS'), false)
  assert.equal(model.render(), '')
})

test('envValueAskedAgain: being asked for the variable again does not confirm its value', () => {
  const model = newModel()
  model.render()
  model.update(observe([
    edit('/r/pkg/mod0.py'),
    pyCmd('import app', '', NEED, 1),
    pyCmd('import app', 'APP_SETTINGS=conf.dev ', 'ran', 0),
  ]), { iid: 't0', resolved: true })
  for (let index = 1; index < 6; index += 1) {
    model.render()
    model.update(observe([edit(`/r/pkg/mod${index}.py`), pyCmd('import app', '', NEED, 1)]), { iid: `t${index}`, resolved: true })
  }
  assert.equal(model.facts.get('env_value:APP_SETTINGS')?.state, 'CANDIDATE')
  assert.equal(model.render().includes('APP_SETTINGS'), false)
})

// ---- rendering discipline ---------------------------------------------------------------

test('lintRejectsAdvice: completion and verification advice never renders', () => {
  assert.equal(lintOk('You are done once the tests pass; skip the rest.'), false)
  assert.equal(lintOk('no need to verify'), false)
  assert.equal(lintOk("don't run it"), false)
  assert.equal(lintOk('Do not stop'), false)
  assert.equal(lintOk('completed'), false)
  assert.equal(lintOk('finished here'), false)
  assert.equal(lintOk('verification step'), false)
  assert.equal(lintOk('`python …` fails here with command not found; `/x/bin/python …` works.'), true)
})

test('blockRespectsCaps: the rendered block stays within MAX_FACTS and MAX_TOKENS*4', () => {
  const model = new EnvFactsModel({ repo: 'acme/widget', vocab: GENERIC })
  for (let index = 0; index < 7; index += 1) {
    const fact = new EnvFact(`form_repair:run_tests:tool${index}`, 'form_repair', false, {
      intent: 'run_tests',
      a: `tool${index}`,
      b_counts: { [`/very/long/path/number/${index}/that/keeps/going/bin/tool${index}`]: 3 },
      error_counts: { command_missing: 3 },
    })
    fact.life.state = 'ACTIVE'
    fact.life.fireNum = 10
    fact.life.fireDen = 10
    model.facts.set(fact.id, fact)
  }
  const text = model.render()
  assert.ok(text.length > 0)
  assert.ok(text.length <= MAX_TOKENS * 4)
  assert.ok(text.split('\n- ').length - 1 <= MAX_FACTS)
  assert.equal(model.injectedIds().length, MAX_FACTS)
})

test('mergeFormRepairLines: facts whose working forms share a root collapse into one line', () => {
  /** @param {number} index @returns {import('../../../lib/microskills/observe.js').NormalizedCall[]} */
  const twoForms = (index) => [
    edit(`pkg/m${index}.py`),
    cmd('pytest tests/test_a.py -q', 'bash: pytest: command not found', 127),
    cmd('python -m pytest tests/test_a.py -q', `${PYTHON_BASE}: No module named pytest`, 1),
    cmd(`${PROJ} -m pytest tests/test_a.py -q`, '1 passed', 0),
  ]
  const model = stream(newModel(), 4, twoForms)
  const text = model.render()
  assert.equal(text.split('\n- ').length - 1, 1)
  assert.ok(text.includes('pytest …`'))
  assert.ok(text.includes('python -m pytest …`'))
  // One working form: the merged line says "works", singular.
  const lastLine = text.trim().split('\n').pop() ?? ''
  assert.ok(lastLine.endsWith(`\`${PROJ} -m pytest …\` works.`), lastLine)
})

test('genericBuildRepair: the generic vocabulary learns a build-tool repair', () => {
  const model = new EnvFactsModel({ repo: 'acme/web', vocab: GENERIC })
  for (let index = 0; index < 6; index += 1) {
    model.render()
    model.update(observe([
      { tool: 'Edit', args: { file_path: `/r/src/m${index}.ts` }, resultText: 'ok', failed: false },
      cmd('tsc -p .', 'Exit code 127\nbash: tsc: command not found', 127),
      cmd('npx tsc -p .', '', 0),
    ]), { iid: `s${index}`, resolved: true })
  }
  const text = model.render()
  assert.ok(text.startsWith(GENERIC_HEADER))
  assert.ok(text.includes('`tsc …` fails here with command not found; `npx tsc …` works.'))
  assert.equal(model.facts.get('form_repair:run_build:tsc')?.state, 'ACTIVE')
})

// ---- persistence, seeding, telemetry ----------------------------------------------------

test('saveLoadRoundtrip: toJSON/fromJSON keeps the learned state', () => {
  const model = stream(newModel(), 4, brokenEnv)
  const document = model.toJSON()
  assert.equal(document.opt_tokens, 0)
  assert.equal(document.repo, 'acme/widget')
  assert.equal(document.vocab, 'generic')
  const restored = EnvFactsModel.fromJSON(JSON.parse(JSON.stringify(document)))
  assert.equal(restored.now, 4)
  assert.equal(restored.render(), model.render())
  assert.equal(restored.optTokens, 0)
  assert.equal(restored.facts.get('form_repair:run_tests:python -m pytest')?.state, 'ACTIVE')
})

test('seedInjected: an injected fact still counts as fired across processes', () => {
  const first = stream(newModel(), 4, brokenEnv)
  assert.notEqual(first.render(), '') // the session-start render records what was injected
  const ids = first.injectedIds()
  assert.deepEqual(ids, ['form_repair:run_tests:python -m pytest'])

  const second = EnvFactsModel.fromJSON(JSON.parse(JSON.stringify(first.toJSON())))
  second.render() // the next session renders (and would inject) the fact
  second.seedInjected(ids) // ... and the fold is told it was given
  second.update(observe([edit('pkg/z.py'), cmd(`${PROJ} -m pytest -q`, '3 passed', 0)]), { iid: 'w-9', resolved: true })
  const fact = second.facts.get('form_repair:run_tests:python -m pytest')
  assert.ok(fact)
  assert.equal(fact.life.fireNum, 5)
  assert.equal(fact.life.fireDen, 5)
  // seedInjected filters ids that are not tracked facts.
  second.seedInjected(['nope'])
  assert.deepEqual(second.injectedIds(), [])
})

test('factsView: status rows expose state, firing, rate and claim', () => {
  const model = stream(newModel(), 4, brokenEnv)
  const rows = model.factsView()
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.id, 'form_repair:run_tests:python -m pytest')
  assert.equal(row.family, 'form_repair')
  assert.equal(row.state, 'ACTIVE')
  assert.equal(row.fire, '4/4')
  assert.equal(row.rate, 1)
  assert.equal(row.injectable, true)
  assert.ok(row.claim.includes('fails here'))
})

test('headers: the vocabulary chooses the header line', () => {
  const generic = new EnvFactsModel({ repo: 'acme/widget', vocab: GENERIC })
  assert.equal(generic.header, GENERIC_HEADER)
  const pythonGit = new EnvFactsModel({ repo: 'acme/widget', vocab: PYTHON_GIT })
  assert.equal(pythonGit.header, HEADER)
  assert.equal(vocabularyByName('generic'), GENERIC)
  assert.equal(vocabularyByName('python-git'), PYTHON_GIT)
  assert.equal(vocabularyByName('unknown'), GENERIC)
})

test('crossProjectIsolation: two models never share learned facts', () => {
  const first = stream(newModel(), 4, brokenEnv)
  const second = stream(new EnvFactsModel({ repo: 'acme/other', vocab: GENERIC }), 4, cleanRunner)
  assert.ok(first.facts.has('form_repair:run_tests:python -m pytest'))
  assert.equal(second.facts.has('form_repair:run_tests:python -m pytest'), false)
  assert.ok(second.facts.has('form_repair:run_tests:pytest'))
  assert.equal(first.facts.has('form_repair:run_tests:pytest'), false)
  assert.equal(first.render().includes('`pytest …` fails here'), false)
  assert.equal(second.render().includes('`python -m pytest …` fails here'), false)
  // A new model for the same project starts empty too: state lives in the document.
  assert.equal(newModel().facts.size, 0)
})

test('lastDigest: per-session telemetry records verdicts and injected ids', () => {
  const model = stream(newModel(), 4, brokenEnv)
  const digest = model.lastDigest
  assert.ok(digest)
  assert.equal(digest.nCalls, 3)
  const verdict = digest.verdicts['form_repair:run_tests:python -m pytest']
  assert.ok(verdict)
  assert.equal(verdict.exercised, true)
  assert.equal(verdict.fired, true)
  assert.equal(verdict.verdict, 'confirm')
  // Rendered ids are consumed by the fold and cleared afterwards.
  const next = foldOnce(model, brokenEnv(9))
  assert.deepEqual(next.injected, ['form_repair:run_tests:python -m pytest'])
  assert.deepEqual(model.injectedIds(), [])
})

// ---- pure helpers -----------------------------------------------------------------------

test('claim rendering helpers: usage, rootKey, join', () => {
  assert.equal(usage('python -m pytest'), '`python -m pytest …`')
  assert.equal(usage('cd tests && python runtests.py'), '`(cd tests && python runtests.py …)`')
  assert.equal(usage('python tests/runtests.py', ''), '`python tests/runtests.py`')
  assert.equal(rootKey('cd tests && python runtests.py'), 'cd tests')
  assert.equal(rootKey('conda run -n proj python -m pytest'), 'conda run -n')
  assert.equal(rootKey('/opt/env/bin/python -m pytest'), '/opt/env/bin')
  assert.equal(join([]), 'the hosts it tried')
  assert.equal(join(['a']), 'a')
  assert.equal(join(['a', 'b']), 'a and b')
  assert.equal(join(['a', 'b', 'c']), 'a, b and c')
})

test('sanitizeOneLine strips control characters and newlines', () => {
  assert.equal(sanitizeOneLine('a\nb\tc'), 'a b c')
  assert.equal(sanitizeOneLine('a\u0000b\u001fc'), 'a b c')
  assert.equal(sanitizeOneLine('a\u2028b'), 'a b')
  assert.equal(sanitizeOneLine('  spaced  out  '), 'spaced out')
  assert.equal(sanitizeOneLine(null), '')
})

test('EnvFact: malformed documents are rejected individually', () => {
  assert.throws(() => EnvFact.fromJSON(null), TypeError)
  assert.throws(() => EnvFact.fromJSON({}), TypeError)
  assert.throws(() => EnvFact.fromJSON({ id: 'x', family: 'form_repair' }), TypeError) // no life
  const fact = new EnvFact('x', 'form_repair', false, { intent: 'run_tests', a: 'a' })
  assert.equal(fact.claim(), '') // no working form -> no claim
  const restored = EnvFact.fromJSON(JSON.parse(JSON.stringify(fact.toJSON())))
  assert.equal(restored.life.drift, false) // envfacts.py:142 forces drift off
})

test('foldFact: a high-stakes CANDIDATE retires on its first contradiction', () => {
  const fact = new EnvFact('probe', 'empty_probe', true, { kinds: {} })
  foldFact(fact, 0, 'contradict', true, true, new Set())
  assert.equal(fact.life.state, 'RETIRED')
  assert.equal(fact.life.retiredAt, 0)
})

test('formWorked/typedOk: an environment-prefixed success is not typed evidence', () => {
  const [plain] = observe([cmd('python -m pytest -q', '1 passed', 0)]).obs
  assert.ok(plain)
  assert.equal(formWorked(plain), true)
  assert.equal(typedOk(plain), true)
  const [prefixed] = observe([cmd('PYTHONPATH=. python -m pytest -q', '1 passed', 0)]).obs
  assert.ok(prefixed)
  assert.equal(prefixed.env, true)
  assert.equal(typedOk(prefixed), false)
})
