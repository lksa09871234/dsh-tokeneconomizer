# Port notes: tool-pruning core

Status: implemented (`lib/toolprune/`), tests green. Porting source of truth:
`research/UPSTREAM.md` §§ 2.7, 4, 8, 9.4, 10, 11, plus upstream
`tokeneconomizer/toolprune/{tools,stage}.py`,
`tokeneconomizer/plugin/fold.py` (`_fold_toolprune`, `enough_evidence`,
`apply_pending`) and `tokeneconomizer/plugin/denylist.py` (policy half only).
Upstream: microsoft/TokenEconomizer @
`e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9`, Apache-2.0.

## Scope: policy core only

The DSH port keeps the **decision** layer and drops the **host writer** layer:

| Upstream | DSH port |
|---|---|
| evidence counters in `ToolingStage` / `_fold_toolprune` | `lib/toolprune/evidence.js` (pure) |
| proposal hold / quiet period / apply / restore in `plugin/fold.py` + `plugin/denylist.py` | `lib/toolprune/policy.js` (pure) |
| host-specific deny-list writers (Claude `permissions.deny` JSON, Codex `config.toml`, Copilot MCP servers) | **not ported**; `lib/toolprune/denylist.js` only returns the deny set. The DSH adapter writes it with the harness's own tool-restriction mechanism (e.g. a `{ deny: [...] }` mask passed to `tools.restrict()`), and must remove only the plugin's own entries on restore. |
| optional per-task LLM tool judge (`toolprune/tools.py:judge_tools_for_task`) | **not ported** (no problem-statement source at pruning time in DSH); `toolprune/tools.py`'s judge prompt is not shipped. |
| Codex capability packages (`toolprune/codex.py`) / Copilot whole MCP servers | **not ported**; the DSH unit is a single tool name. |
| per-host catalog parsers (`trace/catalog.py`) | **not ported**; the DSH adapter supplies `catalog: {tools, descriptions, source}` from the DSH tool registry. |

No filesystem access, no timers, no global state: every function is a pure
JSON-in/JSON-out transform, and every timestamp is an explicit `now`
(Unix seconds). This is what lets the mechanisms be unit-tested against
upstream's behavior without a host.

## Modules and exported API

### `lib/toolprune/tools.js`

Constants and protected-set helpers.

- `HIGH_RISK_FACTOR = 3` — evidence multiplier for high-risk tools.
- `PROTECTED_TOOLS` — frozen list of work-surface names: DSH names (`bash`,
  `pwsh`, `ops_bash`, `read`, `write`, `edit`, `multi_edit`, `glob`, `grep`,
  `read_file`, `list_dir`, `run_code`, `web_search`, `web_fetch`) plus the
  upstream spellings as aliases (`shell`, `view`, `create`, `str_replace`,
  `apply_patch`, `Bash`, `Edit`, …). Upstream: `toolprune/tools.py:40-48`.
- `HIGH_RISK_TOOLS` — `Set {'NotebookEdit', 'notebook_edit'}` (upstream
  `plugin/adapter.py:59-61`).
- `INAPPLICABLE_TOOLS` — documented set of orchestration/scheduling/memory/
  interactive names (DSH + upstream); the module does not prune them by itself.
- `effectiveProtectedTools(extra?) -> Set<string>`
- `isProtectedTool(name, extra?) -> boolean`
- `isHighRiskTool(name) -> boolean`

The DSH adapter should extend the protected set with the profile's
`protectedTools` configuration and, in practice, prune only optional/MCP tools
(the default set protects every core work tool).

### `lib/toolprune/evidence.js`

The persisted document (upstream `untool.json` field names):

