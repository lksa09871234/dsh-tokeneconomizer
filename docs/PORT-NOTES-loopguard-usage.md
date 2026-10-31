# Port notes: loop-guard and usage/accounting core

Status: implemented (`lib/loopguard/`, `lib/usage/`), tests green, typecheck-clean for
these modules. Porting source of truth: `research/UPSTREAM.md` §§ 5, 6, 8, 9.2–9.3,
10, 11, plus upstream `tokeneconomizer/loopguard/{state,rules,envelope,turn,shell_edits,judge}.py`,
`tokeneconomizer/{ledger,pricing}.py` and `tokeneconomizer/plugin/accounting.py`.
Upstream: microsoft/TokenEconomizer @ `e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9`,
Apache-2.0.

All modules are **pure JavaScript over JSON state**: no host imports, no filesystem,
no network, no credentials, no timers, no global state, no currency amounts. The DSH
adapter (`lib/dsh/`) owns events, persistence, side calls, and delivery.

## Scope

| Upstream | DSH port | Class |
|---|---|---|
| `loopguard/state.py` — `SpiralState`, `canon_tool`, `_failure_sig`, `TEST_RUN_RE`, `ERR_RE`, `recent_digest`, `snapshot` | `lib/loopguard/state.js` | **F** (host stream parser `completed_calls` dropped) |
| `loopguard/rules.py` — thresholds, `SPIRAL_LEVELS`, `scaled_thresholds`, `gate_for_judge`, `is_stuck`, `assess_abort`, `nudge_text` | `lib/loopguard/rules.js` | **F** |
| `loopguard/envelope.py` — `_percentile`, `EnvelopeTracker`, learned thresholds, `load/save_envelope`, `thresholds`, `base_thresholds`, `record_turn`, `ENVELOPE_HISTORY` | `lib/loopguard/envelope.js` | **F** (persistence split: pure load/save document helpers) |
| `loopguard/turn.py` — `TurnGuard`, `status_of_tests`, `runner_verdict`, `VERIFY_RE`, `resolved_proxy`, judge cadence, nudge ladder, `after_nudge`, `summary` | `lib/loopguard/guard.js` | **F/S** (decision vocabulary `nudge`/`notice`; adapter supplies judge) |
| `loopguard/shell_edits.py` — shell tokenizer + edit-target detection + `fold_shell_edits` | `lib/loopguard/shell-edits.js` | **F** (+ Windows separators, newline tokenization fix) |
| `loopguard/judge.py` — both system prompts, prompt builders, strict reply parsers | `lib/loopguard/judge.js` | **F** (parsers strict → `null`; no runner/side-call here) |
| `pricing.py` — cache-aware weights, `effective_tokens`, `has_breakdown`, `approx_tokens` | `lib/usage/pricing.js` | **S**: **no embedded vendor price snapshot** (see below) |
| `ledger.py` — `OVERHEAD_KEYS`, `overhead`, `effective_exec`, `CostLedger` | `lib/usage/ledger.js` | **F** + session/overhead record builders |
| `plugin/accounting.py` — `FALLBACK_WEIGHTS`, `effective`, `summarize`, `fmt_tokens` | `lib/usage/accounting.js` | **F** |
| `plugin/fold.py:369-419` — ledger record shape | `lib/usage/ledger.js` (`buildSessionRecord`) | **F** |

Dropped, by design: upstream host transcript readers/`completed_calls`, `plugin/`
controllers and hook plumbing, `AsyncJudge` process machinery (the DSH adapter wires
its own side call), `pricing.MODEL_WEIGHTS`/`runner_effective_or_approx` (no vendor
price table, no side-call runner), repo migration/`envelope.json` locking (the DSH
`JsonStore` owns locking).

## Modules and exported API (for the DSH adapter)

All timestamps the adapter passes are Unix **seconds**; explicit `now` where a clock
would otherwise be implicit.

### `lib/loopguard/state.js`

