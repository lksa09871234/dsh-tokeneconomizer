# dsh-tokeneconomizer v0.1.0 — first release

A DeepSeek Harness plugin that ports Microsoft TokenEconomizer's cross-session
cost-control mechanisms: micro-skills, tool pruning, failure-loop intervention,
and a usage ledger. Independent community port, Apache-2.0, not an official
Microsoft product.

## Highlights

- **Installable the DSH way** — an npm package with a `dsh.bundle.patch` row;
  install with `dsh plugin --profile <name> add <path-or-spec>`. No core edits,
  no Python, no extra runtime dependencies. Declared for DSH `^0.2.1-rc.2`
  (verified against CLI 0.2.1-rc.2 and desktop runtime 0.2.1-rc.3 packages) and
  Node 24+.
- **Micro-skills** — learns repeated environment failure→success patterns from
  earlier sessions in the same project, keeps facts behind a promotion/retraction
  lifecycle, and injects a capped, provenance-framed note as an agent-scoped
  system-prompt section. Optional model-assisted proposals are off by default and
  their tokens are recorded as plugin overhead.
- **Tool pruning** — counts unused tool definitions across sessions (`p=10`
  prompts over `m=2` sessions, or `s=5` sessions), proposes only by default, and
  when enabled hides the pruned definitions from the project's model requests via
  DSH's per-agent tool restriction. Restore and protected lists included;
  verification proves the definitions leave the request.
- **Loop guard** — detects repeated identical failures, edit churn and stagnation
  against a per-repository learned envelope. It redirects at most once per turn by
  default and never stops a turn. The optional judge is rate-limited and
  switchable; its tokens are recorded as overhead.
- **Usage ledger** — records the harness-reported token categories, prompt/turn/
  request counts and plugin overhead. No invented prices or savings; missing
  provider usage is labelled unknown.
- **Commands** — `/tokeneconomizer status|microskills [forget <id>]|toolprune|config|usage|diagnostics|reset`
  in interactive profiles and an equivalent `te` CLI for terminals that runs in
  plain Node from the packed package (no model call, no DSH process needed).
- **Privacy-by-design** — per-project state under `<DSH_HOME>/tokeneconomizer`
  only; no telemetry, no network calls of its own, redacted bounded diagnostics,
  learned text treated as untrusted data.

## Verification summary

- Unit suite for every ported mechanism (offline, deterministic).
- Offline integration suite mounting real DSH packages with a fake LLM adapter:
  proves the plugin loads, hooks receive real events, injected notes reach the
  prompt, pruned tools leave the dispatched request, redirects are bounded, and
  the ledger is written.
- Real `dsh` CLI process test with an isolated `DSH_HOME`: profile composition +
  native install + plugin load marker.
- JSDoc type check (`tsc --noEmit`) and packaging checks in CI alongside DSH
  0.2.1-rc.2 and rc.3 dev-package matrices.

Not run in the build environment: real-model end-to-end and interactive TUI
sessions (no paid credential / TTY in automation). Steps and pass criteria are in
`docs/VERIFICATION.md`.

## Install

```sh
git clone <this-repository> dsh-tokeneconomizer
dsh plugin --profile my-profile add "$PWD/dsh-tokeneconomizer"
dsh --profile my-profile
```

Use a test profile (`dsh --profile te --from-default-profile headless`) or an
isolated `DSH_HOME` if you want to try it without touching your daily setup. See
the README for settings, update, uninstall and troubleshooting.

## Known limitations

- Pruning applies at the next agent creation (explicit apply also updates the live
  agent's restriction, never an in-flight request).
- No plugin→user toast channel in DSH 0.2.1: the "still stuck" notice is recorded
  in state/logs while the model-facing redirect uses steering.
- Model-assisted micro-skills is a reduced, documented simplification of the
  upstream detector DSL.
- macOS/Linux interactive TUI flows untested locally; offline suites run on Linux
  CI.
- No cost/savings claims: tokens only, unknown data labelled unknown.

## Attribution

Port of [microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer)
at commit `e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9` (Apache-2.0, paper
arXiv:2610.22732). License and notices in `LICENSE`, `NOTICE`,
`THIRD_PARTY_NOTICES.md`, and `docs/UPSTREAM.md`.