```jsonc
{
  "used_tools": ["bash"],              // every tool ever used, sorted
  "streaks": {"Notebook": 2},         // consecutive folded sessions unused
  "prompt_streaks": {"Notebook": 10}, // unused prompts accumulated
  "catalog_tools": ["bash", "Notebook"],
  "catalog_desc": {"Notebook": "..."},
  "catalog_source": "dsh-tool-registry" | null,
  "sessions": 2,
  "prompts": 10,
  "updated": 1700000000,
  "proposal": ["Notebook"],
  "new_in_proposal": ["Notebook"],
  "restored_protected": [],
  "auto_pending": {"items": ["Notebook"], "root": "/repo", "since": 1700000000} | null,
  "auto_applied": ["Notebook"] | null,
  "auto_apply_refused": null,
  // DSH extension (upstream keeps these in the host deny-list record):
  "applied": ["Notebook"],            // the plugin's own deny entries
  "kept": []                          // given back by the person; never proposed again
}
```

Exports:

- `DEFAULT_THRESHOLDS` = `{evidence: 10, minSessions: 2, sessions: 5, quietMinutes: 60, pendingMaxSeconds: 86400}` (upstream p=10, m=2, s=5, q=60 min, 24 h cap).
- `createState(partial?) -> ToolPruneState` — normalize a fresh/partial doc.
- `normalizeState(raw) -> ToolPruneState` — tolerant coercion (used on load).
- `fromJSON(raw) -> ToolPruneState` / `toJSON(state) -> ToolPruneState` — adapter persistence helpers.
- `cloneState(state)`.
- `normalizeThresholds(partial?) -> ToolpruneThresholds`.
- `enoughEvidence(unusedSessions, unusedPrompts, thresholds?, highRisk?) -> boolean` — the upstream formula:
  `(sessions >= m && prompts >= p*k) || sessions >= s*k`, `k=3` high-risk, else 1.
- `computeProposal(state, options) -> string[]` — recompute without folding.
- `foldSession(state, session, options) -> ToolPruneState` — fold one finished
  session. `session = {toolsUsed?, catalog?: {tools, descriptions, source}|null, prompts?}`,
  `options = {now, thresholds?, protectedTools?, highRiskTools?}`.

Rules encoded (upstream citations in the module header):

- a session with `prompts === 0` changes nothing (no evidence at all);
- `null`/unknown prompts count as one;
- streak: used **this session** -> 0, else +1; prompt streak: reset when used,
  else `+= prompts`;
- catalog accumulates; a missing catalog does **not** mean "no tools loaded" —
  the prior catalog is kept;
- a tool ever used is never proposed; protected/applied/kept tools are never
  proposed; insufficient evidence yields `proposal: []`.

### `lib/toolprune/policy.js`

The proposal/quiet-period/apply/restore state machine, pure over the same doc.

- `holdProposal(state, {mode, now, root?}) -> ToolPruneState`
  - `apply` mode with a non-empty proposal records
    `auto_pending = {items, root, since}` and preserves an existing `since`;
  - `propose`/`off` mode clears any pending list and never touches `applied`.
- `shouldApply(state, {now, lastActivity?, quietMinutes?, pendingMaxSeconds?, mode?}) -> {apply, items, reason, waitSeconds}`
  - waits while `idle < q*60` **and** `waited < 24 h`;
  - applies once idle for q minutes (`reason: 'idle'`) or when the list is older
    than the cap (`reason: 'pending-max-age'`);
  - `reason` values: `idle`, `pending-max-age`, `waiting`, `no-pending`,
    `nothing-pending`, `mode`.
- `markApplied(state, {items, now})` — moves items into `applied`, removes them
  from `proposal`, records `auto_applied`, clears `auto_pending`/refusal.
- `markRefused(state, {error})` — records `auto_apply_refused`, clears
  `auto_pending`, **keeps** the proposal for a later retry.
- `restoreTools(state, tools)` — removes applied entries and adds them to
  `kept` (given back forever).
- `restoreProtectedTools(state, {protectedTools?})` — takes back entries for
  tools that have become protected; reports them in `restored_protected`.
