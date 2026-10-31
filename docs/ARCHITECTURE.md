# Architecture

```
DSH process
├── profile loader (cordis.patch.yml from this package)
│   └── row: `tokeneconomizer` → lib/index.js  (Cordis plugin)
│       ├── lib/dsh/            DSH adapter: events, commands, side calls
│       └── lib/                dependency-free mechanism cores + storage
│
├── <DSH_HOME>/tokeneconomizer/          (configurable; never inside a project)
│   ├── plugin-load.json
│   ├── diagnostics.jsonl
│   └── projects/<sha256(root)[:32]>/
│       ├── project.json                 identity + display path only
│       ├── microskills.json             persisted env-fact state
│       ├── microskills-manual.json      optional model-assisted fact layer
│       ├── toolprune.json               evidence, proposal, applied, given-back
│       ├── envelope.json                loop-guard per-repo learned envelope
│       ├── sessions/<session>.json      per-session fold inputs, crash-safe
│       ├── folded.json                  session ids already folded once
│       ├── ledger.jsonl                 session + overhead records
│       └── locks/                       short-lived write locks
```

## Module map

| Path | Responsibility | Depends on DSH? |
| --- | --- | --- |
| `lib/index.js` | Cordis plugin entry: config resolution, failure isolation, lazy adapter install. | no runtime imports |
| `lib/config.js` | Config defaults, `TE_*` overrides, validation helpers. **Dependency-free** so the CLI can load it without DSH. | no |
| `lib/config-schema.js` | Schemastery schema for the Cordis loader (`--dump-config-schema`); imported only by the plugin entry. | yes (host-provided peer) |
| `lib/project.js` | DSH home/data-dir resolution, project identity hash, symbolic path display. | no |
| `lib/store.js` | Atomic JSON store, JSONL append/rotate, lock files, corruption quarantine. | no |
| `lib/diagnostics.js` | Redaction and bounded diagnostics. | no |
| `lib/microskills/` | Command observation, env-fact families, fact lifecycle, render/inject block. | no |
| `lib/toolprune/` | Tool evidence, enough-evidence policy, pending/quiet/apply/restore state machine. | no |
| `lib/loopguard/` | Spiral state, detection rules, envelope, per-turn guard state machine, shell-edit detection. | no |
| `lib/usage/` | Cache-aware effective-token formula (comparison units, never currency), ledger records, summaries. | no |
| `lib/report.js` | Human and `--json` views over the state; the single formatting surface for commands and CLI. | no |
| `lib/commands.js` | Command language shared by the slash command and the terminal CLI. | no |
| `lib/dsh/` | Adapter: reads durable `session/event`s, maps agents/projects, applies prompt sections and tool restrictions, registers commands, performs optional model side calls. | yes, via services/events |
| `lib/dsh/install.js` | Event wiring and per-session state machine (hooks, steering, folding, restriction). | yes |
| `lib/dsh/mechanisms.js` | Bridge from the adapter to the pure mechanism cores and ledger builders. | no |
| `lib/dsh/project-runtime.js` | Per-project state documents, atomic writes, session snapshots, ledger. | no |
| `lib/dsh/session-accumulator.js` | Replayable per-session fact accumulation from durable events. | no |
| `lib/dsh/normalize.js` | Host record normalization (tool calls, results, usage, catalogs). | no |
| `lib/dsh/sidecall.js` | Optional one-shot model call over the session's DSH route, with timeout and usage. | yes |
| `lib/dsh/judge.js` | Optional background loop-guard judge + nudge writer (rate limiting stays in the guard). | no |
| `lib/dsh/proposer.js` | Optional micro-skills model proposer: compact digest, strict JSON prompt, evidence-checked admission. | no |
| `bin/te.js` | Terminal CLI over the same state and reporting functions. | no |

The mechanism cores never import `lib/dsh/`, DSH packages, or Node's `fs`:
they are pure functions over JSON state. This keeps them unit-testable and
keeps the adapter replaceable if DSH's plugin API evolves.

## Data flow

```
DSH session events (durable)
  session/event  ──► lib/dsh/session-accumulator ──► snapshot per session
        │                                              │
        │  tool/result (live)                          ├─► microskills fold (once/session)
        │                                              ├─► toolprune evidence fold
        └─► loop guard (per turn)                      └─► usage ledger record

agent/created ──► read project state ──► per-agent registrations:
                   ├─ systemPrompt.section (learned note, capped)
                   └─ tools.restrict({deny: applied})   (only toolprune=apply)

optional model calls (proposer / judge) ──► lib/dsh/sidecall ──► usage overhead
```

### Why a session fold happens once

Upstream folds a *finished* session into the learning state. A DSH session may
live for a long time, so the adapter snapshots the session after each turn into
`sessions/<id>.json` and folds it exactly once, either when the session is
disposed or (crash-safe) at the next plugin activity that sees an unfolded
snapshot. `folded.json` keeps the set so retries are idempotent. Two sessions
never share a fact: the state lives under a project key derived from the
session's `cwd`.

### Tool pruning is proven at the request boundary

DSH logs a `request/header` event carrying the assembled tool schemas for every
request. The adapter uses that log to (a) learn which tools a session actually
loaded, and (b) verify that an applied deny list really removed definitions
from the model request. `docs/VERIFICATION.md` records the integration test that
registers fake tools, applies a restriction, and asserts the assembled tool set
changed.

### Failure policy

Every adapter callback runs inside a guard that records a redacted diagnostic
and swallows failures. A malformed state file is quarantined and rebuilt; a
missing optional service turns the corresponding mechanism off. Load failures
never prevent a DSH session from starting.
