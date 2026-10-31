# Verification

This document separates what is proven offline from what needs a real model
account or an interactive terminal. It names the exact commands and the evidence
each layer produces. The plugin never claims a cost or savings number: the
verification is about behavior and recorded facts, not about an effect size.

## Recorded results for v0.1.0

| Command | Result (local, offline) |
| --- | --- |
| `npm ci` from the committed lockfile | installs 34 development packages, no runtime dependencies |
| `npm test` (unit) | **343 / 343 pass**, 0 fail, 0 skipped |
| `npm run test:integration` | **10 / 10 pass**, 0 fail, 0 skipped (~17 s) |
| `npm run typecheck` (`tsc` over JS + JSDoc) | **0 errors** |
| `npm run pack:check` | passes; `npm pack --dry-run` includes 47 files and nothing forbidden |
| `npm run pack:smoke` | packs the tarball, extracts it and runs the shipped `te` CLI + `status` + `reset --yes` in a plain Node process (no DSH profile, no devDependencies); plugin entry fails cleanly outside DSH because the schema peer is host-provided. If this check is run from inside a restricted DSH sandbox that forbids child processes with a working directory outside the workspace, run it from a normal terminal (on Windows, PowerShell); CI is unaffected. |
| Clean checkout | `git archive HEAD` ??extract to an empty directory ??`npm ci && npm run verify`: all of the above pass again, and no state directory is created inside the checkout. |
| Packed tarball install | `npm pack` ??`dsh plugin --profile te add ./dsh-tokeneconomizer-0.1.0.tgz` into an isolated `DSH_HOME`; `--dump-config` shows the row; a real `dsh` boot writes `plugin-load.json` before the (deliberately absent) model credential is requested |

Integration coverage (all against real DSH 0.2.1 packages, scripted model
adapter, no network):

| Test file | What it proves |
| --- | --- |
| `cli-process.test.js` | Native CLI install/composition and a real boot loading the plugin (load marker); skips cleanly when no DSH CLI is present. |
| `inprocess-fake-llm.test.js` | Host API seam: agent-scoped tool restriction removes a tool from the dispatched request and `request/header` while the global registry keeps it; a dynamic scoped prompt section renders. |
| `toolprune-deny-seam.test.js` | The ported evidence/deny policy drives the real `ctx.tools.restrict` API; protected tools survive; dispose restores. |
| `real-plugin-load.test.js` / `real-plugin-behavior.test.js` | The real plugin adapter: env-fact injection (and none when off), pruning + protected + restore + command surface, exactly one loop-guard redirect with no cancellation then a still-stuck notice, honest ledger record from provider usage, corrupt-state quarantine, and command output from seeded state. |
| `sidecall.test.js` | Optional model side-call route resolution, usage, timeout, abort, dispose, redaction (fake adapter, offline). |

## Environment used for the recorded results

| Item | Value |
| --- | --- |
| OS | Windows 11 (local verification) |
| Node.js | 24.19.0 (DSH runtime also ships Node 24.21.0) |
| DSH CLI | `@deepseek-ai/dsh` 0.2.1-rc.2 (`dsh --version`) |
| DSH desktop runtime packages | 0.2.1-rc.3 (extracted from `app.asar` for API truth) |
| Shell used for tests | Node `node:test`; no paid model calls |

## Layers

### 1. Unit tests (offline, deterministic)

Cover the ported mechanism cores: command observation and env-fact families,
fact lifecycle and contradiction retirement, tool evidence and pruning policy,
loop detection rules and the turn state machine, the envelope, cache-aware token
math, ledger records, storage/atomicity/corruption, configuration overrides,
redaction, and adapter normalization/accumulation.

```sh
npm ci
npm test          # node --test --test-isolation=none "test/unit/**/*.test.js"
```

### 2. Integration tests (offline, real DSH packages)

Two layers, no network and no model calls:

- **In-process**: a bare Cordis application mounts the real `dsh-system-prompt`,
  `dsh-tools`, `dsh-session`, `dsh-session-projection`, `dsh-llm`, `dsh-agent`
  and `dsh-agent-loop` packages plus a fake `LlmAdapter`. Tests drive real agent
  turns and assert:
  - an agent-scoped `ctx.tools.restrict({deny})` removes a tool from the
    dispatched request and from the durable `request/header`, while the global
    registry still exposes it and the restriction can be disposed;
  - an agent-scoped dynamic system-prompt section renders into the request;
  - the real plugin entry loads, sees `agent/created` and session events, seeds
    its project state, injects a learned note, applies a pruning deny list,
    redirects a repetitive turn at most once, and appends a ledger record;
  - a corrupted state file is quarantined and the session still completes.
- **Process**: the real `dsh` CLI is used with an isolated `DSH_HOME` under the
  repo (`.dsh-test-home/`, gitignored): initialize a headless-template profile,
  install this checkout with `dsh plugin add`, assert profile composition, boot
  a base-only profile and assert the plugin's load marker appears. This is the
  proof that the package is installable by DSH's native mechanism; it does not
  spend model tokens.

```sh
npm run test:integration
```

### 3. Real-model test (requires your account; not run in this build)