- `givenBack(state) -> string[]`, `pendingItems(state) -> string[]`.

### `lib/toolprune/denylist.js`

The DSH deny-list model (policy only).

- `computeDenyList(state, {protectedTools?}) -> {deny, skippedProtected, applied, kept}`
  — `deny` is the sorted list the adapter should write; protected entries are
  skipped and reported instead of silently kept.
- `appliedFor(state)` / `keptFor(state)` — upstream accessors.
- `isDenied(tool, state, {protectedTools?})`.
- `mergeProtectedTools(extra?) -> string[]` — sorted union of defaults + config.
- `DEFAULT_PROTECTED_TOOLS` re-export.

## Wiring recipe for the DSH adapter

Session end (one fold; skip entirely when the mechanism is `off` **only for
writes** — upstream keeps accruing evidence when pruning is off, which is why
adapters should still fold while `toolprune: 'off'` if they want a later switch
to start from existing evidence):

```js
let state = evidence.fromJSON(store.readJson('untool.json', {}, isObject))
state = evidence.foldSession(state, observation, {
  now,
  thresholds: {
    evidence: config.toolpruneEvidence,
    minSessions: config.toolpruneMinSessions,
    sessions: config.toolpruneSessions,
    quietMinutes: config.toolpruneQuietMinutes,
  },
  protectedTools: config.protectedTools,
})
state = policy.restoreProtectedTools(state, { protectedTools: config.protectedTools })
state = policy.holdProposal(state, { mode: config.toolprune, now, root: repoRoot })
store.writeJson('untool.json', evidence.toJSON(state))

const decision = policy.shouldApply(state, {
  now, lastActivity: lastSessionActivity, mode: config.toolprune,
  quietMinutes: config.toolpruneQuietMinutes,
})
if (decision.apply) {
  const deny = denylist.computeDenyList(state, { protectedTools: config.protectedTools }).deny
  const ok = await adapter.writeDenyList(deny) // DSH tool restriction; plugin's own entries only
  state = ok
    ? policy.markApplied(state, { items: decision.items, now })
    : policy.markRefused(state, { error: String(adapter.lastError ?? 'write failed') })
  store.writeJson('untool.json', evidence.toJSON(state))
}
```

Restore command: `state = policy.restoreTools(state, tools)`, then the adapter
removes only the plugin's own entries; `kept` guarantees they are never
proposed again. Status command: `proposal`, `appliedFor`, `keptFor`,
`pendingItems`, `new_in_proposal`, plus the counters.

`lastActivity` is the adapter's job: upstream uses the newest mtime among the
project's session records and their transcripts (`plugin/fold.py:290-309`). The
DSH adapter should use the newest DSH session event timestamp it can read
cheaply, and pass `0` when none exists (then the list applies at once).

Observation shape the adapter must supply:

- `toolsUsed`: tool names called in the session (any invocation counts as use);
- `catalog`: the full set of tools the session was offered, from the DSH tool
  registry, with descriptions when available and a `source` label. Pass `null`
  when the session ran under an applied mask or the catalog could not be read —
  **not** `{tools: []}`, which would be an empty-but-known catalog;
- `prompts`: DSH user-prompt count, `null` when unknown, `0` for a session that
  ran no prompt (e.g. a resumed session with no new input) which must not count
  as evidence.

## Deviations from upstream (all deliberate)

1. **One state document.** Upstream keeps evidence in `untool.json` and the
   applied/kept records in the host settings file's own records
   (`denylist.applied_for/kept_for`). The DSH port keeps `applied`/`kept` in
   the same JSON document; field names for evidence and pending are upstream's.
2. **`restored_protected` is always present** (empty array when nothing was
   restored) so the adapter has a stable schema; upstream omits the key.
3. **`updated`/`since` are explicit `now` values.** Upstream reads
   `time.time()` inside the fold; the pure core never reads the clock. The
   adapter passes real time.
