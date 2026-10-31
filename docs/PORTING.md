# Porting notes: upstream TokenEconomizer → DSH

Upstream studied at commit `e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9`
(2026-10-30) under the Apache License 2.0. The full implementation-grade
specification produced from that source is kept in
[docs/UPSTREAM.md](UPSTREAM.md); this page records the decisions of the port.

## Reuse trade-off

Three options were evaluated:

| Option | Install cost | Privacy/latency | Maintenance | Decision |
| --- | --- | --- | --- | --- |
| Depend on the upstream Python package and bridge to it | Python 3.10+, pip, a clone of the upstream repo, a per-hook subprocess | Higher (session text crosses a process/format boundary; hooks are latency-sensitive) | Two runtimes, upstream host code irrelevant to DSH | rejected |
| Vendor the upstream Python package and call it | Same Python requirement, large vendored tree, host adapters still target other agents | Same | Highest | rejected |
| Reimplement the mechanisms in JavaScript inside the DSH plugin, porting algorithms faithfully and citing the source | One `dsh plugin add`; no extra runtime | All logic in-process, digest-only model input | One language, testable against upstream behavior | **chosen** |

The upstream plugin's Python host layer (Claude Code/Codex/Copilot/Pi/opencode
transcript readers, settings writers, launchers, marketplaces) has no DSH
analogue and is not ported. What is ported is the agent-independent core:
observation/classification, fact families and lifecycle, evidence policy, loop
detection rules, envelope, per-turn guard state machine, and the cost model.

## Faithfulness contract

- Thresholds, presets, decision order, and formulas are copied from the upstream
  code, not re-derived. `docs/UPSTREAM.md` §11 lists each constant with its
  upstream `file:line`; the port's tests assert the same behavior.
- State schemas keep upstream field names (`used_tools`, `streaks`,
  `prompt_streaks`, `catalog_tools`, `proposal`, `auto_pending`, `applied`, …)
  so future maintainers can compare documents to the upstream implementation.
- The nudge text, judge confidence handling, and "never stop the turn"
  invariant are preserved verbatim where they are user/model visible.

## Deliberate divergences

| Area | Upstream | This port | Why |
| --- | --- | --- | --- |
| Host integration | Five agent CLIs, hooks + settings files | One DSH adapter: Cordis events, scoped prompt sections, `ctx.tools.restrict`, commands | DSH is the only target. |
| Tool deny-list writer | Edits each agent's settings JSON/TOML | Restricted per agent at creation through DSH's own tool registry | No settings-file edits, no breakage of user configuration; DSH's approval policy is untouched. |
| Session fold trigger | Fold a finished session from the host transcript at session end | Snapshot each turn, fold once per session at disposal or on next activity | DSH sessions can be long-lived; snapshots make folding crash-safe and idempotent. |
| Learning input | Host transcript readers | Durable DSH `session/event` log (`tool/call`, `tool/result`, `user/message`, `turn/*`, `assistant/message`, `request/header`) | That log is the authoritative source and survives resume. |
| Model-assisted proposer | Agent-specific side-channel calls | One-shot call through the session's DSH model route; candidate facts need two cited observations and pass the same lifecycle gates | DSH's LLM service is the supported path; plugin usage is recorded as overhead. |
| Loop-guard delivery | Hook-attached mid-turn message per host | DSH `agent.steer()` user-role context at a step boundary; the "still stuck" notice is recorded (no plugin→user toast channel) | The DSH Agent API is the only supported injection surface; documented as a limitation. |
| Cost | Cache-aware "effective tokens" plus embedded vendor price snapshot | Token categories + cache-aware comparison units; **no currency, no savings claims**; unknown model pricing is labelled unknown | Avoid stale price tables and fabricated savings; DSH usage is what it is. |
| Repo identity | Remote-first repo key with migration/merge machinery | `realpath` + SHA-256 project key; no migration (fresh root), no git remote inspection | No network calls, no host-specific migration; a private local install does not need upstream's merge tooling. |
| State root | `~/.tokeneconomizer` | `<DSH_HOME>/tokeneconomizer` (configurable) | Follows DSH's data-home convention and keeps state out of projects. |

## Upstream components not ported

`tokeneconomizer/trace/{claude,codex,copilot,pi,opencode}.py`,
`tokeneconomizer/plugin/hosts.py` writers, `plugin/{probe,winspawn,repomap*}.py`,
`plugin/cli.py`'s host-specific commands (`probe`, `fold`, `repos migrate`,
`repomap`), the marketplace/installer scripts, and `experiments/`. The
micro-skills optional model layer keeps the upstream *idea* (digest-only input,
citation-gated admission) with a smaller detector vocabulary; the difference is
documented in code and in the module's tests.

## Attribution

The upstream LICENSE is reproduced unchanged. `NOTICE` records the upstream
project, commit, and paper, and states the changes made. No upstream NOTICE file
or per-file copyright header exists at the studied commit; this port therefore
adds the attribution statement required by Apache-2.0 §4(b) and keeps upstream
license text in files that contain ported material. The project is explicitly
labelled as unofficial.
