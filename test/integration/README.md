# Offline DSH integration harness

Two layers of integration coverage for `dsh-tokeneconomizer`, both offline (no
network, no paid model call):

| File | Layer | What it proves |
|---|---|---|
| `cli-process.test.js` | **process** (real `dsh` CLI) | an isolated `DSH_HOME` profile initialises from the `headless` template; this repo installs as a local-path plugin (`link:` dep + bundle entry + composed `tokeneconomizer` row); a base-only profile that mounts the plugin boots for real and the plugin's `apply()` writes its load marker |
| `inprocess-fake-llm.test.js` | **in-process** (real DSH packages + fake LLM) | `tools.restrict({ deny })` removes a tool from the dispatched request and durable `request/header` while the global registry keeps it; a dynamic agent-scoped `systemPrompt.section` renders into the real turn's system prompt; root hooks see `agent/created` and `session/event` |
| `toolprune-deny-seam.test.js` | **in-process seam** | the pure `lib/toolprune/*` state drives a real agent-scoped DSH deny list and restores on dispose |
| `real-plugin-load.test.js` | **in-process plugin** | the actual plugin entry mounts under Cordis and writes `<DSH_HOME>/tokeneconomizer/plugin-load.json` with the effective config |
| `real-plugin-behavior.test.js` | **end-to-end real adapter** | the real adapter learns/injects/prunes/guards/accounts through real DSH events: env-fact injection, `toolprune=apply` deny + protected + command restore, loop-guard one redirect/never cancel, ledger record, corrupt-state quarantine, command `status`/`toolprune` output |

Fixtures:

- `test/fixtures/driver-plugin/` ??test-only DSH plugin used by the process test:
  it waits (bounded) for the tokeneconomizer load marker, writes
  an OS-temp `DSH_HOME/driver-result.json`, and exits the booted DSH process.

Helpers:

- `test/integration/helpers/dsh-cli.js` ??discovers the DSH CLI
  (`DSH_CLI` ??known local install ??repo `node_modules`), creates the isolated
  `DSH_HOME` in the operating-system temp directory (never inside the repo), runs the CLI with child stdio
  redirected to files (piped spawn can be EPERM-denied under the DSH sandbox),
  and waits for files.
- `test/integration/helpers/toolprune-seam.js` ??the toolprune-core ??real
  `tools.restrict` bridge the adapter will use.

## Plugin-spec acceptance criteria ??tests

| Criterion | Test |
|---|---|
| plugin loads in a real host and records its load marker | `real-plugin-load.test.js`; process layer in `cli-process.test.js` |
| adapter observes `agent/created` and session events, persists project record | `real-plugin-behavior.test.js` "promoted env fact" (project.json), events collected in every harness test |
| learned env facts are injected at the next session start, framed as untrusted data | "end-to-end: a promoted env fact is injected into the first model request" (block + provenance note present; absent when `microskills: 'off'`) |
| tool pruning hides applied tools from model requests; protected tools survive | "end-to-end: applied deny list hides a tool, protected tools survive, restore gives it back" (scoped schemas, dispatched `options.tools`, durable `request/header.tools`) |
| `toolprune apply` writes only its own deny list; restore gives tools back | same test (state `applied`/`kept` after the command) |
| command surface `status` and `toolprune` read seeded state | same test (`ctx.commands.execute` ??JSON view + rendered text) |
| loop guard redirects at most `r` times, then only notifies; never stops a turn | "end-to-end: the loop guard steers once on repeated failures and never cancels" (unique steering messages, `turn/end` completed, ledger `nudges=1`) |
| usage ledger records real token categories, labels unknown pricing, invents no savings | "end-to-end: the ledger records real usage with labelled pricing and no invented savings" |
| corrupt state is quarantined; a plugin failure never breaks the session | "end-to-end: corrupt state documents are quarantined and the session still completes" |
| fake-LLM harness proves the host API surface (`tools.restrict`, dynamic prompt sections, `request/header`, events) | `inprocess-fake-llm.test.js`, `toolprune-deny-seam.test.js` |

## Commands

```sh
npm run test:integration          # both layers; skips the CLI layer when no DSH CLI is found
node --test --test-isolation=none "test/integration/*.test.js"
node --test --test-isolation=none "test/integration/inprocess-fake-llm.test.js"
```

CLI discovery: set `DSH_CLI` to an `@deepseek-ai/dsh/lib/bin.js` path (and
optionally `DSH_NODE`) to use a specific installation; otherwise the known local
RC2 install `D:/Apps/dsh-TUI/...` is used, then the repo's own `node_modules`.
When no CLI is usable the process test **skips with a clear message** rather
than failing CI.

## Known limitations

- The process boot uses a **base-only** profile plus a driver fixture, so the
  boot does not start an interactive app runner (that would need a model/TTY).
  This is the same verified recipe as the research smoke tests.
- Process assertions read the plugin's own **load marker**; they do not yet
  assert that the real adapter's mechanism hooks ran (that is the `todo` seam in
  `real-plugin-load.test.js`, owned by the Lead once `lib/dsh/mechanisms.js` is
  wired). The fixture-plugin tests prove every host API the adapter needs.
- The in-process layer imports real `@deepseek-ai/*` packages from this repo's
  devDependencies, so `npm install` must have run; the unit test suite needs no
  such packages.
- `npm run test:integration` takes ~15??0 s here (most of it `pnpm` linking the
  local-path plugin during install).
