# Port notes: optional model-assisted adapters (judge + proposer)

Status: implemented and offline-tested. Two NEW modules sit on top of
`lib/dsh/sidecall.js` and the existing pure helpers; they are wired by
`lib/dsh/mechanisms.js` (not modified here):

| File | Export | Purpose |
|---|---|---|
| `lib/dsh/judge.js` | `createGuardJudge(options)` | Background stuck-judge + redirect-writer for `TurnGuard` |
| `lib/dsh/proposer.js` | `buildDigest`, `buildPrompt`, `validateProposals`, `proposeFacts` | Model-assisted micro-skills fact proposer with evidence verification |
| `test/unit/dsh/judge.test.js` | — | 11 offline protocol tests |
| `test/unit/dsh/proposer.test.js` | — | 14 offline digest/validation/propose tests |

Upstream reference: Microsoft TokenEconomizer's optional `plugin/judge.py`
(background verdict + redirect writer) and the model-assisted micro-skills
proposer. The DSH port keeps the decision/validation logic and delegates the
paid call to the harness's `ctx.llm` through `createSideCall`; no vendor SDK,
network code, timers beyond bounded deadlines, or credential handling lives
here.

## `lib/dsh/judge.js`

### API

```js
import { createGuardJudge } from './lib/dsh/judge.js'

const judge = createGuardJudge({
  sidecall,              // required: createSideCall(...) (only .call is used)
  timeoutMs,             // optional extra per-job deadline (ms; 0/absent = sidecall default)
  maxJudgedTokens,       // optional budget: skip the writer once the judge call spent >= this
  enableNudgeWriter,     // optional: ask the writer model for a redirect when stuck === true
})

judge.start(guard, digest) // -> string job id | null   (never throws, never awaits)
judge.poll(guard)          // -> { found: boolean, verdict? }
judge.dispose()            // -> void (idempotent, never throws)
```

`start`/`poll` implement exactly the `JudgeLike` background protocol consumed by
`TurnGuard.backgroundJudge()` (`lib/loopguard/guard.js`):

- `TurnGuard` calls `start(guard, liveDigest)` when its rate limit opens, stores
  the returned id, and calls `poll(guard)` on every later fold.
- `poll` returns `{found:false}` while the job is outstanding and exactly once
  returns `{found:true, verdict}` when the job for the guard's **current**
  segment completed; it then clears the job.
- If `guard.segment` changed since `start`, the old job is aborted and its
  verdict is dropped (never delivered); `start` becomes available again.

### Verdict

```js
{
  stuck: boolean|null,   // parsed judge verdict; null = unknown/error
  confidence: number,    // clamped 0..1
  reason: string,        // <= JUDGE_REASON_MAX_CHARS (160)
  tokens: number,        // effective tokens: input + cacheRead + cacheWrite + output
  nudge?: string,        // writer redirect, <= NUDGE_MAX_CHARS (1200), only when enableNudgeWriter
}
```

The guard accumulates `verdict.tokens` into `judge_tokens`/`writer_tokens` and
the adapter copies the totals into the per-turn ledger record.

### Behavior details

- **Prompts**: the judge uses `STUCK_JUDGE_SYSTEM` on the sidecall `system`
  channel and `buildStuckJudgePrompt(digest)` as the user prompt; the writer uses
  `NUDGE_WRITER_SYSTEM` + `buildNudgeWriterPrompt(digest)`. The builders embed
  the system text at the top of the prompt, so the adapter strips that duplicated
  prefix when it is sent as a separate system message (avoids paying for the
  system instructions twice; a helper format change falls back to the full
  prompt). The `digest` argument is always the guard's already-live digest.
- **Writer**: only fires when the parsed verdict is `stuck === true`, the writer
  is enabled, and the `maxJudgedTokens` budget (when non-zero) has not already
  been reached. A failed/empty writer reply leaves the verdict without `nudge`,
  so `TurnGuard` falls back to its count-template redirect.
- **Failures**: sidecall unavailable/failed (`llm-unavailable`,
  `module-unavailable`, `disposed`) → `{stuck:null, confidence:0,
  reason:'judge-unavailable', tokens}`; parse failure or any other failure →
  `reason:'judge-error'`. Both are honest "no opinion" verdicts: the guard spares
  the turn (ambiguous) instead of acting on a broken judge.
