# Port notes: optional LLM side calls

Status: implemented (`lib/dsh/sidecall.js`), offline tests green
(`test/unit/dsh/sidecall.test.js`, 15/15). Contract reference:
`research/DSH-API.md` §7 (plugin-initiated LLM calls) and §11 (offline
verification), plus the shipped reference implementation
`@deepseek-ai/dsh-session-title-llm` `executeSessionTitleLlm()`.

The upstream TokenEconomizer calls a model from two optional features — the
micro-skills environment-fact proposer (upstream `plugin/proposer.py`) and the
tool-pruning judge — outside any agent turn. DSH has no separate "side model"
API, but `ctx.llm` is the provider-neutral call service and first-party plugins
(session titles, compaction) already use it outside the loop. This module is the
plugin's only path to those calls; no mechanism core imports it.

## Exported API

```js
import { createSideCall } from './lib/dsh/sidecall.js'

const sidecall = createSideCall(ctx, {
  timeoutMs: 60_000,        // optional; default DEFAULT_TIMEOUT_MS (60 s), 0 disables
  purpose: 'tokeneconomizer', // optional; default DEFAULT_PURPOSE
  maxOutputTokens: 1_024,   // optional; default DEFAULT_MAX_OUTPUT_TOKENS
  loadModule,               // optional test seam; default dynamic import('@deepseek-ai/dsh-llm')
})

const result = await sidecall.call({
  prompt,                   // required non-empty string
  system,                   // optional system instruction (omitted when empty)
  maxTokens,                // optional per-call output cap (overrides maxOutputTokens)
  provider, model,          // optional explicit route; both or neither
  sessionId,                // optional; defaults to agent.session.id
  agent,                    // optional live Agent used to read the logged route
  signal,                   // optional AbortSignal (turn/session cancellation)
})
// result:
// { ok: true, text, usage: { inputTokens, outputTokens, cacheReadTokens,
//   cacheWriteTokens, totalTokens }, finish: 'stop'|'max-tokens'|'tool-calls',
//   provider, model }
// or
// { ok: false, code, error }   // error is redacted, single line
```

Additional exports: `SIDE_CALL_CODES` (stable failure codes),
`DEFAULT_TIMEOUT_MS`, `DEFAULT_MAX_OUTPUT_TOKENS`, `DEFAULT_PURPOSE`,
`SIDE_CALL_SOURCE_KIND`, `normalizeSideCallUsage(usage)`.

Returned adapter members: `call(request)`, `dispose()`, `disposed`,
`activeCalls`, `stats` (`calls/ok/failures/timeouts/aborts/disposed`) for
diagnostics and tests.

### Failure codes

| `code` | Meaning |
|---|---|
| `invalid-prompt` | `prompt` missing/blank (no I/O attempted). |
| `llm-unavailable` | `ctx.llm` is not mounted (`ctx.get('llm')` undefined). |
| `module-unavailable` | `@deepseek-ai/dsh-llm` could not be imported. Cached: the adapter stays inert and every later call returns the same redacted reason without retrying. |
| `no-route` | No explicit provider/model and the agent's session has no logged `request/header` config or `request/context`. |
| `timeout` | Hard timeout fired (the stream is abandoned and the iterator `return()` requested). |
| `aborted` | Caller `signal` aborted, or the adapter was disposed mid-flight. |
| `finish-error` | Provider terminal `finish` kind `error`/`aborted` (includes adapter throws normalized by `@deepseek-ai/dsh-llm`). |
| `disposed` | `call()` after `dispose()`; no I/O attempted. |
| `error` | Any other contained failure. |

## Behavior

- **Route resolution order**: explicit `provider`+`model` → `agent.session.requestHeader()?.config`
  → `agent.session.requestContext()`. Both members of the pair must be non-empty
  strings. Throwing session accessors are contained and fall through; with no
  route the call returns `no-route` and performs no provider work.
- **Route/purpose tagging**: the request is dispatched through
  `ctx.llm.prepareCall({provider, model, maxTokens}, signal)` then
  `prepared.stream({...prepared.config, messages, system?, sessionId?, purpose, signal})`
  with `purpose: 'tokeneconomizer'` (configurable). This is the attribution
  surface DSH provides; there is no separate cost/billing API.
- **Performance**: the side call is a real billable provider request, so callers
  must treat it as optional and record its `usage` in the plugin ledger as
  overhead. It never creates an agent turn or appends to session history.
- **Hard timeout**: one fused `AbortController` is aborted by a per-call timer
  (default 60 s) and by the caller's signal. The provider iterator is raced
  against that signal, so an adapter that ignores cancellation still cannot keep
  the caller waiting past the deadline. The timer and external abort listener
  are removed in `finally`; the provider iterator's `return()` is requested
  best-effort and never awaited (a non-cooperative adapter is abandoned).
- **Never throws**: every path is contained; `call()` resolves with
  `{ok:false, code, error}`. Error text goes through the plugin's
  `redactText()` (secrets, bearer tokens, e-mails, personal paths) and is capped.
- **No secrets**: this module never logs and never returns prompt/system text.
  Prompt construction and any persistence of prompt material are the caller's
  job; callers must not put credentials in prompts.