4. **No host writer, no LLM judge, no Codex capabilities / Copilot servers.**
   See scope table above.
5. **Configurable high-risk additions** (`highRiskTools` option) and protected
   extensions (`protectedTools`) — upstream's high-risk set is hard-coded to
   `NotebookEdit`; the factor stays 3.
6. **`auto_pending` is cleared whenever the mechanism leaves `apply` mode**
   (upstream's `apply_pending` does this implicitly on the next waiter run;
   the pure function makes it explicit and testable).
7. **Pending list filtering at decision time**: `shouldApply` re-filters items
   against `applied`/`kept` (upstream does the same in `apply_pending`,
   `plugin/fold.py:324-326`), and `restoreTools` also removes restored tools
   from the proposal immediately.

## Tests

Run:

```sh
node --test --test-isolation=none "test/unit/toolprune/*.test.js"
```

49 tests, all passing (4 files):

- `tools.test.js` — protected defaults/aliases/extensions, inapplicable set
  semantics, `HIGH_RISK_FACTOR === 3`, high-risk names.
- `evidence.test.js` — schema roundtrip; m=2 floor; p=10 over m=2; nine-prompt
  boundary; s=5 OR branch; no-prompt session is no evidence; unknown prompts
  count as 1; high-risk 3× both branches + configured high-risk names;
  protected never proposed; ever-used never proposed; applied/kept excluded;
  `new_in_proposal` delta; catalog accumulation/descriptions/source; use
  resets streak; unknown catalog keeps prior; purity; threshold overrides;
  direct `enoughEvidence` table.
- `policy.test.js` — hold in apply mode, `since` preservation, propose mode
  never holds/applies, mode switch drops pending (upstream `test_live_hooks.py:744`),
  empty proposal clears pending, quiet-period wait/apply, q=0, 24 h cap,
  markApplied, markRefused keeps proposal, restore marks kept, given-back never
  re-proposed, protected restore, pending filtering.
- `denylist.test.js` — deny derivation, protected force-keep (defaults +
  config), `applied_for`/`kept_for`, `isDenied`, protected merge.

The JS tests map to upstream `tests/test_live_hooks.py` cases `:497`
(propose mode doesn't write), `:520` (apply), `:547` (given back stays back),
`:591` (p=10 over m=2), `:613` (s=5), `:623` (no-prompt session), `:633`
(high-risk 3×), `:644` (protected), `:683`/`:714`/`:728` (quiet period and cap),
`:737` (pending filtering), plus the unit rules from `test_ledger.py`-style
table tests.

## Type checking

`npx tsc --noEmit` scoped to the four modules and four test files passes clean
with `--strict`. The project-wide `tsc -p jsconfig.json --noEmit` currently
crashes inside TypeScript (`getMembersOfSymbol … reading 'flags'`) before
reporting diagnostics; this is pre-existing scaffolding (it reproduces without
the toolprune files and involves the `@deepseek-ai/schemastery` path mapping in
`lib/config.js`) and should be fixed/owned by the Lead, not by this module.

## Remaining gaps / UNKNOWNs

- **Adapter writer contract**: how the DSH adapter applies/removes a deny list
  (tool-restriction API, per-agent scope, persistence across profile reloads)
  is not specified here; upstream's verified-writer details are in
  `tokeneconomizer/plugin/denylist.py` and are intentionally not ported.
- **Prompt counting**: the adapter must define what a "prompt" is in DSH
  (upstream: host log `prompt_count`, `plugin/fold.py:376-380`; a resumed
  session's prompt count is host-defined).
- **Catalog semantics**: which DSH tools are "loaded" (core tools are always
  present; optional/MCP tools are the real pruning candidates) is an adapter
  decision; pass `null` when unknown rather than an empty catalog.
- **Status lines/announcements** (upstream `systemMessage` one-liners) are the
  adapter/CLI layer's job; this core returns the state to render them from.
