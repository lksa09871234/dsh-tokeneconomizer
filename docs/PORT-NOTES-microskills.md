# Port notes: micro-skills core (`lib/microskills/`)

Status: complete for the LLM-free layer (task-3). Derived from
`microsoft/TokenEconomizer` @ `e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9`
(Apache-2.0); every ported file carries the required modification notice in its
header. Not affiliated with, endorsed by, or supported by Microsoft.

Porting specification: `research/UPSTREAM.md` §2, §3, §8, §9.1, §10, §11.
Upstream sources: `upstream-te/tokeneconomizer/microskills/{observe,lifecycle,envfacts,stage}.py`.

## Files

| File | Purpose |
|---|---|
| `lib/microskills/observe.js` | Session observation: vocabulary, `bash` unwrap, quote-aware segment split, intent/form classification, error classes, test labels/label rules, env-var evidence, edited-file extraction, `observeSession(calls, {cwd, repoRoot})`. |
| `lib/microskills/lifecycle.js` | Fact lifecycle state machine: CANDIDATE → ACTIVE → RETIRED, drift promotion, recency score, firing gate, JSON round-trip. |
| `lib/microskills/envfacts.js` | The five deterministic fact families (FormRepair, Boundary, EmptyProbe, ArgRepair, EnvValue), lint, selection/merge/render, caps, fact persistence, `factsView`. |
| `lib/microskills/stage.js` | Pure orchestration over a plain-JSON state document: `createState`/`stateFromJSON`, `foldSession`, `renderInjection`, `listFacts`, `removeFact`, `resetProjectState`, `renderProvenance`. |
| `test/unit/microskills/observe.test.js` | 27 tests |
| `test/unit/microskills/lifecycle.test.js` | 11 tests |
| `test/unit/microskills/envfacts.test.js` | 43 tests |
| `test/unit/microskills/stage.test.js` | 18 tests |
| `test/unit/microskills/helpers.js` | Shared session fixtures (not a test file; not matched by `*.test.js`). |

No runtime dependencies: Node builtins only (`node:fs`, `node:path`); no network,
no model calls, no filesystem writes inside the mechanism modules. `stage.js`
performs no I/O at all — the adapter persists its state through `lib/store.js`.

## Exported API (for the DSH adapter)

### `observe.js`

```js
class Vocabulary { name, interpreters, canonicalInterpreter, runnerHeads, runnerScripts,
                   runnerModules, packageTools, fetchHeads, envProbeHeads, taskHeads,
                   buildHeads, generic }
const PYTHON_GIT, NODE_WEB, GENERIC, DEFAULT_VOCAB   // DEFAULT_VOCAB === GENERIC (divergence 2)
const BUILD_SUBS, GIT_FETCH_SUBS, GIT_PROBE_SUBS, ENV_PROBE_HEADS, PREFIX_HEADS
const ERROR_CLASSES, NETWORK_ERRORS, FORM_ERRORS, PROBE_HIT
const SHELL_TOOL_RE ... (internal)

unwrap(cmd) -> string
segments(cmd) -> string[]
stripRtkPrefix(command) -> string
classifyCommand(cmd, options?: {callIndex?, vocab?, cwd?, root?, top?}) -> Observation[]
class Observation { call, intent, form, head, prefix, segment, hosts, probe, outcome,
                    labels, labelErr, loaded, testsRan, env, toString(), toJSON() }
repositoryTop(start) -> string|null
cdTarget(cur, target, root?, top?) -> string|null
errorClass(output) -> string|null
exitCodeHint(output) -> number|null
labelFailed(labels, output) -> boolean
testLabels(observation) -> string[]
labelRule(a, b) -> [kind, param]|null
envCalls(cmd, output, success) -> {need, sets, ok}
formFailed(observation) -> boolean
formWorked(observation) -> boolean
isBare(form) -> boolean
editedFiles(triples) -> Set<string>
editedPyfiles(triples) -> Set<string>
isShellTool(tool) -> boolean
observeSession(calls, options?: {cwd?, repoRoot?, vocab?})
  -> {obs: Observation[], edited: string[], nCalls, env: Array<{need, sets, ok, call}>}
```

