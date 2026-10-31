import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  HIGH_RISK_FACTOR,
  INAPPLICABLE_TOOLS,
  PROTECTED_TOOLS,
  effectiveProtectedTools,
  isHighRiskTool,
  isProtectedTool,
} from '../../../lib/toolprune/tools.js'

test('the default protected set covers the DSH work surface and the upstream spellings', () => {
  for (const name of ['bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'Bash', 'Read']) {
    assert.ok(PROTECTED_TOOLS.includes(name), `${name} should be protected`)
  }
  assert.ok(PROTECTED_TOOLS.length >= 20)
})

test('inapplicable tools are a documented set but never pruned by this module', () => {
  assert.ok(INAPPLICABLE_TOOLS.includes('task'))
  assert.ok(INAPPLICABLE_TOOLS.includes('ask_user_question'))
  // They are not implicitly protected: a tool inapplicable by construction is
  // simply never loaded in a sealed run; the adapter may pre-filter it.
  assert.equal(isProtectedTool('task', []), false)
})

test('configuration can extend the protected set, and duplicates collapse', () => {
  const set = effectiveProtectedTools(['my_mcp_tool', 'read', ''])
  assert.ok(set.has('my_mcp_tool'))
  assert.ok(set.has('read'))
  assert.ok(!set.has(''))
  assert.equal(isProtectedTool('my_mcp_tool', ['my_mcp_tool']), true)
  assert.equal(isProtectedTool('other_tool', ['my_mcp_tool']), false)
  assert.equal(isProtectedTool('', ['my_mcp_tool']), false)
})

test('the high-risk factor is the upstream 3 and applies to the upstream name', () => {
  assert.equal(HIGH_RISK_FACTOR, 3)
  assert.equal(isHighRiskTool('NotebookEdit'), true)
  assert.equal(isHighRiskTool('notebook_edit'), true)
  assert.equal(isHighRiskTool('read'), false)
  assert.equal(isHighRiskTool(''), false)
})