- `SpiralState` — per-call signal fold. Fields (camelCase): `turns`, `editCounts`
  (basename → count), `editOrder`, `errorOutputs`, `testRuns`, `failSigs`
  (md5[0:10] → count), `repeatedFailSigs`, `recent` (≤ `RECENT_LIMIT` = 40).
  Getters `editChurn`, `distinctEditFiles`, `stagnation`.
  - `update(toolName, args, resultText, failed?)` — `failed` is what the host reported
    (true non-zero exit/tool error, false success, null/undefined unknown; `0`/`1`
    tolerated). Content tools (`view`/`grep`/`glob`) can only fail when the tool itself
    reports failure; a call known to have succeeded cannot be a failure.
  - `recentDigest(n = 24, envelope = null)` — leakage-safe digest
    (`turns=… edit_churn=… …` header + optional repo context + last n action lines).
    This is the **only** text an optional judge sees.
  - `snapshot()` — `{turns, edit_churn, distinct_edit_files, error_outputs, test_runs,
    stagnation, repeated_fail_sigs}` (snake_case: persisted in `envelope.json`).
  - `toJSON()` / `SpiralState.fromJSON(data)` — segment persistence.
- `canonTool(name)` — upstream map plus DSH spellings (`pwsh`, `ops_bash`,
  `read_file`, `edit_file`, `write_file`, `search_files`, `list_files`, …).