`calls` is an array of `{tool, args, resultText, failed?, ok?, exitCode?, cwd?}` —
the shape `lib/dsh/normalize.js` produces. `cwd` (session start, absolute) and
`repoRoot` (repository top) are optional; without them, observations are read as
session-relative text (the Codex behavior upstream). A per-call `cwd` may be set
by the adapter when the host records where a call ran (upstream got this from
Claude Code's transcript).

### `lifecycle.js`

```js
const K_PROMOTE=3, GAMMA=0.8, LAMBDA=5.0, SCORE_FLOOR=0, HARD_KILL=true,
      FIRE_GATE=0.40, FIRE_MIN_N=4
class Lifecycle {
  constructor(key, high, drift = true)
  key, high, drift, state, confirms, contradicts, fireNum, fireDen, promotedAt, retiredAt
  toJSON() -> upstream snake_case document
  static fromJSON(doc) -> Lifecycle            // throws TypeError on a non-document
  driftedConfirms() -> number
  score(now) -> number
  firingRate() -> number
  injectable() -> boolean
  update(now, verdict, fired, exercised, files) -> void
}
```

### `envfacts.js`

```js
const STATE_SUBDIR='envfacts_state', MAX_FACTS=4, MAX_TOKENS=150,
      HEADER, GENERIC_HEADER, CONTRADICT_STREAK=2, LINT_RE, ERROR_PHRASE
class EnvFact {
  constructor(id, family, high, params?)
  id, family, params, life
  get state(); injectable(); firingRate()
  claim() -> string              // sanitized to one line, '' when it makes no claim
  best(key) -> string|null
  workingForm() -> string|null
  toJSON() -> {id, family, params, life}
  static fromJSON(doc) -> EnvFact // throws TypeError on a non-fact
}
class EnvFactsModel {
  constructor({repo?, vocab?, maxFacts?, maxTokens?})
  repo, vocab, maxFacts, maxTokens, now, facts: Map<string, EnvFact>, optTokens (always 0),
  lastInjected: Set<string>, lastDigest
  get header()
  update(observation, {iid?, resolved?}) -> lastDigest    // one finished session
  render() -> string                                      // block for the next session ('' if none)
  injectedIds() -> string[]
  seedInjected(ids) -> void
  injectableClaims() -> string[]
  factsView() -> FactRow[]
  select() -> EnvFact[]
  mergedLines(facts) -> string[]
  linesText(facts) -> string
  toJSON() -> {repo, now, opt_tokens, vocab, facts}       // upstream envfacts_state schema
  static fromJSON(doc, options?) -> EnvFactsModel          // tolerant
}
foldFact(fact, now, verdict, fired, exercised, files) -> void
typedOk(o) -> boolean
repairs(form, aForm, intent) -> boolean
usage(form, args?), rootKey(form), join(items), lintOk(text), sanitizeOneLine(text)
vocabularyByName(name) -> Vocabulary
```

### `stage.js`

```js
const STATE_SCHEMA_VERSION=1, PROFILE_OFF='off', PROFILE_ENVFACTS='envfacts', PROVENANCE_NOTE
createState(options?: {profile?, repo?, vocab?}) -> MicroskillsState
stateFromJSON(raw, options?) -> MicroskillsState        // tolerant of corrupt/missing state
foldSession(state, observation, options?: StageOptions) -> MicroskillsState
renderInjection(state, options?: StageOptions) -> {text, ids, factsView}
listFacts(state) -> FactRow[]
removeFact(state, id) -> boolean
resetProjectState(options?) -> MicroskillsState
renderProvenance(text) -> string
```

`StageOptions = {profile?, maxFacts?, maxTokens?, injectedIds?, iid?, resolved?, timestamp?, repo?, vocab?}`.

`MicroskillsState` (plain JSON; camelCase envelope, upstream-shaped payloads):

```jsonc
{
  "schemaVersion": 1,
  "profile": "off | envfacts",
  "repo": "owner/repo",
  "vocab": "generic | python-git | node-web",
  "now": 4,               // task index (monotonic folds)
  "sessions": 4,          // §2.6 injection.json "sessions"
  "optTokens": 0,         // invariant: this layer is LLM-free
  "facts": { "<id>": {"id","family","params","life":{...upstream keys...}} },
  "injectedIds": ["..."], // pending cross-process seed (§2.5 injected_ids)
  "rendered": "<last block or ''>",
  "renderedIds": ["..."],
  "updated": null,        // adapter-supplied epoch seconds
  "lastDigest": {"iid","resolved","injected","verdicts":{"<id>":{"verdict","fired","exercised"}},"nCalls"}
}
```

## Recommended adapter flow (per §3.5 / §2.6)

1. `state = stateFromJSON(store.readJson('microskills.json', {}))`.
2. On session start: `const {text, ids} = renderInjection(state, {profile, maxFacts, maxTokens})`;
   if `text` is non-empty, inject `renderProvenance(text)` and persist `state`;
   record `ids` on the session record (`injected_ids`, §2.5).
3. On session end: build `calls` from the session accumulator, `observation =
   observeSession(calls, {cwd: session.cwd, repoRoot})`, then
   `foldSession(state, observation, {profile, injectedIds: session.injected_ids,
   iid: session.sessionId, timestamp: Date.now()/1000})`; persist `state`.
4. `te facts`/status: `listFacts(state)` (works with `profile: 'off'`), and
   `renderInjection(state).text` for the block. Report `optTokens` (0) under
   `overhead.optimizer_tokens`.
5. `te reset`: `store.writeJson('microskills.json', resetProjectState({repo}))`.

Caps: `config.microskillsMaxFacts` → `maxFacts`; the token cap is
`maxTokens * 4` characters (`~4 chars/token`, header included). The plugin
config exposes `microskillsMaxChars`, so the adapter converts, e.g.
`maxTokens: Math.max(1, Math.round(maxChars / 4))` (see divergence 8).

### Current wiring (Lead's `lib/dsh/mechanisms.js`)

The bridge already consumes this API exactly as above:
`renderMicroskills()` → `stateFromJSON` + `renderInjection` + `renderProvenance`
(then appends the optional model-assisted layer), and `foldMicroskills()` →
`observeSession` + `foldSession`; the deterministic state is saved separately
from the model-assisted store. `test/integration/real-plugin-behavior.test.js`
exercises the pair end-to-end.

One adapter-side suggestion (not a mechanism bug): `foldMicroskills` passes
`repoRoot: snapshot.cwd`, i.e. the directory the session started in, where the
repository top would be more precise. The mechanism only needs an absolute
directory and is safe either way; passing the project's repository root makes
the `cd <repo> && pytest` → plain-`pytest` collapse (`_cd_target`) apply to
sessions started in a subdirectory of the repository.

## Upstream parity table

| Port (file: export) | Upstream reference | Notes |
|---|---|---|
| `observe.Vocabulary`, `PYTHON_GIT`, `NODE_WEB`, `GENERIC` | `observe.py:25-96` | data ported verbatim as sets/arrays |
| `observe.unwrap` | `observe.py:167-179` | `/bin/bash -lc "…"` |
| `observe.segments` | `observe.py:182-205` | heredoc elision + quote-aware split |
| `observe.Observation` | `observe.py:212-225` | camelCase fields, `toJSON()` keeps snake_case |
| `observe.repositoryTop` | `observe.py:228-241` | `node:fs`/`node:path` instead of `os.path` |
| `observe.cdTarget` | `observe.py:244-272` | same relative-state semantics + repo-top collapse |
| `observe.classifyCommand` | `observe.py:292-367` | options object instead of positional kwargs |
| `observe.classifySegment` (internal) | `observe.py:381-446` (`_classify`) | 1:1 |
| `observe.probeKind` (internal) | `observe.py:449-463` (`_probe_kind`) | 1:1 |
| `observe.errorClass` | `observe.py:466-470` | JS `m`/`i` flags replace Python inline `(?m)`/`(?i)` |
| `observe.exitCodeHint` | `observe.py:473-475` (`_exit_code_hint`) | 1:1 |
| `observe.labelFailed` | `observe.py:486-492` (`_label_failed`) | 1:1 |
| `observe.testLabels` | `observe.py:517-540` (`_test_labels`) | 1:1 |
| `observe.labelRule` | `observe.py:543-558` | returns `[kind, param]` instead of a tuple |
| `observe.envCalls` | `observe.py:561-567` (`_env_calls`) | 1:1 |
| `observe.formFailed` / `formWorked` / `isBare` | `observe.py:570-584,705-709` | 1:1 |
| `observe.editedFiles` / `editedPyfiles` | `lifecycle.py:24-50` | moved here (see divergence 4) |
| `observe.observeSession` | `observe.py:587-692` (`observe_task`) | takes normalized calls, no transcript reader |
| `lifecycle.Lifecycle` | `lifecycle.py:53-117` | JSON keeps upstream snake_case |
| `lifecycle.K_PROMOTE` … `FIRE_MIN_N` | `lifecycle.py:15-21` | exact values |
| `envfacts.EnvFactsModel` | `envfacts.py:222-560` (`EnvFactsDistiller`) | takes an observation digest; no file I/O |
| `envfacts.EnvFact` | `envfacts.py:66-143` | `claim()` sanitizes to one line |
| `envfacts.foldFact` | `envfacts.py:149-167` (`fold`) | 1:1 including CONTRADICT_STREAK |
| `envfacts.typedOk` / `repairs` | `envfacts.py:170-181` | 1:1 |
| `envfacts.usage` / `rootKey` / `join` / `lintOk` | `envfacts.py:184-216` | 1:1 |
| `envfacts.EnvFactsModel.select/mergedLines/render` | `envfacts.py:252-313` | 1:1 (selection order, caps, merged FormRepair line) |
| `envfacts.EnvFactsModel.update` (five families) | `envfacts.py:316-521` | 1:1 discovery/verdict logic |
| `envfacts.EnvFactsModel.toJSON/fromJSON` | `envfacts.py:523-547` | plain JSON; tolerant load (divergence 5) |
| `envfacts.EnvFactsModel.factsView` | `envfacts.py:550-560` (`debug_row`) | flat row array instead of a dict |
| `stage.createState/stateFromJSON` | `plugin/fold.py:88-93` + §2.6 | one document for `injection.json` + envfacts state |
| `stage.foldSession` | `stage.py:117-132` (`after_task`) + `envfacts.update` | returns the state document; caller persists |
| `stage.renderInjection` | `stage.py:108-116` (`render`/`injected_ids`) | returns `{text, ids, factsView}` |
| `stage.renderProvenance` | — (new; §8.1 weakness 1 hardening) | untrusted-data wrapper for the adapter |

## Intentional simplifications / divergences

1. **Input is normalized calls, not a transcript.** The host transcript readers
   (`trace/*.py`) are dropped (§10). `observeSession` takes
   `{tool, args, resultText, failed?, ok?, exitCode?, cwd?}`. Consequence:
   upstream's `load_trajectory`/`call_cwds` failure modes disappear, per-call
   cwd is adapter-supplied, and `now` is a task index supplied by the stage.
2. **Default vocabulary is `GENERIC`** (upstream's default is `PYTHON_GIT` for the
   experiments; the plugin passed `GENERIC` explicitly). `DEFAULT_VOCAB` is
   exported as an alias of `GENERIC`; `PYTHON_GIT`/`NODE_WEB` remain available
   and are pinned by tests. Upstream `Header` selection therefore differs for
   bare mechanism use (the DSH plugin always gets the generic header).
3. **Tool-name families.** Upstream only classifies
   `("shell", "bash", "stop_bash")`. DSH reports raw names (`bash`, `ops_bash`,
   `pwsh`, `ops_edit_file`, `write_file`, …), so `observe.js` matches the same
   families as `lib/dsh/normalize.js:toolFamily` (duplicated because mechanisms
   must not import the DSH adapter; mirror pinned by tests on both sides).
   Edit tools accept `file_path`, `path` and `filePath`; `apply_patch` uses
   `paths` (upstream) with a single `path` fallback.
4. **`editedFiles`/`editedPyfiles` live in `observe.js`** (upstream has them in
   lifecycle.py) so `lifecycle.js` stays a pure state machine; behavior is
   unchanged.
5. **Tolerant persistence.** Upstream `EnvFactsDistiller.load` calls
   `json.load` without a guard and fails the fold on a corrupt file (§8.1
   weakness 5). `EnvFactsModel.fromJSON`/`stage.stateFromJSON` skip invalid
   fact documents and fall back to empty state. Unlike upstream's `load`, the
   persisted `vocab` **is** restored (upstream ignores it and silently reverts
   to the Python/git header — verified with the oracle; divergence is
   deliberate and its effect is limited to the header line).
6. **Sanitization.** Every rendered claim, and each rendered line, is collapsed
   to one line (`sanitizeOneLine`: control chars/newlines/Unicode line
   separators → space; whitespace collapsed) before it reaches the block. The
   persisted facts keep the raw observation; only rendering sanitizes.
   `stage.renderProvenance(text)` wraps a non-empty block as
   `<learned-environment-facts>` + a stale-data warning comment. Upstream
   injects plain markdown (§8.1 weakness 1); the adapter must use the wrapper.
7. **State split.** Upstream keeps `injection.json` (rendered block) and
   `envfacts_state/<repo>.json` (facts) separately; the DSH port keeps one
   `MicroskillsState` document (envelope camelCase, fact payloads and lifecycle
   documents exactly upstream's schema). `state.updated` is an adapter-supplied
   epoch timestamp; no mechanism code calls `Date.now()`.
8. **Cap units.** The mechanism caps in `MAX_TOKENS` (150) / `maxTokens*4`
   characters, exactly upstream. The plugin config exposes
   `microskillsMaxChars` (default 1200) rather than tokens, so the adapter must
   convert (`maxTokens = floor(maxChars/4)`); nothing here assumes a provider
   tokenizer.
9. **Selection length check** uses JS `String.length` (UTF-16 code units) where
   Python used code points; claims are ASCII/`…`-only in practice, so caps are
   equivalent for real content.
10. **`factsView()` is a flat row array** (`{id, family, state, fire, rate,
    injectable, claim}`) instead of upstream's id-keyed `debug_row` dict with
    `_profile`/`_vocab`/`_task` meta. The stage exposes `state.profile` /
    `state.vocab` / `state.lastDigest` for the same status information.
11. **Optional model layer is out of scope** (`distiller.py`,
    `'envfacts+distiller'` profile). Hook point: `stage.js` module doc —
    a future layer would run between `render()` and the adapter with
    `EnvFactsModel.injectableClaims()` as the "already stated" list, report
    `optTokens` from its own accounting, and keep this module free of I/O.
    Consequently these §9.1 P cases are not ported here:
    `distiller.windowPersists`, `distiller.promptListsExistingFacts`,
    `test_the_experiments_proposer_prompt_is_the_papers`,
    `stage.reportsProposerTokens`.
12. **No unbounded-growth cap on tracked facts** (upstream has none either;
    §8.1 weakness 4). `removeFact` is provided so a future CLI can prune.

## Verification

Commands (from `dsh-tokeneconomizer/`):

```
node --test --test-isolation=none "test/unit/microskills/*.test.js"
# → 99 tests, 99 pass, 0 fail

node node_modules/typescript/bin/tsc -p jsconfig.json --noEmit
# → no errors in lib/microskills/** or test/unit/microskills/** (other modules
#   still carry pre-existing errors owned by their builders; not this task)
```

Cross-check against the Python implementation (offline, no pytest needed; the
upstream package is stdlib-only and importable from `upstream-te/`):

- **Observation oracle**: 18 synthetic sessions (compound failure attribution,
  network/fetch reachability, VCS probes homogeneous vs compound, `cd` failure,
  env-var evidence, filtered test output, label errors, exit-code hints,
  `cargo build` under both vocabularies) plus an edited-files case. Full
  `{obs[intent,form,head,prefix,hosts,probe,outcome,labels,label_err,loaded,
  tests_ran,env], edited, n_calls, env}` digests are **identical** to
  `observe.observe_task` for both `GENERIC` and `PYTHON_GIT`; classification
  primitives (`classify_command`, `segments`, `unwrap`, `label_rule`,
  `_test_labels`, `_label_failed`, `error_class`, `_cd_target`,
  `repository_top`, `is_bare`, `strip_rtk_prefix`) were likewise compared 1:1.
- **Env-facts oracle**: 30 scenario streams replayed through upstream
  `EnvFactsDistiller` and this port (rendered blocks before/after every session,
  per-session fact state/firing counters, full `life` documents, `params`,
  claims, `now`, `opt_tokens`) plus 8 constructed-fact rendering cases and 8
  `lint_ok` cases. All identical **except** the deliberate `vocab`-restore
  divergence (5). This pins the five families, caps, merged lines, drift,
  contradiction streaks, retirement and save/load behavior.

## UNKNOWN / open questions

- `distiller.py` parity (paid proposer, detector DSL, window persistence) is
  intentionally unported; §9.2–9.4 tests of that layer are out of this task.
- Upstream's ambiguous fixture schema for `tests/fixtures.py` is absent from the
  tarball; the oracle therefore replays Codex-format transcripts and normalized
  DSH calls instead. The Claude-transcript cases from
  `test_envfacts_args.py` that depended on recorded per-call cwds are ported
  using `call.cwd` (see `observe.test.js` "per-call cwd" and
  `envfacts.test.js` "formWorkingFormPrefersStill").
- Whether the DSH adapter will pass per-call cwd from shell `workdir` arguments
  is the adapter's decision; `observeSession` only reads `call.cwd`.
- The plugin's `microskillsMinEvidence` setting (default 3) overlaps
  `K_PROMOTE`; this layer keeps the validated constant (3) and does not accept
  an override — the adapter should not diverge silently.