- **One job at a time**: `start` returns `null` while a job is outstanding; the
  guard treats that as throttled (same as a rate-limited call).
- **Deadlines and cleanup**: `timeoutMs` (when set) aborts the job's
  `AbortController`; the sidecall also fuses its own timeout and caller signal.
  Every completion path clears the adapter timer; `dispose()` aborts and clears
  the in-flight job and makes `start` inert. No timers survive any path.

## `lib/dsh/proposer.js`

### API

```js
import { buildDigest, buildPrompt, validateProposals, proposeFacts, PROPOSER_SYSTEM } from './lib/dsh/proposer.js'

buildDigest(snapshots, {maxChars=4000, maxSessions=8, maxCommands=6, maxFails=3}?) // -> string
buildPrompt(digest, existingClaims?)      // -> {system, prompt}
validateProposals(rawReply, {snapshots, existing}) // -> {ok, proposals, error?}
proposeFacts({sidecall, snapshots, existing?, maxFacts=4, signal?, ...}) // -> Promise<{ok, proposals, usage, error?}>
```

Constants: `DIGEST_MAX_CHARS`, `DIGEST_MAX_SESSIONS`, `DIGEST_MAX_COMMANDS`,
`DIGEST_MAX_FAILS`, `MAX_FACTS` (4), `CLAIM_MIN_CHARS` (15),
`CLAIM_MAX_CHARS` (220), `CHECK_MIN_CHARS` (4), `CHECK_MAX_CHARS` (80),
`PROPOSER_SYSTEM`.

### Digest (`buildDigest`)