- `basename(path)` — last component; accepts `/` and `\`.
- `failureSignature(text)` — md5 of the normalized first error line, 10 hex chars.
- `matchesErrorMarker(text)` — upstream `ERR_RE` semantics (case-insensitive part plus
  the case-sensitive `--- FAIL: ` / `FAIL\t` / `FAIL$` tail).
- Constants: `TEST_RUN_RE`, `ERR_RE`, `ERR_RE_CASE_SENSITIVE`, `RECENT_LIMIT`.

### `lib/loopguard/rules.js`

- `DEFAULT_THRESHOLDS` (frozen, verbatim upstream §11), `SPIRAL_LEVELS`
  (`conservative`/`default`/`aggressive`, frozen), `SPIRAL_LEVEL_NAMES`.
- `scaledThresholds(level = 'default')` — defaults overlaid with the preset; unknown
  level → defaults.
- `gateForJudge(state, thr?)`, `isStuck(state, thr?)`,
  `assessAbort(state, {envelope = null, judge = null, thr = DEFAULT_THRESHOLDS})`
  → `{abort, reason}` with upstream's exact decision order: hard backstop → judge
  (gate/throttle/stuck/productive/ambiguous) → no-judge envelope fallback.
- `nudgeText(state)` — verbatim upstream redirect template.
- `pinLiveThresholds(thr)` — **live-plugin policy** (`plugin/controller.py:314-320`):
  `gate_over_envelope: false`, `gate_min_turns: max(gate_min_turns, min_turns)`.
  The adapter **must** apply this to the per-tool-call threshold dict; without it a
  merely long turn wakes the judge (harness semantics, upstream `assess_abort` default).
- `sanitizeThresholdOverrides(overrides)` — accepts only known numeric keys.

### `lib/loopguard/envelope.js`

- `EnvelopeTracker` — `new EnvelopeTracker({margin, pct, minSamples, level = 'default',
  frozenEnvelope = null})`; `update(turns, resolved, snapshot?)`; `envelope` getter
  (`null` while cold, else `margin × p<pct>` of ended-green turn counts);
  `thresholds(maxTurns?)` (learned turn-scale gates `0.6×p90` clamped to `[6, base]` /
  `[8, base]`, learned signal floors, cap-aware backstop `0.9×maxTurns`); `toJSON()` /
  `EnvelopeTracker.fromJSON(document, {level, overrides})`.
- `loadEnvelope(document, {level, overrides})`, `saveEnvelope(tracker)` — pure JSON
  document in/out; the adapter persists it under the store lock.
- `thresholdsFor(tracker, overrides)` — learned thresholds, then pinned values; a
  pinned `backstop_mult` recomputes `backstop_turns`.
- `baseThresholds(level, overrides)` — preset + pins, before learning (status output).
- `resolvedProxy(guard, stoppedNormally = true)` — the ended-green definition:
  stopped normally, not aborted, `cumTurns > 0`, and not (last verify failed after the
  last edit). Requiring a *passing* check after the last edit was deliberately rejected
  upstream.
- `recordTurn(tracker, guard, stoppedNormally = true)` — folds a finished turn, only if
  green, with `guard.whole.snapshot()`; returns the tracker (caller locks + saves).
- `percentile(xs, p)`, `ENVELOPE_HISTORY` = 500, `ENVELOPE_OVERRIDE_KEYS`.

### `lib/loopguard/shell-edits.js`

- `shellEditTargets(cmd)` → basenames of files the command writes, in order, deduped:
  `sed -i`, `perl -pi`, `tee`, `>`/`>>`/`&>` redirects into source files, `patch` /
  `git apply`, `apply_patch` heredocs, `git checkout --` / `git restore`, inline Python
  `open(..., 'w')` / `Path(...).write_text/bytes`, heredoc bodies included.
  Never executes anything; output captures (`> out.log`), scratch dirs (`/tmp`,
  `/dev`, `/proc`) and quoted operators are not edits.
- `foldShellEdits(state, names)` — counts them as edits and annotates the action log.
- Lower-level exports for debugging/tests: `splitHeredocs(cmd)`, `tokenizeShell(text)`,
  `parseCommands(shell)`.

### `lib/loopguard/guard.js`

- `TurnGuard` — one prompt-turn state machine.
  - `new TurnGuard({turnKey = '', data = null})`, `toJSON()`, `TurnGuard.fromJSON(data)`
    (persisted document keys are upstream snake_case, `events` capped at 20, tokens and
    judge cadence included).
  - `fold(toolCall, options?)` → `{action: 'nudge'|'notice', reason, text} | null`.
    `toolCall` accepts the DSH `NormalizedToolCall` shape:
    `{tool|name, args, resultText|result, failed?, exitCode?}`.
    `options`: `{envelope, thr, judge, writer, nudgeBudget = 1, now}`.
    It folds state, checks the hard cumulative backstop (nudge-first), rate-limits the
    judge (`JUDGE_BASE_GAP = 5` → `JUDGE_MAX_GAP = 20` after a productive verdict;
    `JUDGE_STALE_S = 300` for a dead background job), and applies upstream's ladder:
    first stuck verdict → **nudge**, later → **notice**, then `null` forever after.
    A returned nudge already consumed the redirect text and reset the segment
    (`afterNudge`), so the adapter must not call `afterNudge` again.
  - `nudgeBody({envelope, writer})` — judge-written redirect → writer output → template.
  - `afterNudge()`, `resolvedProxy(stoppedNormally)`, `verificationState()`,
    `liveDigest(digest)`, `summary(stoppedNormally)`, `noticeText(reason)`.
  - Judge interface (`JudgeLike`, all optional): synchronous
    `judge(digest) -> {stuck, confidence, reason, tokens?, nudge?} | null`, or
    background `start(guard, digest) -> jobId` + `poll(guard) -> {found, verdict}`;
    optional `writer(digest) -> {text, tokens?}`.
  - **Never stops a turn.** No host cancel/stop API is referenced; only the returned
    decision is exposed. The `aborted` flag records that the notice rung was reached.
- `statusOfTests(cmd)` → `'own'|'hidden'|'mixed'|null` (does the command line's exit
  status belong to its test run?), `runnerVerdict(text)` → `true|false|null` (the
  runner's own summary), `VERIFY_RE` (broad cross-ecosystem verification detector),
  `shlexSplit(text)`.
- Constants: `JUDGE_BASE_GAP`, `JUDGE_MAX_GAP`, `JUDGE_STALE_S`.

### `lib/loopguard/judge.js`

- `STUCK_JUDGE_SYSTEM`, `NUDGE_WRITER_SYSTEM` — **verbatim** upstream prompts (verified
  byte-for-byte against `judge.py:15-27,66-80`).
- `buildStuckJudgePrompt(digest)`, `buildNudgeWriterPrompt(digest)`.
- `parseStuckJudgeReply(raw)` → `{stuck: bool|null, confidence, reason}` or `null`;
  strict: first `{…}` object, boolean/null `stuck`, finite `confidence` clamped 0–1,
  string `reason` capped at 160.
- `parseNudgeWriterReply(raw)` → trimmed plain text ≤ 1200 chars, or `null`.
- `NUDGE_MAX_CHARS`, `JUDGE_REASON_MAX_CHARS`.
- No network, no runner, no credentials: the adapter performs the side call and passes
  the raw reply.

### `lib/usage/pricing.js`

- `WEIGHTS_CLAUDE` `{input 1.0, cache_read 0.10, cache_write 1.25, output 5.0}`;
  `FALLBACK_WEIGHTS` `{… output 6.0}` (labeled fallback); `PRICED_BY`
  (`model`/`fallback`/`no_usage`).
- `resolveModel(record)` — explicit `model`, router `provider/model` → tail, absent → null.
- `hasBreakdown(record)`, `weightsFor(record)` → `{weights, priced_by}`,
  `effectiveTokens(record, weights?)`, `effective(record)` →
  `{effective_tokens: number|null, priced_by}`, `approxTokens(text)`.
- **No vendor price table and no currency numbers beyond the two ratio curves.** A
  non-Claude explicit id (including every DeepSeek id) is priced on the labeled
  fallback curve; `null`/absent model id keeps upstream's legacy Claude-curve default
  with `priced_by: "model"`. Unknown stays labeled; the adapter always records the
  billed id so the fallback label is visible.

### `lib/usage/ledger.js`

- `OVERHEAD_KEYS` (frozen, six upstream keys), `overheadOf(record)`,
  `effectiveExec(record)`, `CostLedger` (`add(row, execCost?)`, `cumExec`,
  `cumOverhead`, `n`, getters `cumTotal`, `amortizedPerTask`, `overheadFrac`).
- `buildSessionRecord(input)` — the §6.3 `kind: "session"` record. Input is
  host-neutral: `{sessionId, host, repo, model, usage: {inputTokens, cacheReadTokens,
  cacheWriteTokens, outputTokens, totalTokens}, prompts, requests, turns, nudges,
  aborts, injectedChars, injection, untool, untoolApplied, overhead, shadow, started,
  ended, foldedAt, error}`. Emits upstream snake_case fields, computed
  `effective_tokens`/`priced_by` (via `pricing.effective`), and a complete six-key
  `overhead` object.
- `buildOverheadRecord({sessionId, host, repo, job, at, overhead})` — a detached paid
  call's own `kind: "overhead"` record (upstream `plugin/judge.py:92-94`).
- `normalizeOverhead(overhead)`, `validateRecord(record)` → `{ok, errors}`,
  `mergeRecords(existing, incoming, {dedupeBy?})` → `{records, added, skipped}`
  (idempotent ledger append), `isPriced(record)`, `priceLabelFor(record)`.

### `lib/usage/accounting.js`

- Re-exports `FALLBACK_WEIGHTS`, `OVERHEAD_KEYS`, `overheadOf`.
- `effectiveUsage(usage)` → labeled effective tokens.
- `summarize(records)` → exactly
  `{sessions, priced_sessions, effective_tokens, overhead_tokens, overhead_frac,
  requests, nudges, aborts, turns, injected_sessions}`; only priced sessions contribute
  execution tokens, overhead counts `kind ∈ {session, overhead}`.
- `fmtTokens(n)` (`1.2M`, `340.0k`, `512`, `n/a`), `fmtPercent(fraction)` — display
  helpers only.
- **No fabricated savings.** The summary has no savings/percent/counterfactual field;
  a status command reports observed ledger sums and the observed overhead fraction.

## Adapter wiring (suggested)

```js
// Per tool result (live):
const tracker = loadEnvelope(store.readJson('envelope.json', {}), {
  level: config.loopguardAggr, overrides: config.loopguardThresholds,
})
const decision = guard.fold(call, {
  envelope: tracker.envelope,
  thr: pinLiveThresholds(thresholdsFor(tracker, config.loopguardThresholds)),
  judge,                    // optional: sync {judge} or background {start, poll}, plus {writer}
  nudgeBudget: config.loopguardNudges,
})
if (decision?.action === 'nudge') injectMidTurn(decision.text)          // attached to the tool result
else if (decision?.action === 'notice') notice(`${decision.text} ${stopHint}`) // how the person can interrupt
store.writeJson(`sessions/${sid}/turn.json`, guard.toJSON())

