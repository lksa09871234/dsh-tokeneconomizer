/**
 * In-process, offline DSH integration test with a fake LLM adapter.
 *
 * Mounts the REAL DSH packages (Cordis, llm, agent, agent-loop, session,
 * session-projection, system-prompt, tools) in a bare application and drives
 * one agent turn against a fake adapter. No DSH profile, no network, no paid
 * model call.
 *
 * What it proves for the plugin port:
 * - an agent-scoped `tools.restrict({ deny })` removes a tool from the
 *   model-facing declaration set while the global registry keeps it (this is
 *   the DSH deny path tool pruning will use);
 * - the exact tool set of the dispatched request and of the durable
 *   `request/header` session event excludes the denied tool;
 * - a dynamic, agent-scoped `systemPrompt.section` (the learned-notes injection
 *   path) is rendered into the assembled system prompt of a real turn;
 * - a root-context plugin observes `agent/created` and `session/event`.
 *
 * This file is a host-boundary test: it deliberately types the fake adapter and
 * fixture callbacks loosely (`any`) because the harness declarations for a
 * streaming adapter are stricter than a test double needs to be.
 *
 * @module dsh-tokeneconomizer/test/integration/inprocess-fake-llm.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'

/** @typedef {{ toolNames: string[], systemText: string }} CapturedRequest */

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

/**
 * Build the DSH application context used by the test.
 * @returns {Promise<Context>}
 */
async function createApp() {
  const ctx = new Context()
  for (const plugin of [SystemPrompt, ToolRuntime, LlmRuntime, SessionStore, SessionProjectionRegistry, AgentRegistry, AgentLoop]) {
    await ctx.plugin(plugin)
  }
  return ctx
}

/**
 * @typedef {object} Observed
 * @property {{ id: string, source: string }[]} created
 * @property {any[]} sessionEvents
 * @property {any} agentCtx
 */

test('in-process: real DSH packages + fake LLM prove restriction, dynamic section and hooks', async (t) => {
  const ctx = await createApp()
  t.after(async () => {
    await ctx.fiber.dispose()
  })

  /** @type {CapturedRequest[]} */
  const requests = []
  class FakeAdapter extends LlmAdapter {
    /**
     * @param {any} options
     * @returns {AsyncGenerator<any>}
     */
    async *stream(options) {
      /** @type {any[]} */
      const messages = options.messages ?? []
      /** @type {any[]} */
      const tools = options.tools ?? []
      const systemBlocks = messages
        .filter((message) => message.role === 'system')
        .flatMap((message) => message.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
      requests.push({
        toolNames: tools.map((tool) => tool.name),
        systemText: systemBlocks.join('\n'),
      })
      const text = 'FAKE-ADAPTER-REPLY'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['integration-provider'], /** @type {any} */ (new FakeAdapter()))

  /** @type {Observed} */
  const observed = { created: [], sessionEvents: [], agentCtx: null }
  ctx.on('agent/created', (/** @type {any} */ payload) => {
    observed.created.push({ id: payload.agent.id, source: payload.source })
    return undefined
  })
  ctx.on('session/event', (/** @type {any} */ _session, /** @type {any} */ event) => {
    observed.sessionEvents.push(event)
  })

  const harness = {
    name: 'te-inprocess-harness',
    inject: ['tools', 'systemPrompt'],
    /** @param {any} pluginCtx */
    apply(pluginCtx) {
      pluginCtx.tools.register(makeTool('fixture_keep'))
      pluginCtx.tools.register(makeTool('fixture_drop'))
      pluginCtx.systemPrompt.section({ name: 'te:global', order: 15_000, text: 'TE-GLOBAL-SECTION' })
    },
  }
  await ctx.plugin(harness)

  const handle = await ctx.agents.create(/** @type {any} */ ({
    sessionId: 'integration-session-1',
    agentOptions: { provider: 'integration-provider', model: 'integration-model' },
    meta: { cwd: process.cwd() },
    /**
     * @param {any} agentCtx
     * @param {any} agent
     */
    setup(agentCtx, agent) {
      observed.agentCtx = agentCtx
      // The deny path tool pruning will use: agent-scoped tool restriction.
      agentCtx.tools.restrict({ deny: ['fixture_drop'] })
      // The learned-notes injection path: dynamic, agent-scoped prompt section.
      agentCtx.systemPrompt.section({
        name: 'te:notes',
        order: 15_010,
        /** @param {any} context */
        text: (context) => `LEARNED-NOTES agent=${context?.scope?.id ?? context?.agent?.id ?? 'unknown'}`,
      })
      assert.equal(agent.id, 'integration-session-1')
    },
  }))
  try {
    // The global registry still knows the denied tool; the agent's view does not.
    const globalNames = ctx.tools.schemas().map((/** @type {any} */ schema) => schema.name)
    const scopedNames = ctx.tools.schemas(handle.agent).map((/** @type {any} */ schema) => schema.name)
    assert.ok(globalNames.includes('fixture_drop'), 'global registry keeps the denied tool')
    assert.ok(!scopedNames.includes('fixture_drop'), 'agent schemas exclude the denied tool')
    assert.ok(scopedNames.includes('fixture_keep'), 'agent schemas keep the allowed tool')

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'hello from the integration test' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    // 1. Dispatched fake-adapter request: tool declarations and assembled prompt.
    assert.ok(requests.length >= 1, 'the fake adapter received a request')
    const request = requests.at(-1)
    assert.deepEqual(request?.toolNames, ['fixture_keep'])
    assert.ok(request?.systemText.includes('TE-GLOBAL-SECTION'), 'global prompt section rendered')
    assert.ok(
      request?.systemText.includes('LEARNED-NOTES agent=integration-session-1'),
      'dynamic agent-scoped learned-notes section rendered with the agent scope',
    )

    // 2. Root-context hooks: agent/created and session/event were observed.
    assert.ok(observed.created.some((entry) => entry.id === 'integration-session-1'), 'agent/created observed')
    const eventTypes = observed.sessionEvents.map((event) => event.type)
    for (const expected of ['turn/start', 'request/header', 'assistant/message', 'turn/end']) {
      assert.ok(eventTypes.includes(expected), `session/event observed ${expected}; got ${eventTypes.join(',')}`)
    }

    // 3. The durable request/header event carries the exact dispatched tool set.
    const headerEvent = observed.sessionEvents.findLast((event) => event.type === 'request/header')
    assert.ok(headerEvent !== undefined, 'request/header event exists')
    const headerJson = JSON.stringify(headerEvent.data?.header?.tools ?? null)
    assert.ok(headerJson.includes('fixture_keep'), 'request/header lists the allowed tool')
    assert.ok(!headerJson.includes('fixture_drop'), 'request/header excludes the denied tool')
  } finally {
    await handle.dispose()
  }
})