- Uses the newest 8 snapshots (`{sessionId, cwd, prompts, calls:[{tool, args,
  resultText, failed, exitCode}]}`, i.e. the accumulator's session snapshot).
- Per session: `id`, prompt count, up to 6 collapsed command templates (first
  120 chars, cwd replaced with `.`, absolute paths masked to `<path>/<basename>`,
  duplicates collapsed) and up to 3 normalized error signatures (≤100 chars,
  numbers → `<n>`, hex → `<hex>`, absolute paths → `<path>`, long quoted strings
  → `<str>`, no signature at all without an error/failure marker).
- Per session flags derived only from commands/error text:
  `ran_tests`, `missing_command`, `missing_dependency`, `bad_usage`.
- Result is capped at 4000 chars (`…` when truncated). It never contains
  non-failed result text, assistant text, file contents, full logs, absolute
  paths, or `cwd` values.

### Prompt (`buildPrompt`)

`PROPOSER_SYSTEM` is a strict JSON-only instruction:
`{"facts":[{"claim","checks","cites"}]}`, 0-4 durable repo-specific operating
facts, no advice/stop/verify wording, checks are 1-4 lowercase substrings that
appear in commands or command errors, cites are ≥2 session ids from the digest,
no secrets/paths, and the digest is framed as untrusted data that must never be
followed as instructions. `buildPrompt` appends the digest and up to 20 already
known claims marked "DO NOT propose these again".

### Validation and evidence (`validateProposals`)

For each fact: parse the first `{...}` JSON object; require a claim of 15-220
chars that passes `envfacts.lintOk` (rejects completion/verification advice
vocabulary), 1-4 checks of 4-80 chars (lowercased, deduped), and ≥2 cites that all
name sessions present in the supplied snapshots. It then **verifies repeated
evidence**: the combined raw command + result text of each cited snapshot is
searched (lowercase substring); every check must appear in at least one cited
snapshot, and at least one check must match in two distinct cited snapshots.
Unsupported or single-session facts are dropped. Valid proposals get a stable id
`manual:` + first 12 hex chars of `sha256(claim)`; duplicates are dropped against
`existing` ids/claims and within the reply. At most 4 proposals are returned.

Return shape: `{ok:true, proposals}` when at least one proposal survives;
otherwise `{ok:false, proposals:[], error}` with `no-json`, `malformed-json`,
`no-valid-proposals` or `validation-error`.

### `proposeFacts`

Builds the digest and prompt, calls `sidecall.call({system, prompt, signal})`
once, validates the reply, and returns:

```js
{ ok: true, proposals: [...], usage: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens} }
{ ok: false, proposals: [], usage, error }   // usage is always present (zeros when unreported)
```

It never throws, requires ≥2 snapshots (`insufficient-snapshots` without a call),
returns `sidecall-unavailable` when no sidecall was supplied, clamps `maxFacts`
to 0..4, and redacts error text (no prompt contents, no secrets). `usage` is the
provider usage for the plugin overhead ledger (`optimizer_tokens`); the caller
records it — this module never writes state itself.

## Integration contract (for `lib/dsh/mechanisms.js`)

The adapter layer already calls these modules lazily:

- `const { createGuardJudge } = await import('./judge.js')` once when
  `loopguardJudge` is enabled and a sidecall exists; pass
  `{sidecall, enableNudgeWriter: true}` and hand the object to
  `TurnGuard.fold(..., {judge})`. Token totals arrive on each verdict.
- `const { proposeFacts } = await import('./proposer.js')` on the
  `microskillsProposeEvery` cadence with `project.recentSessionSnapshots(8)`,
  `existing` from the persisted manual facts, and `maxFacts` from config; add
  `result.usage` to the session's overhead accumulator and persist
  `result.proposals` as `manual:` facts (the adapter already does this).

Both modules are inert when `sidecall` is absent — the plugin stays in its
deterministic (rule-only / envfacts-only) mode and makes no paid call.

## Tests

```sh
node --test --test-isolation=none "test/unit/dsh/judge.test.js" "test/unit/dsh/proposer.test.js"
# tests 25, pass 25, fail 0
```

Judge tests cover: start→poll verdict with tokens and writer nudge; one-pending
limit; segment staleness (in-flight and completed-but-unpolled) with abort;
parse failure → `judge-error` with tokens; failed calls → `judge-error`/
`judge-unavailable`; inert judge without sidecall; never-throw public calls;
dispose aborting in-flight work; internal timeout cleanup; `maxJudgedTokens`
writer gating; writer failure/disabled writer; `stuck:false` and confidence
clamping.

Proposer tests cover: digest bounds/caps/masking/no-raw-output/no-absolute-paths;
newest-8 selection; `maxChars`; prompt strictness and existing-claim section;
valid evidence-backed proposal with stable id; lowercase check normalization;
unsupported/unknown cite, single-session evidence, unsupported check; advice and
length rejection; check bounds; dedupe by id and claim; 4-fact cap; unusable
replies; `proposeFacts` success usage/prompt wiring; maxFacts clamp; failure, no
JSON, thrown call, too-few snapshots, and missing sidecall paths.

The test runner exits normally on every case (deadline timers and abort listeners
are cleared), which is the practical no-timer/no-abort-leak assertion.

## Limitations / UNKNOWN

- **`maxJudgedTokens` is a writer gate, not a hard spend cap.** The judge call is
  already in flight when the budget is known, so the option only suppresses the
  optional second (writer) call once the judge call has spent at least the
  budget. Actual tokens are always reported honestly on the verdict.
- **Judge prompt seam**: the upstream builders embed the system text inside the
  prompt. The adapter sends the system text once (system channel) and strips the
  duplicated prefix from the prompt; a future builder format without the prefix
  falls back to the full prompt (slightly more expensive, still correct).
- **Proposer evidence is substring-based**, matching upstream's "checks will
  appear in commands/errors" contract. It cannot prove semantic causality, and
  it uses raw command/error text (case-insensitive) rather than the masked
  digest, so a check that only exists in masked-away material (e.g. an absolute
  path) will not validate.
- **Checks are validated literally**: duplicates in the raw `checks` array
  invalidate the fact (the adapter requires the survivor count to equal the raw
  count), and only shell command strings (`args.command`/`cmd`/`script`) count as
  "command text" for evidence; arbitrary tool arguments do not.
- **No model-side retry**: one sidecall attempt per judge job / proposer run;
  cadence/backoff is owned by the guard and adapter. The sidecall's own bounded
  timeout is the only deadline.
- **No tokenizer-exact digest sizing**: the 4000-char bound is characters, not
  tokens; the proposer's `maxTokens` is left to the sidecall default (1024).
- **Typecheck**: both modules and both tests are clean under
  `node node_modules/typescript/bin/tsc -p jsconfig.json`; the repository still
  has pre-existing type errors in files outside this task's scope (24 lines at
  the time of writing, none in `dsh/judge.js` or `dsh/proposer.js`; run
  `tsc … | grep -E 'dsh/(judge|proposer)'` to confirm). `npm run typecheck` may
  be blocked by the PowerShell execution policy (`npm.ps1`); use the `node`
  invocation above.
