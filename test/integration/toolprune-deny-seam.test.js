/**
 * In-process seam test: the pure tool-pruning core drives a REAL agent-scoped
 * DSH `tools.restrict({ deny })` and the restriction restores on dispose.
 *
 * This is the closest offline proof that `lib/toolprune/*` can be wired to the
 * DSH adapter without touching the (host-owned) settings writer.
 *
 * @module dsh-tokeneconomizer/test/integration/toolprune-deny-seam.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'

import { createState } from '../../lib/toolprune/evidence.js'
import { applyToolPruneDeny, denyListFor } from './helpers/toolprune-seam.js'

/**
 * @param {string} name
 * @returns {any}
 */
function makeTool(name) {
  return defineTool({
    name,
    description: `integration fixture tool ${name}`,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      return name
    },
  })
}

test('toolprune core: applied state becomes an agent-scoped deny list and restores', async (t) => {
  const ctx = new Context()
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SystemPrompt)
  t.after(async () => {
    await ctx.fiber.dispose()
  })

  /** @type {{ derive: any } } */
  const observed = { derive: null }
  const harness = {
    name: 'toolprune-seam-harness',
    inject: ['tools', 'systemPrompt'],
    /** @param {any} pluginCtx */
    apply(pluginCtx) {
      for (const name of ['bash', 'read', 'fixture_keep', 'fixture_drop', 'fixture_extra']) {
        pluginCtx.tools.register(makeTool(name))
      }

      // A stale applied entry for a protected tool ('bash') must be skipped, the
      // protected config extension too; only fixture_drop is actually denied.
      const state = createState({
        applied: ['fixture_drop', 'bash', 'my_protected_tool'],
      })
      const protectedTools = ['my_protected_tool']
      observed.derive = {
        deny: denyListFor(state, { protectedTools }),
        denied: denyListFor(state),
      }
      assert.deepEqual(observed.derive.deny, ['fixture_drop'], 'protected entries are skipped')

      const fakeAgent = { id: 'deny-agent-1' }
      const scope = createScope(pluginCtx, fakeAgent)
      const applied = applyToolPruneDeny(scope.ctx, state, { protectedTools })

      const globalBefore = pluginCtx.tools.schemas().map((/** @type {any} */ schema) => schema.name).sort()
      const scoped = pluginCtx.tools.schemas(fakeAgent).map((/** @type {any} */ schema) => schema.name).sort()
      assert.ok(globalBefore.includes('fixture_drop'), 'global registry keeps the denied tool')
      assert.ok(!scoped.includes('fixture_drop'), 'agent scope excludes the denied tool')
      assert.ok(scoped.includes('fixture_keep') && scoped.includes('bash'), 'work tools survive')
      assert.ok(!scoped.includes('my_protected_tool'), 'protected entry is never written')
      assert.deepEqual(applied.deny, ['fixture_drop'])
      assert.deepEqual(applied.skippedProtected, ['bash', 'my_protected_tool'])

      applied.dispose()
      const restored = pluginCtx.tools.schemas({ id: 'deny-agent-1' }).map((/** @type {any} */ schema) => schema.name).sort()
      assert.ok(restored.includes('fixture_drop'), 'disposing the restriction restores the tool')
    },
  }
  await ctx.plugin(harness)
  assert.ok(observed.derive !== null)
})
