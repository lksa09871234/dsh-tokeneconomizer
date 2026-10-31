# dsh-tokeneconomizer

[English](README.md) | [简体中文](README.zh-CN.md)

DeepSeek Harness (DSH) plugin that ports [Microsoft
TokenEconomizer](https://github.com/microsoft/TokenEconomizer) to DSH: learn
reliable project knowledge from earlier sessions, prune tool definitions the
model never uses, notice repetitive failure loops, and record the token usage
the harness actually reports.

This is an independent open-source port, **not** an official Microsoft
product. See [Attribution and license](#attribution-and-license).

## Why

Coding agents re-learn the same repository facts, re-send the same unused tool
schemas, and repeat the same failing edits across sessions. TokenEconomizer
found that learning across a repository's sessions reduces cost without changing
the agent. This plugin brings the same four mechanisms to DSH:

| Mechanism | What it does here |
| --- | --- |
| **Micro-skills** | Learns durable project facts from repeated failure -> success patterns across sessions and injects a short, capped, clearly-marked note at session start. Optional model-assisted proposal is off by default. |
| **Tool pruning** | Counts prompts where a loaded tool was never used across sessions and proposes hiding it. Default is *propose only*; `toolprune: apply` removes the tool definitions from this project's model requests through DSH's own per-agent tool restriction. |
| **Loop guard** | Detects repeated identical failures, edit churn and no-progress turns. It never stops a turn; it injects at most a limited number of redirect messages and then only records/reports. Optional model judge is rate-limited and off if you disable it. |
| **Usage ledger** | Records the harness-reported token categories (uncached input, cache read, cache write, output) and the plugin's own model-call overhead. It never invents prices, currency, or savings percentages. |

## Feature status

Legend: **tested** = covered by passing offline unit tests; **verified**
= exercised end-to-end through real DSH code paths in the offline integration
harness (`test/integration/`, real DSH packages, fake model adapter, no paid
calls); **manual/real-model** = needs a real DSH session with your model
account, steps documented in [docs/VERIFICATION.md](docs/VERIFICATION.md).

| Feature | State | Notes |
| --- | --- | --- |
| Plugin loads in a real DSH profile | verified | Tarball/link install with `dsh plugin add` into an isolated `DSH_HOME`; composition asserted and a real `dsh` boot writes the plugin's load marker. |
| Micro-skills: env-fact families + lifecycle | tested | Upstream thresholds ported; contradictions retire facts; cross-project state is keyed by session `cwd`. |
| Micro-skills: injection into the model context | verified | Injected as an agent-scoped system-prompt section; the integration test reads the first fake request's system prompt and finds the delimited note. |
| Micro-skills: model-assisted proposal | verified (plumbing), real model | Off by default; the digest/prompt/admission path is unit-tested with a fake side call, and its usage is recorded as plugin overhead. Needs a real model account to judge proposal quality. |
| Tool pruning: evidence + proposal | tested | p=10 unused prompts over at least 2 sessions, or at least 5 sessions regardless of length; no proposal on insufficient evidence. |
| Tool pruning: applying | verified | Deny list applied as an agent-scoped `ctx.tools.restrict`; the integration test proves the tool is gone from the dispatched request and from the durable `request/header` while the global registry keeps it. |
| Tool pruning: restore / protected list | verified | Restored tools are never re-proposed; protected tools are never denied. |
| Loop guard: detection rules + envelope | tested | Same thresholds, presets and decision order as upstream; ported upstream test cases pass. |
| Loop guard: mid-turn redirect delivery | verified | Integration test scripts a repetitive failing turn: exactly one steering message, then a still-stuck notice, and the turn completes (never cancelled). |
| Loop guard: user-visible "still stuck" notice | manual/real-model | DSH exposes no plugin -> user toast in the headless path; the notice is recorded and logged. See limitations. |
| Usage ledger: actual tokens | verified | Integration test asserts the ledger record's token categories equal the fake provider's usage; missing data stays unknown. |
| Usage ledger: plugin overhead | verified | Recorded for optional model calls; zero when those features are off. |
| Commands (slash command + `te` CLI) | verified (registry + CLI), TUI/Web | Integration test executes `/tokeneconomizer status` and `restore` through the real command registry; the `te` CLI is exercised from the packed npm tarball by `npm run pack:smoke`. Interactive TUI rendering and the Web command UI are manual/unverified. |
| Windows / macOS / Linux | partial | Local verification: Windows 11, Node 24. Paths are `node:path` based; POSIX is untested locally (CI runs the offline suite on Linux). |

Offline evidence for this release: **343 unit tests** and **10 integration
tests** pass, JSDoc type checking is clean, packaging checks and a packed-tarball
CLI smoke test pass (`npm run verify`); the integration suite mounts the real DSH
0.2.1 packages and drives real agent turns with a scripted model adapter, so no
model credential is needed. See [docs/VERIFICATION.md](docs/VERIFICATION.md).

Only the verification described above is claimed. See
[Known limitations](#known-limitations).

## Prerequisites

- **DSH** `0.2.1-rc.2` or later within the `0.2.x` line (declared through
  `engines.dsh`). Locally verified against the DSH CLI `0.2.1-rc.2` and the
  desktop runtime `0.2.1-rc.3` package sources.
- **Node.js 24+** (the DSH runtime ships Node 24; this plugin uses ESM and
  `node:test`).
- **No Python required.** The upstream Python plugin is not executed; its
  mechanisms are reimplemented in JavaScript in this repository.
- No API key of its own: optional model calls use the session's existing DSH
  model route and account, so they appear in your normal usage.
- No separate network service or telemetry. Optional learning and judge calls
  use the current DSH model route and may consume model quota.

## Install

The plugin follows DSH's native plugin mechanism: a package with a
`dsh.bundle.patch` entry that inserts one Cordis row into a profile. Install it
into a profile (use a test profile first if you want to keep your daily profile
untouched):

```sh
# from a local checkout
git clone https://github.com/lksa09871234/dsh-tokeneconomizer.git
dsh plugin --profile my-profile add "$PWD/dsh-tokeneconomizer"

# or, once published to npm
dsh plugin --profile my-profile add dsh-tokeneconomizer
```

`dsh plugin add` forwards to `pnpm` inside the profile and records the plugin in
`<DSH_HOME>/profiles/<profile>/package.json` under `dsh.profile.bundles`. Start
the profile normally:

```sh
dsh --profile my-profile            # TUI
dsh --profile headless "run the tests"
```

To keep an experiment isolated, point `DSH_HOME` at a scratch directory:

```sh
# Linux/macOS
export DSH_HOME="$PWD/.dsh-test-home"
# Windows PowerShell
$env:DSH_HOME = "$PWD\.dsh-test-home"
dsh --profile te --from-default-profile headless --dump-config
```

## Quick start

1. Work as usual for a few sessions in the same repository. Nothing is injected
   until there is repeated evidence.
2. Ask what was learned:

   ```text
   /tokeneconomizer status
   /tokeneconomizer microskills
   /tokeneconomizer microskills forget <fact-id>   # delete one learned fact
   /tokeneconomizer toolprune
   /tokeneconomizer usage
   ```

3. Turn mechanisms on or off per project (repo-level config):

   ```text
   /tokeneconomizer config set microskills=envfacts
   /tokeneconomizer config set toolprune=propose      # default
   /tokeneconomizer config set loopguard=on           # default
   ```

4. Apply proposed tool pruning deliberately:

   ```text
   /tokeneconomizer toolprune apply
   ```

   The next session for that project omits the pruned tool definitions from the
   model request. Give them back at any time with
   `/tokeneconomizer toolprune restore`; restored tools are never proposed again.

From a terminal (no model turn), the same operations are available through the
bundled CLI:

```sh
node bin/te.js status
node bin/te.js toolprune
node bin/te.js microskills
node bin/te.js usage
```

## Settings

Settings live in the plugin's own state (per project), not in your project's
files. The profile patch can set global defaults; `/tokeneconomizer config set`
changes the current project; `TE_*` environment variables override both for one
process.

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Whole-plugin switch (also `TE_DISABLE=1`). |
| `dataDir` | `""` | State directory; empty means `<DSH_HOME>/tokeneconomizer`. |
| `microskills` | `off` | `off`, `envfacts` (deterministic only), or `on` (adds the optional model proposer). |
| `toolprune` | `propose` | `off`, `propose`, or `apply`. |
| `loopguard` | `on` | `off` or `on` (redirects only, never stops). |
| `microskillsProposeEvery` | `3` | Sessions between model-proposer runs (upstream *k*). |
| `microskillsMaxChars` | `600` | Hard character cap for the injected note. |
| `microskillsMaxFacts` | `4` | Maximum facts injected. |
| `toolpruneEvidence` | `10` | Unused prompts before proposing a tool (upstream *p*). |
| `toolpruneMinSessions` | `2` | Sessions those prompts must span (upstream *m*). |
| `toolpruneSessions` | `5` | Sessions that alone count as evidence (upstream *s*). |
| `toolpruneQuietMinutes` | `60` | Idle minutes before an applied deny list changes. |
| `protectedTools` | `[]` | Extra tools that are never pruned. |
| `loopguardEnvelopeMinSamples` | `5` | Well-behaved turns before the guard acts (upstream *e*). |
| `loopguardJudgeConfidence` | `0.7` | Optional judge confidence cutoff (upstream *c*). |
| `loopguardNudges` | `1` | Redirects per turn (upstream *r*). |
| `loopguardBackstopMultiplier` | `2.5` | Judge-free backstop multiple (upstream *b*). |
| `loopguardJudge` | `true` | Allow the optional model judge. |
| `usageRecord` | `true` | Record actual usage the harness reports. |
| `diagnosticsRecord` | `true` | Write redacted diagnostics instead of throwing. |

Environment overrides include
`TE_MICROSKILLS=on`, `TE_TOOLPRUNE=apply`, `TE_LOOPGUARD=off`,
`TE_DISABLE=1`.
Multi-word settings use explicit underscored names, such as
`TE_MICROSKILLS_PROPOSE_EVERY`; see `lib/config.js` for the full mapping.

## Update

```sh
dsh plugin --profile my-profile add /absolute/path/to/dsh-tokeneconomizer
```

(A local-path install is a pnpm link, so pulling the repository is enough; an
npm install follows the new version.) Restart the profile to load the new code.

## Uninstall

```sh
dsh plugin --profile my-profile remove dsh-tokeneconomizer
```

Remove the plugin's state only if you want to forget what it learned:

```sh
node bin/te.js --cwd /absolute/path/to/project reset --yes
# or delete <DSH_HOME>/tokeneconomizer for every project
```

Uninstalling never edits your project files: the plugin only writes into its
state directory (and optionally the profile's `package.json`, which
`dsh plugin remove` owns).

## Known limitations

- **Tool pruning acts at agent creation.** A session that is already running is
  not re-composed mid-turn; the change applies to the next agent/session in that
  project. Explicit `/tokeneconomizer toolprune apply` re-registers the
  restriction for the live agent but never rewrites an in-flight request. This is
  deliberate: DSH caches prompt/tool prefixes.
- **Pruned tools are hidden, not denied.** DSH's restriction removes the
  declarations from the model request; your permissions and approval policy are
  unchanged, and the tool can still be called by name if some other party emits
  a call (the harness answers `UNKNOWN_TOOL` when the definition is hidden).
- **User-visible "still stuck" notice**: DSH does not expose a plugin -> user
  notification channel to this plugin in headless or command-less sessions. The
  guard records the notice in state and logs it; the model-facing redirect uses
  DSH steering. See [docs/VERIFICATION.md](docs/VERIFICATION.md) for the exact
  test and the manual step to observe it in the TUI.
- **Model-assisted learning is a documented simplification.** With
  `microskills: on`, a digest-only model proposer runs every *k* folded sessions
  and accepts a claim only when its checks are supported by at least two of the
  sessions it cites. Accepted notes are injected inside a separate, clearly
  marked block and retire after three consecutive sessions without a matching
  check. Upstream's full extractor DSL and its per-task detector replay are not
  ported; the deterministic `envfacts` layer is the faithful part.
- **Usage is tokens, not money.** The plugin records the token categories DSH
  reports. It does not embed vendor prices, so it cannot and does not claim a
  cost or a savings percentage. Missing provider usage is shown as unknown.
- **Micro-skills is opt-in.** Deterministic `envfacts` learning is cheap but
  only helps repositories with repeated environment failures; it is off by
  default like upstream.
- **Loop guard cold start.** It never intervenes until it has observed the
  configured number of well-behaved turns in that project, so a fresh project
  is never interrupted.
- **Windows/macOS/Linux**: logic is platform-neutral and uses `node:path`; the
  interactive TUI flows have not been verified on any platform. CI covers the offline
  test suite on Linux.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)  - modules and data flow.
- [docs/PORTING.md](docs/PORTING.md)  - what was ported, what was rewritten, and
  the upstream -> DSH mapping.
- [docs/VERIFICATION.md](docs/VERIFICATION.md)  - how each claim was verified,
  commands to reproduce, and what still needs a real model account.
- [docs/MEASUREMENT.md](docs/MEASUREMENT.md)  - how to run a fair before/after
  comparison of usage and completion quality without fabricated savings claims.
- [docs/UPSTREAM.md](docs/UPSTREAM.md)  - upstream-derived specification (copied
  from the porting research, kept for attribution and maintainers).
- [SECURITY.md](SECURITY.md)  - data handling and vulnerability reporting.
- [CONTRIBUTING.md](CONTRIBUTING.md)  - development, tests, packaging.
- [CHANGELOG.md](CHANGELOG.md)  - release notes.

## Attribution and license

This project is a derivative work of
[TokenEconomizer](https://github.com/microsoft/TokenEconomizer) at commit
`e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9` (Apache-2.0, paper
[arXiv:2610.22732](https://arxiv.org/abs/2610.22732)). The mechanisms are
reimplemented in JavaScript for DSH; the DSH adapter layer is new. The upstream
license and the required notices are reproduced in
[LICENSE](LICENSE), [NOTICE](NOTICE), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This project is not an
official Microsoft product and is not affiliated with or endorsed by Microsoft.

This project is licensed under the Apache License 2.0.

## Publishing (maintainers)

1. Run `npm ci` and `npm run verify` from a clean checkout.
2. Push `main` to https://github.com/lksa09871234/dsh-tokeneconomizer and wait for
   all GitHub Actions jobs to pass.
3. Create an annotated `v0.1.0` tag at the verified commit, then create a GitHub
   Release using `RELEASE_NOTES-v0.1.0.md` as the body.
4. Attach the tarball produced by `npm pack`; do not zip the working tree,
   which can contain ignored dependencies and local test state.
5. npm publication is a separate optional step. Run `npm run pack:smoke` before
   `npm publish --access public` from the tag.

Real-model quality, savings and interactive TUI behavior still require the
manual checks in `docs/VERIFICATION.md`. Do not infer them from offline CI.
