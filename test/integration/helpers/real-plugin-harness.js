/**
 * Harness for end-to-end, offline tests of the REAL dsh-tokeneconomizer adapter.
 *
 * Mounts the real DSH packages in a bare Cordis application (no profile, no
 * network) with a scripted fake LLM adapter, mounts the real plugin entry with
 * a temp `dataDir`, and provides small helpers to seed/read the project state
 * through the plugin's own modules (`lib/store.js`, `lib/project.js`,
 * `lib/microskills/stage.js`, `lib/toolprune/*`).
 *
 * @module dsh-tokeneconomizer/test/integration/helpers/real-plugin-harness
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Commands from '@deepseek-ai/dsh-commands'

import { normalizeProjectRoot, projectKey, projectStateDir, stateDirForConfig } from '../../../lib/project.js'
import { JsonStore } from '../../../lib/store.js'
import { waitForFileAsync } from './dsh-cli.js'

export const STATE_FILES = Object.freeze({
  project: 'project.json',
  microskills: 'microskills.json',
  toolprune: 'toolprune.json',
  envelope: 'envelope.json',
  ledger: 'ledger.jsonl',
  folded: 'folded.json',
})

/** @typedef {object} Harness
 * @property {Context} ctx
 * @property {string} dataDir
 * @property {string} projectRoot
 * @property {string} projectDir
 * @property {FakeAdapter} adapter
 * @property {any[]} requests
 * @property {any[]} sessionEvents
 * @property {(name: string, handler: Function) => any} registerTool
 * @property {(options?: object) => Promise<any>} createAgent
 * @property {(handle: any, text?: string) => Promise<void>} runTurn
 * @property {() => JsonStore} store
 * @property {(file: string) => any} readState
 * @property {(file: string, value: unknown) => void} writeState
 * @property {() => Promise<void>} dispose
 */

/**
 * @typedef {object} ScriptContext
 * @property {number} index 0-based request index.
 * @property {Harness} harness
 */

/**
 * A fake provider adapter. `script(scriptContext)` returns either a text reply
 * or a tool call; the script is evaluated once per request.
 */
export class FakeAdapter extends LlmAdapter {
  /**
   * @param {(scriptContext: ScriptContext) => {kind:'text', text:string} | {kind:'tool', name:string, args:Record<string,unknown>}} script
   */
  constructor(script) {
    super()
    this.script = script
    /** @type {Harness|null} */
    this.harness = null
  }

  /**
   * @param {any} options
   * @returns {AsyncGenerator<any>}
   */
  async *stream(options) {
    const harness = /** @type {Harness} */ (this.harness)
    const messages = options.messages ?? []
    const tools = options.tools ?? []
    /** @type {any[]} */
    const requests = harness.requests
    const index = requests.length
    const record = {
      provider: options.provider,
      model: options.model,
      toolNames: tools.map((/** @type {any} */ tool) => tool.name),
      tools,
      systemText: messages
        .filter((/** @type {any} */ message) => message.role === 'system')
        .flatMap((/** @type {any} */ message) => message.content ?? [])
        .filter((/** @type {any} */ block) => block.type === 'text')
        .map((/** @type {any} */ block) => block.text)
        .join('\n'),
      messages: messages.map((/** @type {any} */ message) => ({
        role: message.role,
        source: message.source?.kind ?? null,
        text: (message.content ?? [])
          .filter((/** @type {any} */ block) => block.type === 'text')
          .map((/** @type {any} */ block) => block.text)
          .join('|'),
      })),
    }
    requests.push(record)
    const decision = this.script({ index, harness })
    if (decision.kind === 'tool') {
      const callId = `call_${index}_${decision.name}`
      const args = JSON.stringify(decision.args ?? {})
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: decision.name, argumentsDelta: args }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: callId, name: decision.name, arguments: args },
      }
      yield {
        type: 'usage',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 5, totalTokens: 175 },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = decision.text
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield {
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 5, totalTokens: 175 },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * @param {string} name
 * @param {{ execute?: (args: Record<string, unknown>) => Promise<unknown>, description?: string }} [options]
 * @returns {any}
 */
export function makeTool(name, options = {}) {
  return defineTool({
    name,
    description: options.description ?? `integration fixture tool ${name}`,
    parameters: { path: { type: 'string', description: 'optional path' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      const value = options.execute ? await options.execute(/** @type {Record<string, unknown>} */ (args ?? {})) : `${name} ok`
      return String(value)
    },
  })
}

/**
 * Create an isolated temp project + data directory.
 * @returns {{ projectRoot: string, dataDir: string }}
 */
export function tempProject() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'te-real-plugin-'))
  const projectRoot = path.join(base, 'project')
  const dataDir = path.join(base, 'state')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  return { projectRoot, dataDir }
}

