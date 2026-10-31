import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SpiralState } from '../../../lib/loopguard/state.js'
import { foldShellEdits, shellEditTargets } from '../../../lib/loopguard/shell-edits.js'

/**
 * The upstream parametrized cases (`tests/test_live_core.py:577-619`,
 * `test_edits_made_through_the_shell_are_recognised`).
 * @type {Array<[string, string[]]>}
 */
const CASES = [
  ["sed -i 's/a/b/' pkg/mod.py", ['mod.py']],
  ["cd /t && sed -i.bak -e 's/a/b/' -e 's/c/d/' x.py y.py && pytest -q", ['x.py', 'y.py']],
  ["sed -i '' 's/a/b/' x.py", ['x.py']], // BSD sed's empty suffix
  ["perl -pi -e 's/foo/bar/' src/a.rs", ['a.rs']],
  ["cat > repro.py <<'EOF'\nprint(1 > 0)\nEOF\npython repro.py", ['repro.py']],
  ["echo 'x' | tee -a setup.cfg", ['setup.cfg']],
  // How some agents edit: an inline script that reads the file and writes it back.
  ["python - <<'E'\np='sympy/printing/str.py'; s=open(p).read()\nopen(p,'w').write(s)\nE", ['str.py']],
  ["python - <<'E'\nfor p in ['x/a.py', 'x/b.py']:\n    open(p, 'w').write('')\nE", ['a.py', 'b.py']],
  ["python - <<'E'\nfrom pathlib import Path\nPath('m/n.py').write_text('x')\nE", ['n.py']],
  ['git apply /tmp/fix.diff', ['(patch)']],
  // Codex edits like this, then tests, in ONE command (seen live).
  ["apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: pkg/__init__.py\n@@\n-    x\n+    y\n*** End Patch\nPATCH\npython3 -m unittest", ['__init__.py']],
  ["apply_patch <<'P'\n*** Begin Patch\n*** Add File: a/new.py\n+x\n*** Update File: b/old.py\n*** End Patch\nP", ['new.py', 'old.py']],
  ['git checkout -- a.py b/c.py', ['a.py', 'c.py']],
  // Not edits: output captures, scratch files, reads, and operators inside quotes.
  ['python -m pytest -q > /tmp/out.txt 2>&1; tail -5 /tmp/out.txt', []],
  ["grep -n 'x' a.py > hits.txt", []],
  ["grep -n '>' x.py", []],
  ["grep -nE 'a|b' x.py | head", []],
  ['python -c "print(1>2)"', []],
  ['git stash -q; python bin/test x; git stash pop -q', []],
  ["sed -n '1,20p' pkg/mod.py", []],
  // A quoted `|` in a sed script must not split the command (seen live: sympy-13091).
  ["sed -i -E 's/x (<|<=|>|>=) y/z/' numbers.py expr.py", ['numbers.py', 'expr.py']],
  ["sed -i 's/a/b/' x.py 2>&1 | tail -2", ['x.py']],
]

test('guard.shellEditsRecognized: edits made through the shell are recognised', () => {
  for (const [cmd, want] of CASES) {
    assert.deepEqual(shellEditTargets(cmd), want, `command: ${JSON.stringify(cmd)}`)
  }
})

test('guard.shellEditsRecognized: non-string and blank commands are no edit', () => {
  assert.deepEqual(shellEditTargets(null), [])
  assert.deepEqual(shellEditTargets(undefined), [])
  assert.deepEqual(shellEditTargets('   '), [])
  assert.deepEqual(shellEditTargets(42), [])
})

test('guard.shellEditsRecognized: Windows path separators resolve to basenames', () => {
  assert.deepEqual(shellEditTargets("sed -i 's/a/b/' src\\\\pkg\\\\mod.py"), ['mod.py'])
  assert.deepEqual(shellEditTargets('git checkout -- src\\\\pkg\\\\a.py'), ['a.py'])
})

test('guard.shellEditsRecognized: an unbalanced quote does not hide other lines', () => {
  const cmd = "sed -i 's/a/b/' x.py\necho \"unbalanced"
  assert.deepEqual(shellEditTargets(cmd), ['x.py'])
})

test('guard.shellEditsFeedProxy: shell edits reach the state, the digest and the action log', () => {
  const state = new SpiralState()
  const command = "python - <<'E'\np='pkg/mod.py'; s=open(p).read()\nopen(p,'w').write(s[::-1])\nE"
  for (let i = 0; i < 2; i += 1) {
    state.update('Bash', { command }, '')
    foldShellEdits(state, shellEditTargets(command))
  }
  assert.equal(state.editChurn, 2)
  assert.equal(state.distinctEditFiles, 1)
  assert.equal(state.editOrder.length, 2)
  const digest = state.recentDigest()
  assert.match(digest, /edit_churn=2/)
  assert.match(digest, /\[edits mod\.py\]/)
})

test('guard.shellEditsRecognized: foldShellEdits counts each target and annotates the log', () => {
  const state = new SpiralState()
  state.update('bash', { command: 'echo hi' }, 'hi', 0)
  foldShellEdits(state, ['a.py', 'b.py'])
  assert.equal(state.editCounts['a.py'], 1)
  assert.equal(state.editCounts['b.py'], 1)
  assert.equal(state.editChurn, 1)
  assert.equal(state.distinctEditFiles, 2)
  assert.match(state.recent[0], /\[edits a\.py, b\.py\]/)
})