Not executed here because the build environment has no model credential for an
isolated `DSH_HOME` and paid calls are not part of the reproducible suite. Run it
yourself in a throwaway profile:

```sh
# 1. isolated test home and profile
export DSH_HOME="$PWD/.dsh-real-test"          # PowerShell: $env:DSH_HOME = "$PWD\.dsh-real-test"
node /path/to/your/dsh/lib/bin.js --profile te --from-default-profile headless --dump-config
node /path/to/your/dsh/lib/bin.js plugin --profile te add "$PWD"
# 2. configure your model route in that profile (the Web Models page writes the
#    credential; or export DEEPSEEK_API_KEY for this shell only)
# 3. run two short sessions in the same repository
node /path/to/your/dsh/lib/bin.js --profile te headless "run the existing test suite and report the command that worked"
node /path/to/your/dsh/lib/bin.js --profile te headless "run the existing test suite again"
# 4. inspect what the plugin recorded
node bin/te.js --cwd "$PWD" status
node bin/te.js --cwd "$PWD" usage
```

Pass criteria: the load marker and project state exist; the ledger records the
provider-reported token categories for each session; `status` shows folded
sessions; if facts were formed, the second session's system prompt contains the
delimited learned-notes block (inspect the session log under
`$DSH_HOME/sessions` for the `system/message` event, or add `TE_DIAGNOSTICS=redacted`
and check diagnostics for injection counts). Failure of the optional model
features must be limited to "no proposal/judge ran"; the deterministic mechanisms
and the session itself must be unaffected.

### 4. Interactive TUI test (manual; not run in this automation)

The slash-command surface only exists in interactive profiles. In a TUI session
in the test profile above:

```text
/tokeneconomizer status
/tokeneconomizer microskills
/tokeneconomizer toolprune
/tokeneconomizer usage
/tokeneconomizer config set toolprune=propose
```

Pass criteria: each command prints the documented sections from the same state
the CLI reads, without creating a model message; after `/tokeneconomizer
toolprune apply` the next session's request no longer contains the pruned tool
definitions (check `status` for the applied list and the next session's
`request/header` for tool names); `restore` brings them back and they are never
re-proposed.

## Acceptance-criterion mapping

| Criterion | Evidence |
| --- | --- |
| Knowledge forms from repeated evidence | Unit: lifecycle promotion/firing tests; integration: seeded env-fact renders into the first request. |
| Contradictions retire facts | Unit: lifecycle contradiction/retirement tests (deterministic layer); model-assisted facts retire after three non-matching sessions (unit + adapter test). |
| Cross-project isolation | Unit: independent state objects never share facts; state is keyed by hashed session `cwd`. |
| Pruning and restore | Unit: evidence/policy/denylist tests; integration: real `tools.restrict` removes a tool from the request, protected tools are never pruned, restore re-adds. |
| Loop judgement | Unit: rules/envelope/guard/state-machine tests ported from upstream; integration: exactly one redirect for a repeated failure and no turn cancellation. |
| Knowledge view / disable / delete / reset | Unit: `test/unit/commands.test.js` covers `microskills forget <id>`, `reset --yes` confirmation and mode validation; `test/unit/microskills/*` covers fact rendering and removal; integration drives `status`/`toolprune` through the real command registry. |
| Disable switches | Unit: config/env resolution; integration: `microskills=off`/`toolprune=off`/`loopguard=off` and `TE_DISABLE=1` leave behavior inert. |
| Error handling | Unit: store corruption/quarantine, diagnostics redaction; integration: corrupt state file, plugin still loads and session completes. |
| Plugin actually loads and events fire | Integration process test (load marker from a real `dsh` boot) + in-process test (hooks observe real `agent/created`/session events). |
| Features affect the model request/context | Integration: fake-adapter request tools and system prompt assertions at the wire boundary. |
| TUI and headless verified separately | Headless: process test; TUI: manual steps above (not executed in automation). |
| Usage recorded honestly | Unit: pricing/ledger/accounting tests; integration: ledger record from fake-adapter usage with `priced_by`; no price/savings fields. |

## Independent audit

An independent publish-readiness audit was run against a frozen snapshot of the
repository (the auditor did not write the adapter): installability, requirement
coverage, hygiene, adversarial cases, tarball install into a fresh isolated
`DSH_HOME`, load marker, and config-schema exposure. It found two CLI defects
(packed `te` CLI could not load its host-provided schema package; `reset --yes`
was rejected by the argument parser) plus documentation/packaging gaps; all were
fixed and re-verified by `npm run verify` and `npm run pack:smoke` in this
snapshot. Residual "not verified" items are the same ones listed below (real
model calls, CI execution, interactive TUI/Web, macOS/Linux local runs).

## What is not verified

- macOS/Linux interactive TUI flows (only Windows TUI was available locally; CI
  runs the offline suites on Linux).
- Web client slash-command rendering (the command registration path is shared
  with TUI and is integration-tested at the registry level, but the Web UI itself
  is not exercised).
- Real model quality/savings: no counterfactual experiment was run, and the
  plugin makes no savings claim.
- DSH versions other than the 0.2.x line (the declared `engines.dsh` range is
  enforced by DSH at install/composition time).