// Turn end (under the `envelope` lock):
const tracker = loadEnvelope(store.readJson('envelope.json', {}), { level, overrides })
recordTurn(tracker, guard, stoppedNormally)
store.writeJson('envelope.json', saveEnvelope(tracker))

// Session fold:
const record = buildSessionRecord({
  sessionId, repo, model, usage: snapshot.usage, prompts: snapshot.prompts,
  requests: snapshot.usage.requests, turns: turnCount, nudges, aborts,
  injectedChars, overhead: {
    optimizer_tokens: injection.optimizer_tokens,
    spiral_judge_tokens: judgeTokens,
    spiral_nudge_writer_tokens: writerTokens,
  },
  untool: untoolState, untoolApplied,
})
store.appendJsonl('ledger.jsonl', record)
const summary = summarize(store.readJsonl('ledger.jsonl')) // print observed totals only
```

Judge adapter sketch (DSH side call is the adapter's job):

```js
const judge = {
  judge(digest) {
    const raw = sidecallOnce(buildStuckJudgePrompt(digest)) // host login/model, no key
    const verdict = parseStuckJudgeReply(raw)
    return verdict && { ...verdict, tokens: approxTokens(prompt) + 5 * approxTokens(raw) }
  },
  writer(digest) {
    const raw = sidecallOnce(buildNudgeWriterPrompt(digest))
    const text = parseNudgeWriterReply(raw)
    return text ? { text, tokens: /* measured or estimated */ 0 } : null
  },
}
```
A background adapter can instead supply `start`/`poll`; while a verdict is pending the
guard internally answers "throttled" and `JUDGE_STALE_S` stops a dead job from blocking.
Tokens the judge reports are accumulated on the turn (`judgeTokens`/`writerTokens`) and
belong in the ledger `overhead` keys; an outliving job should append its own
`kind: "overhead"` record via `buildOverheadRecord`.

## Upstream parity table (test → ported test)

| Upstream case (§9.3/§9.2) | Ported test |
|---|---|
| `test_edits_made_through_the_shell_are_recognised` (parametrized, 22 cases) | `shell-edits.test.js` — `guard.shellEditsRecognized` |
| shell edits reach state + ended-green proxy | `shell-edits.test.js` — `guard.shellEditsFeedProxy`; `guard.shellEditsFeedProxy` also in state suite |
| `test_reading_a_file_full_of_asserts_is_not_a_failure` | `state.test.js` + `guard.test.js` — `guard.contentToolNotFailure` |
| `test_the_judge_is_told_how_the_last_verification_went…` | `guard.test.js` — `guard.judgeDigestVerificationState` |
| `test_a_background_judge_starts_once_and_its_verdict_nudges_a_later_call` | `guard.test.js` — `guard.backgroundJudge` |
| `test_a_productive_verdict_backs_the_judge_off` | `guard.test.js` — `guard.judgeBackoff` (5 → 10) |
| `test_a_job_that_never_answers_stops_blocking_the_next_one` | `guard.test.js` — `guard.staleJudge` |
| `test_cold_start_never_intervenes` | `guard.test.js` — `guard.coldStartSpares` |
| `test_warm_guard_nudges_then_only_notifies_in_an_interactive_session` | `guard.test.js` — `guard.warmGuardNudgesThenOnlyNotifies` |
| `test_the_judge_is_not_asked_before_the_repository_is_learned` | `guard.test.js` — `guard.coldStartSpares` (judge calls = 0) |
| `test_a_long_turn_with_no_sign_of_trouble_never_wakes_the_judge` | `guard.test.js` — `guard.gateStaysClosed` |
| `test_only_turns_that_end_green_feed_the_envelope` | `guard.test.js` — `guard.envelopeOnlyGreen`; `envelope.test.js` — `envelope.recordTurn` |
| `test_a_small_envelopes_backstop_never_preempts_the_nudge` | `guard.test.js` — `guard.nudgeBeforeBackstop` (exact `[(14,nudge),(28,notice)]`) |
| `test_a_runner_named_by_path_counts_as_a_verification` + non-runner names | `guard.test.js` — `guard.verifyPathForms` |
| `test_a_test_run_whose_status_was_replaced…` / followed by other commands / other commands keep status | `guard.test.js` — `guard.statusOfTests` |
| `test_a_runners_summary_gives_its_verdict` (20 cases) | `guard.test.js` — `guard.runnerVerdict` |
| `test_ledger.py` (6 tests: overhead keys/numeric/effective/fallback/amortize) | `ledger.test.js` |
| `accounting.summarize` (upstream §6.4) | `accounting.test.js` |
| no-auto-stop invariant (§5.6) | `guard.test.js` — `guard.nudgesThenNotifies: the module only returns decisions` |

Additional coverage: tool canonicalization, failure signatures/stagnation, recent-log
cap, digest formatting, snapshot/serialization round-trips, JSON threshold presets,
`assessAbort` decision order (including judge-cannot-veto-backstop), verbatim nudge
template, percentile/clamps/learned floors/backstop cap, envelope document round-trip
and 500-sample cap, resolved-proxy edge cases, judge prompt/parser strictness,
pricing breakdown/fallback/no_usage and no-currency surface, record validation and
idempotent ledger merge, `fmtTokens`/`fmtPercent`, and "no fabricated savings".

## Exact-parity verification performed

Besides the ported tests, the exported constants and prompts were diffed
programmatically against the upstream Python objects (then the scratch comparison files
were removed):

- `DEFAULT_THRESHOLDS`, all three `SPIRAL_LEVELS` presets, `scaled_thresholds` for
  default/conservative/aggressive/unknown — JSON-identical.
- `nudge_text(new SpiralState())`, `STUCK_JUDGE_SYSTEM`, `NUDGE_WRITER_SYSTEM` —
  byte-identical strings.
- `ENVELOPE_HISTORY`, `JUDGE_BASE_GAP`, `JUDGE_MAX_GAP`, `JUDGE_STALE_S`,
  `OVERHEAD_KEYS`, `WEIGHTS_CLAUDE`, `FALLBACK_WEIGHTS` — identical.
- `VERIFY_RE.search(cmd)` on 14 commands, `runner_verdict` on 20 outputs,
  `status_of_tests` on 9 commands — identical booleans/`null`s/statuses.

## Simplifications / deviations from upstream

1. **No host transcript parsing.** Upstream's `completed_calls` (Copilot/Claude/Codex
   JSONL folding) is dropped; the DSH adapter supplies paired
   `{tool, args, resultText, failed, exitCode}` calls from `session/event`s.
2. **Host failure flag.** Upstream `TurnGuard.fold` derives `failed` only from the exit
   code. The DSH port uses the host's `isError` flag **only when no exit code was
   recovered** (so a failed `read` can count, matching `SpiralState.update` semantics).
3. **Action vocabulary.** Upstream returns `('nudge'|'abort', reason)` and the plugin
   delivers `abort` as a notice. Here `fold` returns `{action: 'nudge'|'notice',
   reason, text}`; `aborted`/`abort_delivered` are still tracked and `notice` is the
   terminal rung. `noticeText` has no per-host stop hint — the adapter appends it.
4. **Live-plugin pins in a helper.** `gate_over_envelope=false` and
   `gate_min_turns=max(gate_min_turns,min_turns)` live in `pinLiveThresholds`, matching
   `plugin/controller.py:314-320`; `assessAbort` keeps upstream's harness default
   (`gate_over_envelope` true) for parity.
5. **Cold-start safeguard inside the guard.** The guard ignores a supplied judge while
   `envelope === null` (upstream does this in the controller), so a cold repository
   cannot pay for a judge call and never intervenes.
6. **Nudge auto-applies `afterNudge`.** Upstream's controller calls `nudge_body` then
   `after_nudge`; the DSH guard computes the redirect and resets the segment before
   returning, because its decision already carries the text. `afterNudge()` remains
   exported for an adapter that builds its own redirect.
7. **Judge interface is injected and simpler.** Sync `judge(digest)` and background
   `start`/`poll` are both accepted; the upstream detached-process plumbing
   (`AsyncJudge`, sidecall CLI) is the adapter's job. Staleness uses an explicit `now`.
8. **Envelope persistence is pure.** `loadEnvelope`/`saveEnvelope` take/return the JSON
   document; locking and writing go through `lib/store.js`. The in-memory history is
   trimmed to `ENVELOPE_HISTORY` too (upstream trims only on save).
9. **Shell tokenizer.** Hand-written (no `shlex` in Node). It reproduces the upstream
   non-POSIX tokenization on all 22 upstream cases, with two deliberate changes: every
   newline is its own operator token (upstream can fuse a blank line into one run and
   merge commands), and Windows `\` separators are accepted in basenames.
10. **Judge reply parsers are stricter than upstream.** Upstream coerces with
    `bool()`/`float()` and keeps defaults on a parse error; this port returns `null` for
    a wrong-shaped reply, which the guard already treats as "throttled → spare".
11. **Usage weights.** No embedded vendor price/currency table is shipped (upstream
    embeds a dated `MODEL_WEIGHTS` snapshot). Only the two accounting ratio curves are
    ported: `WEIGHTS_CLAUDE` for recognisable Claude ids (and the legacy no-id path) and
    the labeled `FALLBACK_WEIGHTS` (output 6.0) for every other billed id. No DeepSeek
    price is claimed; `priced_by` makes the distinction visible in every record.
12. **`SpiralState.update` tolerates `0`/`1`** for `failed` (some hosts report numeric
    exit-ish flags), treating them as `false`/`true`. Booleans behave exactly upstream.
13. **Reasoning tokens.** DSH `reasoningTokens` are accepted by the adapter's usage
    object but are **not** part of the §6.3 record or the effective formula (upstream's
    schema has no such field). Whether the host bills reasoning inside
    `output_tokens` is UNKNOWN; the adapter must not fold it in speculatively.

## Tests

Command (from `dsh-tokeneconomizer/`):

```
node --test --test-isolation=none "test/unit/loopguard/*.test.js" "test/unit/usage/*.test.js"
```

Result: **110 tests, 110 pass, 0 fail** (77 loop-guard + 33 usage).

| File | Tests |
|---|---|
| `test/unit/loopguard/state.test.js` | 15 |
| `test/unit/loopguard/shell-edits.test.js` | 6 |
| `test/unit/loopguard/rules.test.js` | 16 |
| `test/unit/loopguard/envelope.test.js` | 14 |
| `test/unit/loopguard/guard.test.js` | 21 |
| `test/unit/loopguard/judge.test.js` | 5 |
| `test/unit/usage/pricing.test.js` | 9 |
| `test/unit/usage/ledger.test.js` | 15 |
| `test/unit/usage/accounting.test.js` | 9 |

`node node_modules/typescript/bin/tsc -p jsconfig.json --noEmit` reports **no errors in
`lib/loopguard/**`, `lib/usage/**`, `test/unit/loopguard/**` or
`test/unit/usage/**`** (remaining project errors at the time of writing are in other
teammates' in-flight files).

## UNKNOWNs / open questions for the adapter

1. **Judge/writer token cost.** Upstream charges the effective cost its side-call runner
   recovered (or an uncached prompt×1 + reply×5 estimate). The DSH adapter must supply
   a real or explicitly estimated number on the verdict (`tokens` / `_tokens`); this
   module only sums what it is given and never guesses.
2. **DSH tool-name coverage.** `canonTool` covers upstream names plus the common DSH
   built-in/ops spellings listed above and passes unknown names through. MCP/custom
   tool names that should count as `bash`/edit/read must be pre-mapped by the adapter
   (e.g. through `lib/dsh/normalize.toolFamily`) before `fold`.
3. **`isError` semantics.** Whether every DSH tool sets `isError` the way upstream's
   failure flag means (tool error / non-zero exit) is assumed, not proven; the guard
   only consults it when no exit code was recovered.
4. **External `loopguardJudgeMinIntervalMs`.** `lib/config.js` exposes a wall-clock
   minimum judge interval; upstream's guard rate limit is in tool calls
   (`JUDGE_BASE_GAP`). The adapter owns reconciling the two (this module implements the
   upstream cadence).
5. **`reasoningTokens` billing** (see deviation 13) — unknown; recorded nowhere.
6. **Subagent sessions.** Upstream never feeds subagent calls to the guard
   (`test_live_hooks.py` §5.7). The DSH adapter must skip `origin === 'subagent'`
   sessions/agents; this module has no notion of agent identity.
7. **Where notices are shown** and what "how to stop" hint each DSH mode needs is a
   host/UX decision (upstream per-host table); the guard supplies the measurement only.