- **Lazy hosting**: nothing is imported from `@deepseek-ai/dsh-llm` until the
  first call (a JSDoc type-only import is used at the top). If the module cannot
  be resolved, the failure is cached once and the adapter stays inert.
- **Lifecycle**: `createSideCall` registers `ctx.effect(() => () => dispose())`
  so plugin unload aborts in-flight calls. `dispose()` is idempotent, aborts all
  active controllers, and makes subsequent calls return `disposed`.
- **No network of its own**: only `ctx.llm` is used; the module has no fetch, no
  fs, and no timers beyond the per-call deadline timer.

## Caller integration recipe

For an optional feature (proposer/judge), in the DSH adapter layer only:

```js
const sidecall = createSideCall(ctx, {
  purpose: 'tokeneconomizer',
  timeoutMs: config.sideCallTimeoutMs,
  maxOutputTokens: config.sideCallMaxOutputTokens,
})

// inside a session-scoped callback; never awaited on the agent/wake path
const result = await sidecall.call({
  prompt: buildProposerPrompt(evidence),   // caller-owned; no secrets
  system: PROPOSER_SYSTEM,                 // caller-owned
  agent,                                   // route from the live session
  signal: sessionSignal,                   // abort when the session is cancelled
})
if (result.ok) recordOverheadUsage(project, sessionId, result.usage)
else recordDiagnostic('sidecall', result.code, result.error)
```

Rules:

- Record `result.usage` as ledger overhead (`inputTokens/outputTokens/
  cacheReadTokens/cacheWriteTokens/totalTokens`) whenever `ok` is true.
- Never make agent-facing latency or turn completion depend on the side call;
  run it after the fact (e.g. on session dispose/turn end) or off the critical
  path, with the hard timeout as the only bound.
- Never treat `ok:false` as fatal; the plugin's mechanisms must degrade to their
  non-model path.

## Tests

```sh
node --test --test-isolation=none "test/unit/dsh/sidecall.test.js"
# 15 tests: 15 pass, 0 fail
```

They mount the real `@deepseek-ai/cordis` + `@deepseek-ai/dsh-llm` packages from
the repo devDependencies and register a fake in-process `LlmAdapter`, so the
entire `prepareCall → stream → BlockAssembler` path runs without a network or a
paid model. Covered:

1. successful call returns text, provider usage (with `totalTokens` summed when
   the provider omits it), finish kind, resolved provider/model;
2. documented defaults (`timeoutMs`, `maxOutputTokens`, `purpose`, source kind);
3. route from `requestHeader().config` with `sessionId` forwarded;
4. route fallback to `requestContext()`;
5. explicit route precedence over the agent route;
6. missing route returns `no-route`, no dispatch;
7. throwing session accessors contained; blank/null prompt → `invalid-prompt`;
8. context without `ctx.llm` → `llm-unavailable`, no throw;
9. unresolvable `dsh-llm` fails once (cached, one import attempt) and stays inert;
10. hard timeout aborts a non-cooperative adapter (returns `timeout`, no leak);
11. caller abort → `aborted`;
12. `dispose()` aborts in-flight calls and later calls → `disposed`;
13. provider `finish` kinds `error`/`aborted` → `finish-error`;
14. adapter throws normalized by dsh-llm → redacted `finish-error` (no secret
    material in the returned error);
15. usage normalization/invalid-value clamping.

The test runner exits normally (deadline timer and abort listeners are cleared),
which is the practical no-timer/no-abort-leak assertion.

## Limitations and UNKNOWN

- **No retry policy of its own**: one provider attempt per call;
  `@deepseek-ai/dsh-llm` does not retry (`dsh-llm-retry` is loop-step oriented).
  A caller that wants retries must add them (with its own bound), or rely on the
  next optional-feature run.
- **No cost/billing attribution**: DSH exposes only request `purpose` /
  `sessionId` tags and provider `usage`; currency cost is out of scope.
- **Text-only result**: the module joins `text` blocks; tool-call/other blocks
  are ignored (the `finish` kind still reports `tool-calls`). Side calls should
  not be given tools.
- **Not reconstructable from the session log**: unlike loop requests, a side
  call is not written to the session. The caller may persist its own record
  (the shipped title provider logs `session/title-llm-request`); this module
  deliberately does not touch the session so it stays usable from timers and
  session-dispose paths.
- **Best-effort cancellation of uncooperative adapters**: the caller returns on
  time, but the abandoned provider generator is only asked to clean up; a buggy
  adapter may keep a background promise alive. Hard timeout still bounds the
  caller.
- **`loadModule`** exists for tests/advanced embedding; production code must not
  pass it.
- **Typecheck**: `lib/dsh/sidecall.js` and the new test are clean, but
  `npm run typecheck` currently fails on pre-existing files outside this task's
  write scope (`lib/report.js`, `lib/usage/accounting.js`,
  `lib/loopguard/envelope.js`, `scripts/pack-check.mjs`, several older tests).
  Run with `npm run typecheck`; none of the reported errors mention `sidecall`.
