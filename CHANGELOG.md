# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is `0.x`, the minor version may include behavior changes; the
`0.1.x` line targets DSH `0.2.x` and keeps the state schema (`schemaVersion: 1`)
backwards compatible within the line.

## [Unreleased]

### Added

- Nothing yet.

### Changed

- Nothing yet.

## [0.1.0] - 2026-10-31

First public release. A DeepSeek Harness plugin port of
[Microsoft TokenEconomizer](https://github.com/microsoft/TokenEconomizer)
(commit `e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9`, Apache-2.0).

### Added

- **Native DSH plugin packaging**: `package.json` with `dsh.bundle.patch`,
  `cordis.patch.yml` row, `dsh.manifestVersion: 1`, `engines.dsh ^0.2.1-rc.2`,
  optional peer dependencies, and no install-time runtime dependencies.
- **Micro-skills (deterministic)**: ported command observation, five env-fact
  families, fact lifecycle (promotion, contradiction retirement, firing gates),
  provenance-framed injection as an agent-scoped system-prompt section, hard
  caps on facts/characters, and environment override off.
- **Micro-skills (optional model-assisted layer)**: off by default; when
  `microskills=on`, a digest-only model proposer runs at most every *k* sessions
  and accepts only claims whose checks are supported by the sessions they cite.
  Its tokens are recorded as plugin overhead. `TE_MICROSKILLS=off|envfacts|on`.
- **Tool pruning**: evidence model (`p=10` unused prompts across `m=2` sessions or
  `s=5` sessions), high-risk factor 3, proposal-only default, quiet period
  (`q=60` min, 24 h cap), protected and given-back lists, and apply through
  DSH's own per-agent `ctx.tools.restrict` so pruned definitions really leave
  the model request (verified at the `request/header` level).
- **Loop guard**: ported detection rules (repeated failures, edit churn,
  stagnation, error growth), per-repository learned envelope, judge gating and
  rate limiting, `r=1` redirect per turn, judge-free backstop, and the invariant
  that the plugin never cancels a turn. Optional model judge is rate-limited and
  switchable; its tokens are recorded as overhead.
- **Usage ledger**: records the harness-reported token categories (uncached
  input, cache read, cache write, output), prompt/turn/request counts, plugin
  overhead, and priced-by labels. No prices, currency, or savings are invented;
  missing provider usage is recorded as `no_usage` (unknown, not zero).
- **Command surface**: `/tokeneconomizer` slash command in interactive profiles
  and a `te` CLI for terminals that needs no model call and no DSH process
  (it runs in plain Node from the packed package). Commands:
  `status`, `microskills`, `microskills forget <id>`, `toolprune [show|apply|restore|refresh-catalog]`,
  `config [show|set|unset]`, `usage`, `diagnostics`, `reset --yes`, `help`.
- **Packaged-artifact smoke test**: `npm run pack:smoke` packs the plugin,
  extracts the tarball and runs the shipped CLI from it in a plain Node process,
  so a missing optional peer cannot silently break the published package.
- **State**: per-project state under `<DSH_HOME>/tokeneconomizer` (configurable),
  project keys derived from a hash of the session's `cwd`, atomic JSON writes,
  JSONL rotation, lock files, corruption quarantine, and redacted bounded
  diagnostics. State is never written into the user's project.
- **Verification**: unit tests for every ported mechanism (343 tests), an
  offline integration harness that mounts real DSH packages with a fake LLM
  adapter (10 tests, no paid model calls), a real-profile load test against an
  isolated `DSH_HOME`, packed-tarball install and CLI smoke tests, packaging
  checks, JSDoc type checking, and CI (rc.2 + rc.3 dev packages).

### Known limitations

- Tool pruning applies to the next agent creation in the project (or immediately
  to the live agent when explicitly applied from a command); a running model
  request is never rewritten mid-flight.
- DSH 0.2.1 exposes no plugin?’user toast/notification channel; the loop guard's
  "still stuck" notice is recorded in state and the log, while the model-facing
  redirect uses DSH steering. Headless profiles have no slash-command surface.
- The model-assisted micro-skills layer is a documented simplification of the
  upstream detector DSL: proposals are verified against cited sessions at
  admission and retire after repeated non-matches, but do not use upstream's
  full extractor set.
- Windows interactive TUI flows were verified manually; macOS and Linux TUI flows
  are untested locally (CI covers the offline suites on Linux).
- No real-model end-to-end test was run in this build environment; steps are
  documented in `docs/VERIFICATION.md`.