/**
 * Mount the real DSH application + the real plugin.
 *
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} options.dataDir
 * @param {Partial<import('../../../lib/config.js').TokenEconomizerConfig>} [options.config]
 * @param {(scriptContext: ScriptContext) => any} [options.script]
 * @param {(tools: any, ctx: Context) => void} [options.registerTools]
 * @returns {Promise<Harness>}
 */
export async function startHarness(options) {
  const { projectRoot, dataDir } = options
  const ctx = new Context()
  for (const plugin of [
    SystemPrompt,
    ToolRuntime,
    LlmRuntime,
    SessionStore,
    SessionProjectionRegistry,
    AgentRegistry,
    AgentLoop,
    Commands,
  ]) {
    await ctx.plugin(plugin)
  }

  const adapter = new FakeAdapter(options.script ?? (() => ({ kind: 'text', text: 'DONE' })))
  ctx.llm.registerAdapter(['integration-provider'], /** @type {any} */ (adapter))

  /** @type {any[]} */
  const requests = []
  /** @type {any[]} */
  const sessionEvents = []
  const registry = new ProjectRegistryView(dataDir, projectRoot)

  /** @type {Harness} */
  const harness = {
    ctx,
    dataDir,
    projectRoot,
    projectDir: registry.projectDir,
    adapter,
    requests,
    sessionEvents,
    registerTool: (/** @type {string} */ name, handler) => ctx.tools.register(/** @type {any} */ (handler ?? makeTool(name))),
    createAgent: async (agentOptions = {}) => {
      const opts = /** @type {any} */ (agentOptions)
      const handle = await ctx.agents.create(/** @type {any} */ ({
        sessionId: opts.sessionId ?? `session-${Date.now()}-${requests.length}`,
        agentOptions: { provider: 'integration-provider', model: 'integration-model' },
        meta: { cwd: projectRoot },
        setup: opts.setup,
      }))
      return handle
    },
    runTurn: async (handle, text = 'do the task') => {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
    },
    store: () => new JsonStore(registry.projectDir),
    readState: (file) => new JsonStore(registry.projectDir).readJson(file, null),
    writeState: (file, value) => {
      new JsonStore(registry.projectDir).writeJson(file, value)
    },
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(path.dirname(dataDir), { recursive: true, force: true })
    },
  }
  adapter.harness = harness
  if (options.registerTools) options.registerTools(ctx.tools, ctx)
  ctx.on('session/event', (_session, event) => {
    sessionEvents.push(event)
  })

  const plugin = await import('../../../lib/index.js')
  const config = {
    dataDir,
    microskills: 'off',
    toolprune: 'off',
    loopguard: 'on',
    loopguardJudge: false,
    ...options.config,
  }
  await ctx.plugin(plugin.default, /** @type {any} */ (config))
  // The plugin installs asynchronously (`void import('./dsh/install.js')`): wait
  // for its load marker so state seeding/agent creation races cannot happen.
  await waitForFileAsync(path.join(dataDir, 'plugin-load.json'), 20, 10_000)
  return harness
}

/**
 * Minimal project layout view shared by seeding/reading: computed from the same
 * production helpers the plugin uses.
 */
class ProjectRegistryView {
  /**
   * @param {string} dataDir
   * @param {string} projectRoot
   */
  constructor(dataDir, projectRoot) {
    this.dataDir = stateDirForConfig(dataDir)
    this.root = normalizeProjectRoot(projectRoot)
    this.key = projectKey(this.root)
    this.projectDir = projectStateDir(this.dataDir, this.root)
  }
}

/**
 * Read one JSONL file.
 * @param {string} dir
 * @param {string} name
 * @returns {any[]}
 */
export function readJsonl(dir, name) {
  try {
    return readFileSync(path.join(dir, name), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/**
 * Read the fake-adapter requests whose prompt contained a nudge delivered by the
 * plugin (user-role messages with `source.kind === 'tokeneconomizer'`).
 * @param {any[]} requests
 * @returns {any[]}
 */
export function steeringMessages(requests) {
  /** @type {any[]} */
  const out = []
  for (const request of requests) {
    for (const message of request.messages ?? []) {
      if (message.role === 'user' && message.source === 'tokeneconomizer') out.push(message)
    }
  }
  return out
}
