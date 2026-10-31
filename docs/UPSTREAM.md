# Upstream porting specification (maintainer reference)

This document is the implementation-grade porting record produced from the upstream
TokenEconomizer source at commit `e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9`
(Apache-2.0). It is kept in the repository so maintainers can check every threshold and
behavior of the port against its source. Citations of the form `path:line` refer to the
upstream checkout at that commit; internal research artifacts and machine-specific paths
have been replaced with placeholders and are not part of this repository.

---

# TokenEconomizer → DSH plugin: implementation-grade porting specification

Status: DRAFT (sections filled incrementally by researcher-upstream; task-2)

Upstream source: `upstream-te/` (full repo tarball, read-only; DO NOT modify).
All `file:line` citations below are relative to `upstream-te/` unless stated otherwise.

---

## 1. PROVENANCE & LICENSE

### 1.1 Exact upstream identity

| Fact | Value | Citation |
|---|---|---|
| Repository | `https://github.com/microsoft/TokenEconomizer` | `README.md:123`, `package.json:13` |
| Commit | `e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9` (2026-10-30, "Merge pull request #89 from microsoft/fix-claude-sidecall-mcp") | task brief; extracted tarball |
| Package name/version | `tokeneconomizer` 0.1.0 | `pyproject.toml:6-7`; `package.json:2-3` |
| Python | >= 3.10, **stdlib only** (zero runtime deps) | `pyproject.toml:10,15-18` |
| License | Apache License 2.0 (SPDX `Apache-2.0`) | `LICENSE:1-202`; `pyproject.toml:11`; `package.json:12`; `README.md:386-388` |
| Paper | "TokenEconomizer: Experience-Driven Black-Box Cost Control for Coding Agents", arXiv 2610.22732 (Li, Xu, Singh, Chen, Inala, Siska, Tamersoy, Yu, Stoica, Galley, Gao; UC Berkeley + Microsoft Research + Microsoft Security) | `README.md:1-27,370-384` |
| Project page | `https://tokeneconomizer.github.io` | `README.md:23` |
| NOTICE file | **None** in the tree (verified: only `LICENSE` at root; no `NOTICE*`) | `find`/grep over repo |
| Per-file copyright headers | **None**; `grep -r Copyright` matches only `LICENSE` text | source-wide grep |
| Bundled third-party data | `tokeneconomizer/trace/claude_tool_catalog.json` (a Claude Code tool-description snapshot; `pyproject.toml:58-60` package-data) | `trace/catalog.py` headers |

### 1.2 What Apache-2.0 requires of this port (quoted)

`LICENSE:90-122` (§4, Redistribution):

> 4. Redistribution. You may reproduce and distribute copies of the Work or Derivative Works
> thereof in any medium, with or without modifications, and in Source or Object form, provided
> that You meet the following conditions:
> (a) You must give any other recipients of the Work or Derivative Works a copy of this License; and
> (b) You must cause any modified files to carry prominent notices stating that You changed the
> files; and
> (c) You must retain, in the Source form of any Derivative Works that You distribute, all
> copyright, patent, trademark, and attribution notices from the Source form of the Work,
> excluding those notices that do not pertain to any part of the Derivative Works; and
> (d) If the Work includes a "NOTICE" text file as part of its distribution, then any Derivative
> Works that You distribute must include a readable copy of the attribution notices contained
> within such NOTICE file … (there is **no NOTICE file** upstream, so (d) is vacuous here;
> including an attribution file is still good practice).

Trademark (`LICENSE:139-142`, §6):

> 6. Trademarks. This License does not grant permission to use the trade names, trademarks,
> service marks, or product names of the Licensor, except as required for reasonable and customary
> use in describing the origin of the Work and reproducing the content of the NOTICE file.

Warranty/liability disclaimers (`LICENSE:144-165`, §§7-8): "AS IS" basis, no warranty; no
liability. Patent grant: §3 (`LICENSE:74-88`). Contribution terms: §5 (`LICENSE:131-137`).

### 1.3 Concrete obligations for the DSH port (a Derivative Work)

1. **Copy `LICENSE` verbatim** into the DSH plugin repo (e.g. `LICENSE` or
   `LICENSES/tokeneconomizer-LICENSE`), and state "Apache-2.0" in `package.json` +
   `README`. §2 grants the right to prepare Derivative Works; §4(a) requires shipping the
   license text to every recipient.
2. **Attribute the origin**, e.g. in `README` and in a `NOTICE`-style file:
   `Portions derived from microsoft/TokenEconomizer (https://github.com/microsoft/TokenEconomizer) at commit e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9, Copyright (c) TokenEconomizer authors, licensed under Apache-2.0.`
   (Upstream has no per-file copyright headers and no NOTICE; the authors are named in
   `pyproject.toml:12` as "TokenEconomizer authors" and in the paper author list. This is not
   legal advice — if the port ships commercially, have counsel confirm the copyright-holder
   line; Microsoft's public Apache-2.0 release is the grant.)
3. **Modified-file notices** (§4(b)): since we are translating Python → JavaScript, *every*
   ported file is modified. Put a header comment in each ported source file, e.g.
   `// Ported from tokeneconomizer/microskills/envfacts.py (Apache-2.0, microsoft/TokenEconomizer @ e428fc9). Modified for the DSH port: <one line>.`
4. **State non-affiliation** exactly and prominently:
   "Not an official Microsoft product. This is an independent port of the mechanisms in
   microsoft/TokenEconomizer at commit e428fc9 (Apache-2.0); it is not affiliated with,
   endorsed by, or supported by Microsoft." Do **not** use "TokenEconomizer" as the DSH
   plugin's product name in a way that suggests it *is* the upstream product; a descriptive
   "port of TokenEconomizer" use is the kind of "reasonable and customary" description §6
   allows. Upstream itself disclaims effect ("The plugin's own text … makes no claims of
   effect", `CLAUDE.md` conventions).
5. **Citation is not license-mandated.** Upstream asks for an academic citation in
   `README.md:370-384` (BibTeX for arXiv 2610.22732). Recommended in the port README:
   "If you use this, please also cite Li et al., TokenEconomizer, arXiv:2610.22732."
6. If we copy `trace/claude_tool_catalog.json` or other data files, carry the same attribution;
   the port does not need them (host-specific catalogs are dropped, see §10).

---

## 2. STATE MODEL (on-disk layout, identifiers, formats, atomicity)

This section covers `plugin/paths.py`, `plugin/repos.py`, `plugin/store.py`, `plugin/context.py`,
`plugin/fold.py`, `plugin/config.py`. A DSH port needs an equivalent state root and stores; the
exact *file names* (`injection.json`, `untool.json`, `envelope.json`, ledger event kinds) are a
compatibility surface upstream explicitly protects (`CLAUDE.md`: "On-disk state names … are a
compatibility surface; renaming them strands what users have learned"). For a fresh DSH plugin we
may pick our own root, but the *schemas* should be preserved so state/notes and tests translate.

### 2.1 Root and permissions

- Root: `$TOKENECONOMIZER_HOME`, else `~/.tokeneconomizer`; always `os.path.abspath`
  (`plugin/paths.py:23-30`). DSH analogue: `$DSH_TOKENECONOMIZER_HOME` else
  `~/.dsh/tokeneconomizer` (or mirror `~/.tokeneconomizer` for drop-in familiarity; **decision
  needed by Lead** — recommended: `~/.dsh/tokeneconomizer` with the old env var also honoured).
- `secure_root()` chmods the root to `0700` when it is owned by the user and group/other bits are
  set (`plugin/paths.py:33-46`); new files are created private via `umask 077` in the launcher.
- `<root>/bin/te` launcher (POSIX shell, chmod 0700, atomic replace; `plugin/paths.py:49-84`).
  **Not ported** (host CLI plumbing), but keep the idea of a private root.

### 2.2 Directory layout

```
<root>/                                   # TOKENECONOMIZER_HOME / ~/.tokeneconomizer
├── config.json                           # global settings (JSON, see §7)
├── index.json                            # repo index: checkouts seen, redirects, (see 2.4)
├── errors.log                            # append-only hook exceptions/tracebacks
├── bin/te                                # launcher (not ported)
├── sessions/<host>/<session_id>.json     # SESSION PINS (see 2.5)
├── merged/<key>.<YYYYmmdd-HHMMSS>/       # whole state dirs set aside by migration
└── repos/<repo-key>/                     # one repository
    ├── config.json                       # repo-level settings (shared by all hosts)
    └── <host>/                           # per-agent state ("envelope learned on one agent
        │                                 #  says nothing about another's turn scale",
        │                                 #  paths.py:12-16); host ∈ HOSTS
        ├── sessions/<sid>.json           # per-session record written by hooks
        ├── folded.json                   # {sid: {at, transcript}} folded-once set
        ├── ledger.jsonl                  # one JSON object per folded session / overhead
        ├── events.jsonl                  # controller event log (status lines etc.)
        ├── injection.json                # micro-skills: rendered block + facts (2.6)
        ├── untool.json                   # tool pruning evidence/proposal/applied (2.7)
        ├── envelope.json                 # loop guard per-repo turn envelope (2.8)
        ├── mechanisms/                   # mechanism classes' own results state
        ├── fold.log / judge.log / repomap.log   # detached-process logs
        └── .fold.lock .mechanisms.lock .state.lock .index.lock  # lock files (2.9)
```

Citations: repo state dir `plugin/paths.py:251-253`; host dirs are `hosts.HOSTS` names
(`plugin/repos.py:158-161`); `LiveContext.mech_dir` = `<store>/mechanisms`
(`plugin/context.py:23-26`); sessions dir/session record path (`plugin/controller.py:45`,
`plugin/repos.py:9-10`); pin store `plugin/repos.py:69-70`; ledger/events/folded/settings writes
(`plugin/fold.py:88-93,168-191,364-419`, `plugin/controller.py:75`); errors.log
(`plugin/repos.py:58-65`); merged dir (`plugin/repos.py:448`).

### 2.3 Repository identity (the per-repo key)

State is keyed by **repository, not directory**: one repo has one key however it is cloned
(`plugin/paths.py:1-16`).

- `repo_identity(cwd, env)` (`paths.py:229-248`):
  - find git checkout by walking up from cwd (`find_repo_root`, `paths.py:121-140`); honors
    `GIT_CEILING_DIRECTORIES`, treats `$HOME` as a ceiling; a `.git` dir counts only if it holds
    `HEAD`, a `.git` file counts only if its `gitdir:` target exists (`paths.py:109-118`).
  - If a remote exists: normalize it (`normalize_remote`, `paths.py:188-195`: strip scheme, user@,
    scp-style `host:path`→`host/path`, strip `.git`, lowercase) → `how="remote"`,
    `key = f"{_slug(name)}-{digest(remote)}"`, `label = "owner/repo"` (last two components).
  - Else if a checkout: realpath of main checkout (worktrees share the clone's `.git`) →
    `how="path"`; else the directory itself → `how="dir"`; `key = f"{_slug(basename)}-{digest(realpath)}"`,
    `label = basename`.
  - `_slug`: `re.sub(r"[^a-z0-9]+","-",text.lower()).strip("-")[:40] or "repo"`
    (`paths.py:198-199`); `digest`: `sha1(canon).hexdigest()[:10]` (`paths.py:202-203`).
- `RepoId` fields: `root, key, label, remote, how` (frozen dataclass, `paths.py:210-216`);
  `how ∈ {"remote","path","dir"}` (`paths.py:207`).
- **Session pin**: first hook of a session writes `<root>/sessions/<host>/<sid>.json` =
  `{root,key,label,remote,how,cwd,at}` (`repos.py:44,105-107`); every later hook/fold uses the
  pinned repo even if the agent `cd`s elsewhere. Pin filename sanitized:
  `re.sub(r"[^A-Za-z0-9._-]","_",sid)[:200] + ".json"` (`repos.py:73-74`). Pins older than
  `PIN_MAX_AGE_S = 30*86400` pruned at most once/day (`repos.py:41,110-130`).
- **Migration/legacy**: layout version `LAYOUT = 2` (`repos.py:40`); `index.json` remembers
  checkouts/redirects; pre-0.1.0 key = `f"{_slug(basename)}-{digest(remote or realpath)}"` where
  *any* `.git` entry counted (`repos.py:133-154`). Merges set whole dirs aside under
  `<root>/merged/` and keep learned state as `premerge-*`; **nothing is deleted** (`repos.py:22-24`).
  Also: `toolprune` has its own `adopt` path for CLI-level checkout state (`repos.py:557-566`).
  For the DSH port: we can start at layout 1 with a fresh root, but implement the *same identity
  function* (remote-first) because it is cheap and gives multi-host sharing.

### 2.4 `index.json` (global)

Read/written under `Store(root).locked("index")` (`repos.py:597-680`; `INDEX = "index.json"`,
`repos.py:39`). Known schema fragments:
- `{"redirects": {old_key: {"to": new_key, "at": ts}}}` — followed by `pinned()` with a max of 8
  hops, only redirects newer than the pin (`repos.py:93-102`).
- checkout index records of seen checkouts (used by `adopt`/`migrate`; exact field set is written
  by helpers in `repos.py:597-660` — **UNKNOWN**; see §11).
- migration marker/`merged` count surfaced as `merged` in `te repos` output (`repos.py:835-844`).
  **Exact remaining schema is UNKNOWN** (lines `repos.py:597-680` were not fully read; the
  redirects map is confirmed). A DSH port can omit migration entirely (fresh root) but keep an
  `index.json` if we want `te repos`-style listing.

### 2.5 Per-session record written by hooks (`sessions/<sid>.json`)

Written by the controller on hook events; fields read by fold: `transcript` (path to agent log),
`started`, `ended`, and loop-guard counters `turns` (list), `nudges` (int), `aborts` (int),
`judge_tokens`, `writer_tokens`, `injected_chars`, `injected_ids` (list of fact ids injected at
session start), `folded` (bool) (`plugin/fold.py:368-372,406-422`). Controller's own doc
(`plugin/controller.py:47-55`): `{"session_id","host","started","cwd","turns":[],
"nudges":0,"aborts":0,"judge_tokens":0.0,"writer_tokens":0.0}` + `transcript`, `updated`,
`source`, `injected_text`/`injected_chars`/`injected_ids`, `ended` (`controller.py:93-120`).
DSH port: a session-state document per DSH session, written through a store with locking.

### 2.6 `injection.json` (micro-skills state, per host+repo)

Written by `_fold_microskills` (`plugin/fold.py:88-93`):

```json
{
  "profile": "off|envfacts|envfacts+distiller|distiller",
  "reason": "<distiller reason string>",
  "rendered": "<the exact block injected at session start, or ''>",
  "rendered_ids": ["<fact id>", ...],
  "facts": ["<fact text>", ...],           // srow["manual_facts"]; may be absent/null
  "updated": 1699999999.0,
  "sessions": 12                            // monotonic count of folds
}
```

`rendered` is what `stage.render()` produced; `rendered_ids` are `stage.injected_ids()` used to
record which facts a session actually got (`fold.py:84-93`).

### 2.7 `untool.json` (tool pruning state, per host+repo)

Generic host (Claude/Copilot) — `plugin/fold.py:168-191`:

```json
{
  "used_tools": ["Read", "Bash", ...],            // sorted list; every tool ever used
  "streaks": {"Notebook": 3, ...},                // consecutive sessions unused, per tool
  "prompt_streaks": {"Notebook": 27, ...},        // unused prompts accumulated
  "catalog_tools": ["Bash", ...],                 // sorted observed catalog
  "catalog_desc": {"Tool": "description", ...},   // tool -> description
  "catalog_source": "claude|codex|...|null",      // where catalog came from
  "sessions": 7,                                  // folds counted
  "prompts": 143,                                 // prompts counted (None→1 per session)
  "updated": 1699999999.0,
  "proposal": ["Notebook", ...],                  // currently-proposed tools
  "new_in_proposal": [...],                       // proposal minus previous
  "servers": {...},                               // copilot only: per-MCP-server summary
  "auto_pending": {"items": [...], "root": "<repo root>", "since": ts},  // auto only
  "auto_applied": [...],                          // last write result (auto)
  "auto_apply_refused": "<error>",                // refused writes surface here
  "restored_protected": [...],                    // protected tools given back this fold
}
```

Codex variant — `plugin/fold.py:262-272`: `{"sessions","catalog_source":"capabilities",
"prompts","capabilities":{cap:{loaded_sessions,loaded_prompts,unused_sessions,used}},
"loaded_prompts":{cap:int},"proposal",...,"updated","new_in_proposal"}`.
DSH port: the generic schema only (host-specific Codex capabilities dropped).

### 2.8 `envelope.json` (loop-guard per-repo turn envelope)

Per host+repo; written by the loop guard (see §5, `plugin/controller.py` Stop path and
`loopguard/envelope.py`); merge logic concatenates envelope samples and keeps
`ENVELOPE_HISTORY` (`repos.py:326-331`: `merged[k] = (list(a.get(k) or []) + list(b.get(k) or []))[-ENVELOPE_HISTORY:]`).
Schema (from `loopguard/envelope.py:157-191`):
```json
{"level": "conservative|default|aggressive",
 "resolved_turns": [12, 40, 31, ...],       // turn lengths of ended-green turns only, capped 500
 "resolved_snaps": [{"turns","edit_churn","distinct_edit_files","error_outputs","test_runs",
                     "stagnation","repeated_fail_sigs"}, ...]}
```

### 2.9 JSON store, locking, atomic writes, corruption (`plugin/store.py`)

- `Store(base)` = one directory of JSON docs + JSONL logs (`store.py:46-49`).
- `read(name, default=None)` → `json.load`, returns `default` on `OSError`/`ValueError`
  (`store.py:60-65`) — **corrupt file = silently default**, caller re-initializes.
- `write(name, obj)`: `os.makedirs(dirname)`, temp `f"{target}.{pid}.tmp"`, `json.dump(obj, indent=2,
  sort_keys=True)`, `os.replace(tmp,target)`; removes tmp on failure (`store.py:67-80`).
- `append(name, record)`: JSONL, one `json.dumps(record, sort_keys=True)+"\n"` per line
  (`store.py:82-86`). `read_lines` skips malformed lines (tolerant), optional `limit` keeps last N
  (`store.py:88-100`).
- `locked(name="state", timeout=10.0)`: opens `.{name}.lock`, polls non-blocking exclusive lock
  every 0.05 s, yields `got` bool; caller must check it when correctness matters (fold does);
  degrades to `yield True` when neither `fcntl` nor `msvcrt` is available ("a lost update is
  recoverable, a crashed hook is not", `store.py:102-130`). Locking is advisory; read-modify-write
  of shared JSON is wrapped in `with store.locked(...)`.
- Hook contract: any exception in a hook → `{}` + a line in `<root>/errors.log` (CLAUDE.md;
  `repos.py:58-65` shows the error writer).
- DSH port: implement `Store` with `fs.promises` equivalents: atomic tmp+rename, JSONL append,
  a lock (proper-lockfile-style mkdir lock or `flock` via fs-ext — prefer a simple mkdir/`O_EXCL`
  lock with timeout, no native deps), tolerant reads. Node `JSON.stringify` with **sorted keys**
  to match upstream's `sort_keys=True` if byte-compat matters for fixtures.

### 2.10 Per-agent vs shared, cleanup/reset

- **Per agent (host)**: `injection.json`, `untool.json`, `envelope.json`, `sessions/`,
  `folded.json`, `ledger.jsonl`, `mechanisms/` — under `<root>/repos/<key>/<host>/`
  (`paths.py:12-16`).
- **Shared across agents**: repository identity/key and repo-level `config.json` (at
  `<root>/repos/<key>/config.json`), global `<root>/config.json`.
- **Cleanup**: pins pruned after 30 days (`repos.py:41,110-130`); `auto` pending list dropped
  when applied/refused/given back (`fold.py:312-341`). There is **no `te reset`/`te disable`
  command** upstream (verified in the parser `cli.py:705-758`); disabling is `TE_DISABLE=1`
  (`config.py:309-310`). Nothing else is deleted by the mechanisms; merges move dirs to
  `<root>/merged/`.

---

## 3. MICRO-SKILLS

Files: `microskills/observe.py` (session → classified observations/digest),
`microskills/envfacts.py` (LLM-free fact families), `microskills/lifecycle.py` (state machine),
`microskills/distiller.py` (optional paid proposer), `microskills/stage.py` (`PrefixStage`),
`plugin/fold.py:_fold_microskills` (plugin persistence into `injection.json`).

Pipeline: finished session log → `trace.load_trajectory` (host reader; DROPPED in DSH port, replaced
by a DSH transcript adapter) → `observe.observe_task` → per-family discovery/verdict → `Lifecycle`
→ `render()` block cached in `injection.json` → injected at the next SessionStart
(`plugin/controller.py:106-120`).

### 3.1 Command observation (`observe.py`, port THIS)

Input: ordered `(tool_name, args, result_text, ok)` calls (any host schema normalized by `trace`).
Only shell calls are classified: `tool in ("shell","bash","stop_bash")` (`observe.py:607`).

1. **Unwrap**: strip an agent's `/bin/bash -lc "<cmd>"` wrapper (`unwrap`, `observe.py:167-179`).
2. **Segment**: heredocs are elided first (`_HEREDOC_RE`, `observe.py:124,185`), then split on
   `&& || ; |` and newlines **outside quotes**; each segment is `.strip().strip("()")`
   (`segments`, `observe.py:182-205`). This is a hand-written splitter, not `shlex` — no word
   expansion, no globbing, no subshell evaluation (deliberately conservative; see §8 risks).
3. **Per segment** (`classify_command`, `observe.py:292-367`):
   - strip leading `VAR=value` assignments (`_ENV_ASSIGN_RE`, `observe.py:121,313-317`; `env
     VAR=value cmd` too) and mark `assigned=True`; strip an rtk command prefix
     (`strip_rtk_prefix`, `observe.py:314-317`).
   - `cd DIR` updates the carried prefix `cd <rel> &&` and the tracked cwd (relative to session
     start; `_cd_target`, `observe.py:244-272`; a `cd` up to the repo top collapses to no `cd`;
     `~`/`$VAR`/`-`/absolute-unknown → session-relative state becomes unknown).
   - activation: `source …/activate X`, `conda|mamba activate X` → carried prefix
     `source activate X &&` / `conda activate X &&` (`observe.py:331-336`).
   - wrappers: `conda run -n X`, `poetry|pipenv|uv|npx|bundle|yarn|pnpm run|exec`, `npx`
     (`_CONDA_RUN_RE`, `_TOOL_RUN_RE`, `_NPX_RE`, `observe.py:116-119,339-351`).
   - strip prefix words `sudo env time exec nice nohup timeout` and stray assignments
     (`PREFIX_HEADS`, `observe.py:108,353-357`).
4. **Classify** head/base (`_classify`, `observe.py:381-446`) by the domain `Vocabulary`:
   - interpreter (`python*`, `node*`, plus versioned `python3.11` via `_INTERP_VERSIONED_RE`):
     only `--version/-V` → `probe_env`; `-m <runner_module>` → `run_tests`
     (`<head> -m <mod>` form); a runner script argument (`runtests.py`, `bin/test`,
     `bin/doctest`, `manage.py` only with `test`) → `run_tests` (`<head> <script>` form); else
     `run_interpreter` (form = head only, args dropped so `python x.py` pools).
   - runner executable (`pytest`, `tox`, `jest`, …) → `run_tests` form = head.
   - runner script run directly (`./tests/runtests.py`) → `run_tests` form
     `<canonical_interpreter> tests/runtests.py` (so shebang and interpreter spellings pool).
   - `<task_head> test` (`make test`, `npm test`, `cargo test`) → `run_tests`.
   - generic vocabulary only: `npm|yarn|pnpm|bun run X` → `run_tests` if `X` starts `test`,
     `run_build` if X-kind ∈ BUILD_SUBS; `<task_head> build|lint|...` → `run_build`;
     `<build_head>` → `run_build`.
   - `which|command|type|whereis` → `probe_env`.
   - `curl|wget` → `fetch_remote` with hosts from `https?://([^/\s'"`]+)` regex
     (`_URL_HOST_RE`, `observe.py:125,425-427`).
   - `git fetch|clone|pull|ls-remote` → `fetch_remote`; `git remote` / `branch -a|-r|--all|
     --remotes` / `tag --contains` / `fsck` / `stash list` / `show-ref|for-each-ref` →
     `probe_vcs_refs` with probe kind (`_probe_kind`, `observe.py:449-463`); other git → None.
   - package tools: `pip|npm|yarn|pnpm install|download|add|ci` → `fetch_remote`;
     any other package-tool invocation → `package_tool` (form = bare tool name).
5. **Outcomes** are attributed per *call*, then copied to segments (`observe_task`,
   `observe.py:587-692`):
   - `error_class(output)` scans `ERROR_CLASSES` in order (`observe.py:129-146`):
     `module_missing`, `command_missing`, `script_missing`, `permission_denied`, `usage_error`,
     `connection_refused`, `name_resolution`, `unreachable`.
     `FORM_ERRORS` = first five; `NETWORK_ERRORS` = last three (`observe.py:147-149`).
   - success = `ok`, unless output carries an `exit code: N` hint (then `N==0`)
     (`_exit_code_hint`, `observe.py:473-475`).
   - homogeneous call = no non-passthrough segments and one intent (`_PASSTHROUGH`,
     `observe.py:109,635-640`). On an env error, the error class is attributed to the named
     segment (its head/executable appears in the error line, else network hosts), else the last
     relevant segment when the call failed (`observe.py:641-661`).
   - success → all segments `ran`; failure with no env error → only the **first** relevant
     segment `ran`, others unknown (`observe.py:662-673`).
   - `probe_vcs_refs` outcome is judged only in a homogeneous call: `hit` if `_PROBE_HIT[kind]`
     matches, `empty` if success, else unknown (`observe.py:674-682`).
   - `fetch_remote` counts as reachable (`ran`) only for a homogeneous call that exited 0, has
     non-empty output, and shows no network error (`observe.py:683-688`).
   - a call whose output shows a failed `cd` teaches nothing (`_CD_FAILED_RE`, `observe.py:611-612`).
6. **`form_failed` / `form_worked` / `is_bare`** (`observe.py:570-584,705-709`):
   `form_failed(o)` = outcome ∈ FORM_ERRORS and not a label error, and not
   (`run_tests` + `usage_error`) — an option/syntax mistake is not a form failure.
   `form_worked(o)` = outcome `ran` and (run_tests ⇒ `tests_ran`).
   `is_bare(form)` = no `/` in head, no ` activate `/` run `, not `conda run|poetry run|pipenv
   run|uv run|npx`.
7. **Test labels** (ArgRepair): `_test_labels` takes positional structured tokens after the
   runner token, skipping option values (`observe.py:517-540`); `label_rule(a,b)` returns
   `("sep","::")` when `a::b::c` ↔ `a.b.c`, or `("strip", prefix)` when `pkg.rest` ↔ `rest`
   (`observe.py:543-558`). `label_err` = explicit "failed to import"/"not found" markers or the
   missing module is the label's own head; `loaded` = a positive test summary
   (`observe.py:480-504,629-634`).
8. **Env-var evidence** (`_env_calls`, `observe.py:561-567`): `need` = names an output asks for
   ("environment variable `V`"); `sets` = `export/prefix VAR=value` in the command text plus
   `os.environ[...] = "value"` in code; `ok` = call success and no failure markers.
9. **Edited files**: generic reading = every file any edit tool wrote (`lifecycle.edited_files`,
   `lifecycle.py:38-50`); python-git reading = `*.py` only (`edited_pyfiles`,
   `lifecycle.py:24-35`). Edit tool names recognized: `edit, multiedit, write, create,
   str_replace_editor`, and `apply_patch` with `paths`.
10. Returns `{"obs": [...], "edited": [...], "n_calls": N, "env": [...]}` (`observe.py:691-692`).

**Vocabularies** (`observe.py:25-96`): `PYTHON_GIT` (python interpreters; pytest/tox/nox/
nosetests/trial runners; `runtests.py|bin/test|bin/doctest|manage.py` scripts; pytest/unittest/
nose/django/tox/nox modules; pip/conda/poetry/uv/apt package tools), `NODE_WEB` (node/deno/bun
family; jest/vitest/mocha/playwright/cypress/ava/karma; npm/yarn/pnpm…), and `GENERIC` (the
plugin's default: union of both + ruby/perl/php/Rscript/julia/lua/elixir interpreters,
rspec/phpunit/ctest/bats runners, build heads make/cmake/tsc/eslint/mypy/…). `BUILD_SUBS`
(`observe.py:92-93`) and `_RUN_SCRIPT_HEADS` (`observe.py:94`) define generic build/check
commands. DSH port: keep the `Vocabulary` design; ship `GENERIC` + maybe a JS-flavored one.

### 3.2 Env-fact families (`envfacts.py`, port THIS — the LLM-free core)

Constants: `MAX_FACTS=4`, `MAX_TOKENS=150` (~4 chars/token, header included)
(`envfacts.py:44-45`); headers (`envfacts.py:46-48`). A fact renders only if `lint_ok` —
`_LINT_RE` refuses words that read as completion/verification advice: skip, no need, don't,
do not, stop, done, completed, finish(ed), verify/verification, "instead of running/testing"
(`envfacts.py:50-52,215-216`). Claim vocabulary per family (`_ERROR_PHRASE`,
`envfacts.py:54-60`): module_missing→"ModuleNotFoundError", command_missing→"command not found",
script_missing→"a file-not-found error", usage_error→"a usage error",
permission_denied→"permission denied".

**Family 1 — FormRepair** (form A fails with an infrastructure error, later form B succeeds):
- Discovery per intent ∈ {`run_interpreter`, `run_tests`, `run_build`, `package_tool`}
  (`envfacts.py:328-354`): a failed observation `a` (for non-run_tests/run_build intents it must
  be `is_bare`) becomes a candidate iff a later observation in the same session is `typed_ok`
  (worked, no env prefix; `envfacts.py:170-174`) and `_repairs(o.form, a.form, intent)` — different
  form, and outside test/build intents B must not be bare (`envfacts.py:177-181`).
  Candidate id `form_repair:{intent}:{a.form}`; params `{intent, a, b_counts:{}, error_counts:{}}`.
  Each failing occurrence increments `error_counts[a.outcome]`.
- Per-session evidence (`envfacts.py:355-369`): every form that worked as typed adds +1 to
  `b_counts[form]` if it `_repairs`; a previously-counted form that failed as typed (and didn't
  also work) adds +1 to `b_fails[form]` — so one messy session cannot outvote clean ones.
- Verdicts (`envfacts.py:370-391`): `exercised` = any observation of the intent;
  `fired` = `a_failed` or (fact was injected last session and a working form ran and A did not
  fail); `confirm` if A failed, or B ran without a bare runner success; `contradict` if the bare
  A form itself ran the test runner successfully; else None.
- Rendering (`EnvFact.claim`, `envfacts.py:88-132`): "`<A …>` fails here with <error>; `<B …>`
  works." where B = `working_form()` = highest `b_counts - b_fails` among shell-preserving forms
  (prefer non-`cd DIR &&` forms when any has a good record); if none, no claim. Forms that move
  the shell are rendered as a subshell: `` `(cd tests && python runtests.py …)` ``
  (`_usage`, `envfacts.py:188-192`).
- `CONTRADICT_STREAK = 2` (`envfacts.py:146`): a FormRepair contradiction only counts after two
  consecutive exercised contradicting tasks (`envfacts.py:149-167`); a high-stakes CANDIDATE
  contradicted retires immediately.

**Family 2 — Boundary** (hosts refused): `id="boundary:fetch_remote"`, high=True
(`envfacts.py:473-495`). Accumulate `hosts` from fetches whose outcome ∈ NETWORK_ERRORS; confirm
if any failed host this session; contradict if a *known* host succeeded; fired = any failed
fetch; exercised = any fetch mentioning hosts. Claim: "Outbound connections to <hosts> are
refused here; nothing can be fetched from them." (up to 3 hosts), `_join` formatting
(`envfacts.py:97-100,206-212`).

**Family 3 — EmptyProbe** (VCS refs empty): `id="empty_probe:vcs_refs"`, high=True
(`envfacts.py:497-516`). Only outcomes hit/empty count; confirm if probes exist, contradict if
any hit, fired=exercised=any probe. Claim is a fixed sentence (`envfacts.py:114-117`).

**Family 4 — ArgRepair** (label shape rewritten): discovery pairs a label-errored run with a
later same-form run that loaded, where `label_rule(a,b)` gives the rewrite
(`envfacts.py:393-415`); id `arg_repair:{form}:{kind}:{param}`; `examples` counts `"a b"` pairs.
Verdicts (`envfacts.py:416-434`): `bad_failed` = a label of the bad shape failed to load,
`bad_loaded` = bad shape loaded (contradict), `good_loaded` = rewritten shape loaded (confirm);
fired = bad_failed or (injected and good_loaded and not bad_failed).
Claims: sep kind → "<form> takes dotted test labels (`module.Class.test`, not
`module::Class::test`)."; strip kind → "<form> takes test labels without the `<prefix>` prefix
(`rest`, not `prefix.rest`)." (`envfacts.py:101-108`).

**Family 5 — EnvValue** (variable + working value): from the session's env evidence, for each
`need` of var V, a later command that `sets V=value`, succeeded, and does not still need V gives
`good[value]++` (`envfacts.py:436-454`); later failed commands that set a different value add
`bad[value]`. Verdicts (`envfacts.py:455-471`): contradict only if the learned good value fails
the same need; confirm only if the learned good value worked; fired = code asked for the var
again, or (injected and good value worked). Claim: "Code that imports the project needs `V` set
here: `V=<good>` works[, `V=<bad>` does not]."
- `EnvFact` lifecycle is `Lifecycle(fid, high, drift=False)` — environment facts do not require
  different edited files (`envfacts.py:66-74`).

**Selection/rendering** (`EnvFactsDistiller.render/_select/_merged_lines`, `envfacts.py:248-313`):
injectable facts = ACTIVE + firing gate + non-empty claim + lint; sort priority
`form_repair 0, arg_repair 1, env_value 2, empty_probe 3, boundary 4`, then
`intent=="run_interpreter"` first, then higher firing rate; greedily add while
`len(facts)<=max_facts` and rendered text (header included) `<= max_tokens*4` chars; FormRepair
facts whose working forms share a `_root` (activation prefix / directory) merge into one line
("`A1`, `A2` fail here (err1, err2); `B` works."). Render =
`header + "\n" + "- line" per fact + "\n"`; `""` when nothing qualifies.
**The block is not delimited or quoted**: it is a markdown prefix with a header line and bullet
lines (see §8 for the DSH hardening requirement).
Persistence (`envfacts.py:523-547`): `<results_root>/envfacts_state/<repo.replace("/","__")>.json`
= `{"repo","now","opt_tokens":0.0,"vocab","facts":{id: EnvFact.to_dict()}}`; `EnvFact.to_dict`
= `{"id","family","params","life"}`; `Lifecycle.to_dict` (§3.3). `load` tolerates missing file
but **not** malformed JSON (raises → PrefixStage/`_fold_microskills` fails; plugin hook fails
open, so a corrupt file costs one fold; DSH port should catch and rebuild).

### 3.3 Fact lifecycle (`lifecycle.py`, port THIS)

Constants (`lifecycle.py:14-21`): `K_PROMOTE=3`, `GAMMA=0.8` (recency decay/task), `LAMBDA=5.0`
(contradiction weight), `SCORE_FLOOR=0.0`, `HARD_KILL=True`, `FIRE_GATE=0.40`, `FIRE_MIN_N=4`.
State doc (`to_dict`, `lifecycle.py:66-70`):
`{"key","high","drift","state","confirms":[(task_idx,[files]),...],"contradicts":[task_idx,...],
"fire_num","fire_den","promoted_at","retired_at"}`, `state ∈ CANDIDATE|ACTIVE|RETIRED`.
- `score(now) = Σ GAMMA^(now-i) over confirms − LAMBDA * Σ GAMMA^(now-i) over contradicts`
  (`lifecycle.py:88-91`).
- `update(now, verdict, fired, exercised, files)` (`lifecycle.py:102-117`): exercised increments
  `fire_den`, fired increments `fire_num`; `confirm` appends `(now, sorted(files))`;
  `contradict` appends `now`; CANDIDATE promotes when `_drifted_confirms() >= K_PROMOTE`, where
  drift=True requires each confirmation to involve a file-set disjoint from every kept earlier
  confirmation (or have no file set), drift=False counts all (`lifecycle.py:78-86`); ACTIVE
  retires on `high and contradict and HARD_KILL`, or when score < 0.
- `injectable()`: ACTIVE and `fire_den >= FIRE_MIN_N` and `firing_rate >= 0.40`
  (`lifecycle.py:96-100`); `firing_rate = fire_num/fire_den` or 0.
- "Confirmed on k=3 sessions" ⇒ K_PROMOTE=3 drifted confirmations; env facts use drift=False.
- Contradiction/retraction is NOT deletion: state RETIRED and no longer rendered; the state
  document keeps counters (nothing removed). High-stakes single-contradiction retire.
- Note `from_dict` restores `drift` from the document (`lifecycle.py:72-76`)**, while
  `EnvFact.from_dict` *forces* `drift=False` (`envfacts.py:138-143`) — a subtle compatibility
  quirk to keep or deliberately fix.

### 3.4 Optional paid distiller (`distiller.py`, port if we want the paid layer)

Constants (`distiller.py:27-37`): `PROPOSE_EVERY=8` (module default; `PrefixStage` rebinds it to
config `microskills_propose_every`, plugin default 3 — `microskills/stage.py:71-75`),
`WINDOW=8` digests, `MAX_CANDS=4` facts/tick, `MIN_CITE=2` confirming task ids, `MAX_EXTRACTORS=12`,
`RAW_SAMPLE=3`, `ABSTAIN_GATE=0.5`, `STATE_SUBDIR="manual_state"`, `BLOB_CAP=20000` chars.
It reads **only** a compact digest of the last WINDOW sessions (never raw transcripts):
generic digest fields (`build_generic_digest`, `distiller.py:198-234`): `iid`, `resolved`,
`edited_files`, `n_cmds`, `cmd_templates`, `check_commands`, `failed_commands:[{cmd,error}]`
(max 6), boolean flags `missing_command`, `missing_dependency`, `bad_usage`, `_ran_tests`, plus
host-side-only `_cmd_blob`/`_out_blob`. `_relative` makes repo paths relative and home `~`
(`distiller.py:174-182`); `error_signature` = first error line with hex→`<hex>`, paths→`<path>`,
numbers→`N`, truncated to 120 chars (`distiller.py:185-195`).
Prompt (`distiller.py:407-514`): system text (quoted there) instructs: durable repo-specific
facts only, never prohibitions on exploration/tool use, fact fields `id, claim, injection,
high_stakes, detector{scope,confirm,contradict?,fired?}, cite(>=2 iids)`, plus
`{extractors:[{name,kind∈{cmd_regex,out_regex,cmd_count},pattern}], facts:[...]}` JSON object
format; the generic variant replaces the predicate list and shows existing `id: claim` pairs;
an `external` section lists facts another free layer already injects (so the paid proposer does
not restate them). `parse_payload` (`distiller.py:517-529`) extracts the first `{...}` JSON, keeps
dicts with non-empty `name`+`pattern` (extractors) / `id`+`detector` (facts).
Admission: `_ground` requires MIN_CITE window iids whose detector confirm fires
(`distiller.py:649-661,683-691`); new facts replay over the window to enter with real lifecycle
state; existing ids may only be revised in `detector.contradict` (everything else frozen,
`_frozen_view`); no-op or non-contradiction revisions rejected (`distiller.py:693-707`).
Detector DSL (`distiller.py:268-365`): `Detector` scope/fired = built-in predicate name
(`repro_written, importerror, badarg, ran_tests, ran_checks, command_failed, missing_command,
missing_dependency, bad_usage, edited`; `PREDICATES`, `distiller.py:271-284`), an authored
extractor feature, or a Python regex over the command blob; `verdict` = contradict if
`contradict` regex matches commands+outputs; confirm if `confirm` matches; fired independent
(`distiller.py:310-319`). Extractor `compute`: cmd_regex/out_regex → bool, cmd_count → int.
Failure handling: any exception in `update`/`load_calls` → `now += 1`, return (no proposal);
runner exception? `_maybe_propose` calls `self.runner(prompt, model)` unguarded — an exception
would propagate to the fold (plugin hook fails open via `hook.main`; a fold may abort). Mark as a
port defect to fix: wrap proposer calls.
Usage accounting: `runner(prompt, model)` must return `(text, effective_tokens)`; `opt_tokens`
accrues and `PrefixStage.after_task` reports the per-session delta
(`microskills/stage.py:117-132`); plugin records it as `overhead.optimizer_tokens`.
Persistence: `<results_root>/manual_state/<repo>.json` = `{repo, now, opt_tokens, last_propose,
extractors, facts:{id:{spec,life}}, window:[digests with capped blobs], raw_cmds}`.
Injection: header `# repo operating manual (<repo-name>) — learned from earlier sessions in this
repository` + `- <injection>` lines (`distiller.py:710-718`); **no length cap** on this layer
(only `microskills_max_facts/max_tokens` cap the env layer — `microskills/stage.py:83-86`).
DSH recommendation: implement envfacts first; make the proposer optional and behind
`microskills=envfacts+distiller|distiller`; keep digest-only input (privacy).

### 3.5 Plugin wiring (`plugin/fold.py:66-94`, `microskills/stage.py`)

`_fold_microskills`: profile `off` → nothing; builds `InjectionConfig(enabled=True, profile,
propose_every, max_facts, max_tokens)`; paid runner only when `microskills` includes distiller
AND `sidecall.paused` is false; `PrefixStage(..., fresh=False, runner=..., adapter=LiveAdapter,
agent=host)`, `after_task` with `task={"instance_id": sid, "injected_ids": sess.injected_ids}`,
then writes `injection.json` (§2.6). Reason strings: `envfacts`,
`envfacts+manual-distill`, `manual-distill` (`microskills/stage.py:87-106`).
`ComposedDistiller.render` = env block, newline, paid block (`stage.py:16-56`).
`seed_injected(ids)` is how a fact injected in a previous hook process still counts as fired
(`envfacts.py:264-269`; plugin passes `sess["injected_ids"]`).

## 4. TOOL PRUNING

Files: `toolprune/tools.py` (protected/inapplicable sets + optional per-task judge),
`toolprune/stage.py` (`ToolingStage` evidence), `trace/catalog.py` (per-host catalog),
`toolprune/codex.py` (Codex capability packages — DROPPED), `plugin/fold.py:_fold_toolprune` +
`plugin/denylist.py` (live evidence→proposal→apply/restore), `plugin/adapter.py`
(`HIGH_RISK`/`HIGH_RISK_FACTOR`), `tests/test_live_hooks.py` (pruning behavior).

### 4.1 Evidence model (port THIS)

- **Tool use**: a tool "used" in a session if it appears in `adapter.tool_usage(transcript)` —
  i.e. any call to it (`toolprune/stage.py:138-140`). `used_tools` accumulates forever across
  sessions; an ever-used tool is never proposed (`stage.py:95-98`).
- **Catalog**: the full list of tools *loaded* for a session, `{name: description}`, from the
  host's log (`trace/catalog.py`; Claude: `system` init event tools joined to a static snapshot;
  Copilot: debug log/transcript/`"tools":["name:fingerprint"]` sources, richest wins; Codex: fixed
  default catalog). `catalog_tools` = every tool ever seen loaded; `catalog_desc` for the judge.
  If no catalog parses, evidence pruning can drop NOTHING and the stage warns once
  (`stage.py:168-189`); the chosen source is recorded as `catalog_source` (`catalog.py:168-178`).
- **Streaks**: for every catalog tool each fold: used this session → streak=0; else streak += 1
  (`stage.py:190-194`). This raw streak is only the candidate filter.
- **Prompt counting**: `prompts = host.prompt_count(transcript)`; `None` (unknown) counts as 1
  for the session (`fold.py:113-114,131-133,162-163`). `prompt_streaks[t]`: reset to 0 when used;
  when the unused streak incremented, add this session's `prompts` (`fold.py:159-163`).
- **Threshold decision** (`enough_evidence`, `fold.py:97-106`):
  ```
  k = 3 if tool is high-risk else 1                     # HIGH_RISK_FACTOR
  enough = (sessions >= min_sessions AND prompts >= evidence * k)
           OR (sessions >= sessions_threshold * k)      # any length
  ```
  i.e. p=10 unused prompts spread over ≥ m=2 sessions, **or** s=5 sessions however short;
  high-risk needs 3× (p=30 / s=15). Also required: `not used ever`, `not protected`,
  `not already applied`, `not in the "given back" list`.
- High-risk set: `plugin/adapter.py:59-61` `HIGH_RISK = {"NotebookEdit"}`,
  `HIGH_RISK_FACTOR = 3`; Codex analogue `{image_media}` (`fold.py:355`).
- The stage's own `ToolingConfig(evidence=max(1, min_sessions))` is only the *candidate* floor;
  `enough_evidence` makes the final decision (`fold.py:123-127,165-167`).
- Modes: `toolprune=off` → no learning writes (early return, `fold.py:115-116`); `propose`/`auto`
  both learn; `auto` additionally applies via `denylist` (§4.3). Copilot acts on whole MCP
  servers, not tools (`denylist.copilot_server_proposal`, `fold.py:176-185`); Claude acts on
  single tools; Codex on capability packages (DROPPED).
- `enough_evidence` is a **live-plugin** rule; the benchmark `ToolingStage.build_tools` uses the
  simpler "streak ≥ cfg.evidence" (`toolprune/stage.py:87-111`). Port the live rule.

### 4.2 Proposal / hold / quiet period (port the policy)

- Each fold computes `proposal` = candidates passing `enough_evidence`, minus already applied and
  given-back (`fold.py:180-186`). `new_in_proposal` = proposal − previous proposal (announced once,
  `fold.py:186`).
- `auto` does not write immediately: `_hold` stores
  `auto_pending = {"items":[...], "root":<repo root>, "since":<first held ts>}` and preserves a
  previous `auto_apply_refused` (`fold.py:280-287,187-188`).
- `apply_pending` (`fold.py:312-341`) runs under `store.locked("mechanisms")`:
  - drop items already applied/given back;
  - if `toolprune=auto` and not `shadow`: measure `idle = now − last_activity(ctx)`;
    `quiet_s = toolprune_quiet_minutes * 60` (q=60 min); `waited = now − since`;
    if `idle < quiet_s and waited < PENDING_MAX_S (24h)` → return the seconds to wait again
    (`min(quiet_s−idle, PENDING_MAX_S−waited)`);
  - else `denylist.apply(root, items, store, host=…)` → `auto_applied`; remove them from
    `proposal`; clear `auto_apply_refused` on success, or record its `RuntimeError` string on
    refusal (unreadable/committed/redirected settings file) — the proposal stays for a retry;
  - `auto_pending` removed in all cases.
  - `last_activity(ctx)` = max mtime over session records and their transcripts
    (`fold.py:290-309`). Rationale quoted at `fold.py:42-51`: a deny-list change opens the tool
    prefix, so a resumed warm-cache session would re-write its whole history; after q idle
    minutes the cache has expired anyway; a day-old pending list is written regardless.
  - `schedule_pending` spawns one detached `te toolprune apply-pending` waiter if it must wait;
    only that waiter polls (every `WAITER_POLL_S=600 s`, heartbeat via `fold.log`) — one waiter
    per repository/agent (`fold.py:344-350,52`; CLI `_wait_and_apply` `cli.py:261-291`).
- `shadow` computes and logs every decision but never writes/acts (`fold.py:187`, config.py:26-28).

### 4.3 Apply / restore / protection (policy to preserve; host writers DROPPED)

- Only the plugin's **own** entries are written, never user deny rules (README:300-307;
  `plugin/denylist.py:1-30`). `applied_for(store, root, host)` / `kept_for(…)` tell which rules
  the plugin added and which the person gave back; `kept` tools are never re-proposed
  (`fold.py:136-138,184`).
- `restore` removes only the plugin's rules and adds the tools to `kept` → "they will not be
  removed again" (README:302-304; tests `test_live_hooks.py:547,792-843`).
- Protected tools are never dropped: `adapter.protected_tools()` = `PROTECTED_TOOLS`
  (`toolprune/tools.py:41-48`: bash/view/grep/glob/edit/create/str_replace/read_bash/stop_bash/
  list_bash/read_file, codex shell/apply_patch, Claude Bash/Edit/Write/Read/Grep/Glob/MultiEdit)
  plus host extras (web tools are protected live: `fold.py:139-151` restores a protected tool's
  old rule). The per-task judge also force-keeps every `PROTECTED_TOOLS` entry
  (`tools.py:100-104`).
- Verify-after-write/rollback: `denylist.apply` returns the rules written and raises
  `RuntimeError` on unreadable/committed/redirected files; the pending list survives so later
  applies retry; `restore` is best-effort and only in the give-back direction
  (`fold.py:144-151`). Exact per-host atomic/verification logic: `plugin/denylist.py:1-550`
  (**host-specific; not ported**; tests `test_live_hooks.py:792-844`,
  `test_live_repos.py:377-401` pin the policy: apply/restore touch only the plugin's rules, a
  failed write still restores, new settings files are git-excluded).
- Insufficient evidence → empty proposal, nothing written, no announcement. One session's prompts
  can never decide alone (m floor).
- Optional paid per-task tool judge (`toolprune/tools.py:51-104`): prompt reads issue text +
  candidate catalog, returns `{tool: {"load": bool, "reason"}}`, unions DROP into evidence
  exclusions, never drops protected/ever-used; on failure returns `{}` (keep everything) and
  charges effective tokens. Live plugin has **no** DSH-side analog by default (no problem
  statement) — drop unless we add a task-text source.
- DSH port: evidence + enough_evidence + proposal/pending/quiet-period + protected + give-back
  semantics are portable; the *writer* must be reimplemented against DSH's own config/permission
  mechanism (OUT OF SCOPE to specify here; needs DSH research). Host-specific catalog parsers
  are replaced by a DSH tool-catalog source. Keep `untool.json` schema names for compatibility.

## 5. LOOP GUARD (failure-loop intervention)

Files: `loopguard/state.py` (per-call fold, `SpiralState`), `loopguard/shell_edits.py`
(shell-command edits count as edits), `loopguard/rules.py` (thresholds, gate, `is_stuck`,
`assess_abort`, `nudge_text`), `loopguard/envelope.py` (per-repo learned envelope + thresholds),
`loopguard/judge.py` (paid stuck judge + redirect writer), `loopguard/turn.py` (`TurnGuard` state
machine), `plugin/controller.py` (hook wiring), `plugin/judge.py` (background judge job),
`plugin/fold.py:406-416` (turn summary into ledger). Unit unit = **prompt-turn** (one user prompt
to the agent's stop), not session (`turn.py:11-17`).

### 5.1 Signal fold (`SpiralState`, port THIS)

`SpiralState` fields (`state.py:137-153`): `turns` (tool calls), `edit_counts{basename:n}`,
`edit_order[]`, `error_outputs`, `test_runs`, `fail_sigs{sig:n}`, `repeated_fail_sigs`,
`recent[]` (last 40 leakage-safe action lines).
`update(tool_name, args, result_text, failed=None)` (`state.py:170-212`):
- canonicalize tool name via `_TOOL_CANON` (`state.py:38-50`): bash/shell→bash, read/view→view,
  edit/multiedit/str_replace/apply_patch→edit, write/create→create, grep/glob pass;
- edits: `_EDIT_TOOLS = ("edit","str_replace","create")` after canonicalization → basename =
  `args.path|filePath|file_path`; `edit_counts[b]+=1`, `edit_order.append(b)`;
- bash: `cmd = args.command`; if `TEST_RUN_RE` matches → `test_runs += 1` (`state.py:17-19`);
- failure detection: `fail = None`; `can_fail = failed is True if tool in content_tools
  ("view","grep","glob") else failed is not False`; if result non-empty, can_fail, and `ERR_RE`
  matches → `error_outputs += 1`, then `_failure_sig(result)` (first line matching `ERR_RE`,
  normalized `0x…|digits|/path` → removed, `md5(norm)[:10]`); if sig seen before →
  `repeated_fail_sigs += 1`.
- derived: `edit_churn = max(edit_counts.values()) or 0`; `distinct_edit_files =
  len(edit_counts)`; `stagnation = repeated_fail_sigs / sum(fail_sigs.values()) or 0`
  (`state.py:154-168`); `snapshot()` dict (`state.py:234-239`).
- shell commands that edit (`sed -i`, `perl -pi`, `patch`, `git apply`, `>` redirects …) are
  folded as edits by `shell_edits.fold_shell_edits` (`loopguard/shell_edits.py`, 194 lines;
  tests `test_live_core.py:615-619`); it also feeds the ended-green proxy. Port: adapt the same
  idea to DSH shell-tool calls (simplification: DSH file-edit tools already report edits; shell
  edits are an extra).
- `recent_digest(n=24, envelope=None)` (`state.py:214-232`) — the only thing the paid judge sees:
  `turns=… edit_churn=… distinct_edit_files=… error_outputs=… test_runs=…
  repeated_identical_failures=… stagnation=…` + optional repo context
  ("tasks here usually RESOLVE within ~E turns; this trajectory is at N turns = R× that typical
  length. Tests are still NOT green…") + last n action lines. In the live plugin
  `TurnGuard.live_digest` replaces the "NOT green" sentence with the real verification state
  (`turn.py:266-280`).

### 5.2 Detection rules (`rules.py`, port THIS)

`DEFAULT_THRESHOLDS` (`rules.py:20-43`) — every number matters:

| key | default | meaning |
|---|---|---|
| `min_turns` | 20 | tool calls before `is_stuck` may fire |
| `edit_churn` | 4 | edits to one file = churn |
| `distinct_edit_files` | 3 | OR edits scattered over ≥3 files |
| `error_outputs` | 6 | sustained failing tool results |
| `stagnation` | 0.20 | ≥20% of failures repeat an earlier signature |
| `envelope_margin` | 1.25 | envelope = margin × p90 of ended-green turn lengths |
| `envelope_pct` | 90 | percentile (not max) |
| `envelope_min_samples` | 5 | e: ended-green turns before the envelope is trusted |
| `judge_confidence` | 0.7 | c: judge confidence needed to redirect |
| `backstop_mult` | 2.5 | b: redirect without judge past b×envelope when stuck |
| `gate_min_turns` | 18 | judge gate: don't wake before this many calls |
| `gate_error_outputs` | 8 | OR this many failing results wake the judge |

`SPIRAL_LEVELS` presets (`rules.py:53-66`): `conservative`
{judge_confidence .85, envelope_margin 1.5, backstop_mult 3.5, stagnation .30, gate_min_turns 24,
min_turns 28, edit_churn 5, error_outputs 8, envelope_min_samples 7}; `default` = {} (verbatim);
`aggressive` {.55, 1.0, 1.8, .12, 12, 14, 3, 4, 3, nudge_on_ambiguous=True}.
`scaled_thresholds(level)` = DEFAULT overlaid with preset (`rules.py:69-75`).

- `gate_for_judge(state, thr)` (`rules.py:78-90`): `False` before `gate_min_turns`; else
  `repeated_fail_sigs >= 1 or error_outputs >= gate_error_outputs`. Permissive on purpose.
- `is_stuck(state, thr)` (`rules.py:93-106`): `turns >= min_turns` AND
  `churny = edit_churn>=edit_churn OR distinct_edit_files>=distinct_edit_files` AND
  `noisy = error_outputs>=error_outputs` AND `repeating = stagnation>=stagnation`.
- `assess_abort(state, envelope, judge, thr)` (`rules.py:109-180`), decision order:
  1. **Hard backstop** (before the judge): `backstop_turns = thr.backstop_turns` if present, else
     `envelope * backstop_mult`; if `turns >= backstop_turns and is_stuck(state)` →
     `(True, "backstop:{turns}>={backstop_turns:.0f}turns stagnation={stagnation:.2f}")`.
     The judge cannot veto this.
  2. **With judge**: `over_envelope = envelope is not None and turns >= envelope and
     thr.gate_over_envelope (default True)`; if neither gate nor over_envelope → `(False,
     "gate-closed")`; call judge(digest) (caller rate-limits) — exception/None → `(False,
     "judge-throttled")`; `conf = float(v.confidence)`; `v.stuck and conf >= judge_confidence` →
     `(True, "judge-stuck@{conf:.2f}:{reason[:60]}")`; `v.stuck is False` →
     `(False, "judge-productive")`; ambiguous (stuck=None) → `(False, "judge-ambiguous-spared")`
     (envelope alone never kills; only the backstop can).
  3. **No judge fallback**: not stuck → `(False,"not-stuck")`; stuck and `turns >= envelope` →
     `(True, "envelope:{turns}>={envelope:.0f}")`; else `(False,"stuck-but-within-envelope")`.
- `nudge_text(state)` exact template (`rules.py:183-198`), which a DSH port should reuse
  verbatim:
  ```
  Process check (automated): so far you've made {total_edits} edits across
  {distinct_edit_files} file(s) (most to `{busiest}`) and run {test_runs} verification(s),
  and the same failure has recurred {repeated_fail_sigs} time(s) without the tests going
  green. This looks like a repetitive loop. Do NOT stop — instead step back and try a
  MATERIALLY DIFFERENT hypothesis: re-read the failing test's expectation, consider a
  different file or root cause than the ones you've been editing, and verify the new
  hypothesis directly before editing again.
  ```

### 5.3 Per-repository envelope (`envelope.py`, port THIS)

`EnvelopeTracker(margin=None,pct=None,min_samples=None,level="default",frozen_envelope=None)`
(`envelope.py:30-88`): `base_thr = scaled_thresholds(level)`, margin/pct/min_samples default
from base; `resolved_turns[]`, `resolved_snaps[]`; `update(turns,resolved,snapshot)` appends only
when `resolved and turns` (`envelope.py:72-80`); `envelope` property = `None` until
`len(resolved_turns) >= min_samples` (or `frozen_envelope` if given), then
`_percentile(resolved_turns, pct) * margin` (`_percentile` = linear-interpolated, `envelope.py:14-27`).
`thresholds(max_turns)` (`envelope.py:90-144`):
- start from base; if envelope not None: `backstop_turns = envelope*backstop_mult`, clamped to
  `0.9*max_turns` when a cap is given;
- before warm-up: return base (+ backstop_turns);
- learned: `p90t = p90(resolved_turns)`;
  `gate_min_turns = clamp(round(0.6*p90t), 6, base.gate_min_turns)`;
  `min_turns = clamp(round(0.6*p90t), 8, base.min_turns)`;
  with snapshots: `edit_churn = max(base, ceil(p90(sig)+1))`, same for
  `distinct_edit_files`, `error_outputs`, `gate_error_outputs = max(base, error_outputs)`,
  `stagnation = max(base, round(p90(sig),3))` — learned signal gates never go below the
  level-scaled base (resolve safety).
Persistence (`envelope.py:147-205`): `ENVELOPE_HISTORY=500`; `load_envelope(store, level,
overrides)` reads `envelope.json` = `{"level","resolved_turns","resolved_snaps"}`;
`thresholds(tracker, overrides)` applies person-pinned `loopguard.*` values last and recomputes
`backstop_turns` when `backstop_mult` is pinned; `save_envelope` writes it under the store;
`record_turn(store, guard, level, stopped_normally, overrides)` under `store.locked("envelope")`
adds `guard.cum_turns` + `guard.whole.snapshot()` only when `guard.resolved_proxy(stopped_normally)`
is true.
**Ended-green definition** (`turn.py:255-264`): `resolved_proxy = stopped_normally and not
aborted and cum_turns>0 and not (last_verify_failed and last_verify > last_edit)` — i.e. green
unless a verification after the last edit failed; the requirement of a *passing* check after the
last edit was deliberately rejected (it lengthened, not shortened, the envelope; documented
`turn.py:255-262`).
`VERIFY_RE` (`turn.py:36-42`) is the broad cross-ecosystem "runs the project's checks" regex used
only for this proxy; `status_of_tests(cmd)` / `runner_verdict(text)` (`turn.py:64-139`) decide
whether a compound shell command's exit status actually belongs to its test run (pipes, `||`,
`;`, `pipefail`, report-only tails) — port this carefully for DSH `bash` tool calls.

### 5.4 Paid judge + redirect writer (`judge.py`, optional; port behind a flag)

`STUCK_JUDGE_SYSTEM` (`judge.py:15-27`, quoted in full in the repo): monitors one task, reads the
leakage-safe digest, must judge workflow only, favors sparing when there is any sign of progress,
returns ONLY JSON `{"stuck": bool, "confidence": 0.0-1.0, "reason": "<short leakage-safe>"}`.
`llm_stuck_judge(digest, runner, model)` (`judge.py:30-63`): no runner/digest →
`{"stuck":None,"confidence":0.0,"reason":"no-runner","_tokens":0}`; runner exception → stuck None
`"runner-error:<e>"`; parse first `{...}` JSON; clamp confidence 0..1, reason ≤160 chars; cost via
`pricing.runner_effective_or_approx`. Default on any failure = `stuck=None` → envelope fallback.
`NUDGE_WRITER_SYSTEM` (`judge.py:66-80`): write a 2-4 sentence redirect that names the repetitive
pattern and proposes a materially different next step; HARD CONSTRAINTS: do not tell it to stop,
give up, or reduce effort; do not infer the solution or name line numbers; output plain text only.
`llm_nudge_writer` (`judge.py:83-102`): returns `{"text": raw[:1200], "_tokens": cost}`, `""` on
failure → template nudge.
Rate limiting lives in `TurnGuard` (`turn.py:191-195,282-330`): `JUDGE_BASE_GAP=5` tool calls
between judge calls; after a productive (`stuck is False`) verdict the gap grows by 5 up to
`JUDGE_MAX_GAP=20`; any other verdict resets to 5. Background judge
(`plugin/judge.py:AsyncJudge`, `turn.py:305-330`): a hook only *starts* a detached job and never
waits; while a verdict is pending the judge returns nothing (`judge-throttled`); a pending job
older than `JUDGE_STALE_S=300 s` stops blocking the next one. Tokens: `judge_tokens`,
`writer_tokens` accumulate on the turn (`turn.py:211-212,300,409`) and are copied into the
session's ledger `overhead.spiral_judge_tokens` / `spiral_nudge_writer_tokens`
(`plugin/fold.py:412-416`). An `AsyncJudge` that outlives its session appends a `kind:"overhead"`
ledger record (`plugin/judge.py:92`).

### 5.5 Turn state machine (`TurnGuard`, `turn.py:188-431`, port THIS shape)

Persisted document (`to_dict`, `turn.py:221-232`): `turn_key`, `st` (segment `SpiralState`),
`whole` (whole-turn `SpiralState`, never reset), `cum_turns`, `segment`, `nudges_done`,
`aborted`, `abort_delivered`, `events[-20:]`, `judge_last`, `judge_gap`, `judge_calls`,
`judge_tokens`, `writer_tokens`, `last_edit`, `last_verify`, `last_verify_failed`, `edits`,
`verifications`, `judge_pending`, `nudge_ready`. Stored in the session record's `turns` list
(plugin, capped `TURN_HISTORY=200`, `controller.py:31`); one guard state per prompt-turn.

`fold(name, args, result, exit_code=None, *, envelope, thr, judge, nudge_budget=1)`
(`turn.py:333-385`) — pseudocode:
```
cmd = args.command if canon_tool(name)=="bash" else None
shell_edits = shell_edit_targets(cmd)
status = status_of_tests(cmd)                       # own | hidden | mixed | None
if status in (hidden, mixed):
    v = runner_verdict(result)
    exit_code = int(v) if v is not None else (None if status=="hidden" else exit_code)
failed = None if exit_code is None else exit_code != 0
st.update(...); whole.update(...); fold_shell_edits(...)
cum_turns += 1; _track(...)                          # last_edit/last_verify/last_verify_failed
if aborted: return None
# hard cumulative backstop, with "nudge first" ladder
backstop = thr.backstop_turns or envelope*thr.backstop_mult
if backstop and cum_turns >= backstop and is_stuck(st, thr):
    reason = f"cum-backstop:{cum_turns}>={backstop:.0f}t"
    if nudges_done < nudge_budget: return _stop("nudge", reason, envelope)
    return _stop("abort", reason, envelope)
wired = _background(judge) if judge has poll else _sampled(judge)
abort, reason = assess_abort(st, envelope=envelope, judge=wired, thr=thr)
if not abort:
    if thr.nudge_on_ambiguous and reason=="judge-ambiguous-spared"
       and nudges_done < nudge_budget: return _stop("nudge","ambiguous-past-envelope",envelope)
    return None
if nudges_done < nudge_budget: return _stop("nudge", reason, envelope)
return _stop("abort", reason, envelope)
```
- nudge budget `r = 1` (`loopguard_nudges` default; passed as `nudge_budget`); once
  `nudges_done >= budget`, a further stuck verdict becomes `"abort"` (which the plugin delivers as
  a NOTICE, never a stop — see §5.6).
- `_stop(action, reason, envelope)` appends an event `{segment, action, turn_in_segment,
  cum_turns, envelope, reason, snapshot}`; only `abort` sets `aborted=True` (`turn.py:387-394`).
- `nudge_body(envelope, writer)` (`turn.py:396-413`): use the redirect the background judge
  already wrote (`nudge_ready`), else an LLM-written one if a writer is wired (charge
  `writer_tokens`), else `rules.nudge_text(self.st)`.
- `after_nudge()` (`turn.py:415-424`): `nudges_done += 1`, `segment += 1`, **reset the segment
  `SpiralState`**, reset judge cadence/pending; the whole-turn state is kept. This is the agent's
  fair recovery window and the reason a second stuck verdict needs fresh evidence.
- `summary(stopped_normally)` (`turn.py:426-431`) → `{turn_key, tool_calls, nudges, aborted,
  resolved_proxy, edits, verifications, judge_tokens, writer_tokens}`.

### 5.6 Plugin delivery + the never-stop invariant (port THIS behavior)

- Controller events (`controller.py:1-20`): `SessionStart` inject; `UserPromptSubmit` opens a
  prompt-turn; `PostToolUse` (and `PostToolUseFailure`, `controller.py:86-89`) folds one call;
  `Stop` closes the turn and, if ended-green, feeds the envelope; `SessionEnd` → detached fold.
- On `("nudge", reason)`: the redirect is delivered **mid-turn, attached to that tool result**
  (`turn.py:11-14`), and announced in one `systemMessage` line. On `("abort", reason)`: the plugin
  emits one line for the person telling them how to stop the turn, ending with the reason and call
  count; README quotes the exact form (`README.md:320-321`):
  `TokenEconomizer: this turn still looks stuck after a redirect (judge-stuck@0.82, 46 tool calls). Press Esc to interrupt it.`
  Where it appears/how to stop per host: `README.md:324-340`. **The plugin never stops the turn
  itself** (`README.md:63-64,105-106`; `controller.py:1-20`; `config.py:21-25`). `loopguard=stop`
  is read but acts as nudge with a warning (`config.py:311-314`); the old `guard` value maps to
  "stop" (`config.py:80`).
- `shadow` computes and logs decisions but never nudges/notices (`config.py:26-28`);
  `TE_DISABLE=1` disables everything; `mode=headless` only changes how the notice is delivered
  (README:324-340), never whether a turn is stopped.
- Plugin hooks fail open: any exception → `{}` + one `errors.log` line (CLAUDE.md;
  `plugin/hook.py:64` shows the single-JSON-object stdout contract).
- DSH port: implement guard as a per-turn state machine fed by DSH tool-result events, inject the
  nudge as an additional system/user-visible context message or tool-result attachment, and emit
  the "still stuck, how to stop" notice to the user. Never call a stop/cancel API.

### 5.7 Loop-guard state file and acceptance rules

`envelope.json` (§5.3). Note: rules say `envelope_min_samples` must be reached before ANY
judge/envelope action except the hard backstop; cold start never intervenes (tests:
`test_live_hooks.py:282-287` `test_cold_start_never_intervenes`). The judge is not asked before
the repo is learned (`:441`), a long turn with no trouble signs never wakes it (`:448`), only
ended-green turns feed the envelope (`:474`), subagent calls do not reach the guard (`:483`).

---

## 6. USAGE / COST ACCOUNTING

Files: `tokeneconomizer/ledger.py`, `pricing.py`, `plugin/accounting.py`, `plugin/fold.py`
(record writing), `plugin/sidecall.py` (how paid side calls are measured/estimated).

### 6.1 One cost definition

`ledger.py:1-14`: task cost = agent execution cost + mechanism LLM overhead, both on the
cache-aware "effective token" basis of `pricing.effective_tokens`:

```
task_cost(t) = effective_exec(t) + overhead(t)
amortized(T) = (1/T) * Σ_{t≤T} task_cost(t)
```

`OVERHEAD_KEYS` (`ledger.py:19-26`) — per-task mechanism-overhead token fields:
`optimizer_tokens` (injection proposer), `untool_classify_tokens`, `untool_judge_tokens`,
`codex_untool_adapt_tokens`, `spiral_judge_tokens`, `spiral_nudge_writer_tokens`.
`overhead(row)` = sum of numeric values of those keys (`ledger.py:33-35`);
`effective_exec(row)` = `pricing.effective_tokens(row)` (`ledger.py:38-40`).
`CostLedger` accumulates `cum_exec`, `cum_overhead`, `n`; properties `cum_total`,
`amortized_per_task`, `overhead_frac` (`ledger.py:43-74`).
**Faithful port**: same field names, same formula. DSH adapter maps its own overhead fields onto
these keys or documents an equivalent set.

### 6.2 Cache-aware effective tokens (`pricing.py`)

Formula (`pricing.py:169-186`):

```
effective_tokens(rec) =
    input_tokens            * w.input          # fresh/uncached prompt
  + cache_read_input_tokens* w.cache_read      # cached re-read
  + cache_creation_input_tokens * w.cache_write
  + output_tokens          * w.output
```
else fall back to `tokens_total` at weight 1 (`pricing.py:185-186`); 0 if neither.
`has_breakdown(rec)` = `rec.get("input_tokens") is not None` (`pricing.py:163-166`).

Weight selection (`pricing.py:116-160`):
- `resolve_model(rec)`: explicit `model` (router ids `provider/model` → tail), else
  `AGENT_DEFAULT_MODEL[agent]` (`pricing.py:94-96`: only `codex → gpt-5.6-sol`), else None.
- `weights_for`: exact id in `MODEL_WEIGHTS` → that table; id contains `claude` → Claude curve;
  id known-but-unpriced → **raises `ValueError`** (hard-fail, never silently misprice);
  no id at all → Claude curve.
- Claude curve `WEIGHTS_CLAUDE` (`pricing.py:101-106`): input 1.0, cache_read 0.10,
  cache_write 1.25, output 5.0. `WEIGHTS = WEIGHTS_CLAUDE` back-compat alias.
- `MODEL_WEIGHTS` (`pricing.py:47-81`) is an **embedded price snapshot, dated 2026-07-27**
  (`pricing.py:41-42`), keyed by exact billed model id, ratios relative to input price 1.0.
  Includes claude-* (5.0 out), gpt-5.6-* (6.0 out, sol/terra cache_write 1.25/1.248),
  gpt-5.3-codex (cache_read 0.0971, cache_write 0, out 8.0), gemini, gpt-5, codex-mini-latest,
  etc. **No price data for DeepSeek models** — the DSH port must add its own table for
  `deepseek-*` ids and keep the "unknown id = explicit fallback, never silent" behavior.
- `approx_tokens(text)` = `max(1, len(text)//4)` (`pricing.py:189-191`, "~4 characters each").
- `runner_effective_or_approx(runner, prompt, raw, real)` (`pricing.py:194-205+`): use real usage
  if recovered, else runner's `estimate_effective`, else uncached estimate prompt×1 + reply×5.
  (rest: `runner_effective_or_approx` returns the runner's estimate or `approx(prompt) + 5 *
  approx(reply)`; `sidecall.py` is the host-side caller, **DROPPED** — DSH provides its own
  side-call adapter.)

### 6.3 Ledger record fields (what a DSH port must record per session)

`plugin/fold.py:369-419` builds one JSON object appended to `ledger.jsonl`:

```jsonc
{
  "kind": "session",
  "session_id": "...", "host": "claude|codex|copilot|pi|opencode",
  "repo": "<label like owner/repo>",
  "folded_at": 0.0, "started": null, "ended": null,
  "shadow": false,
  "prompts": 23,                       // host-reported prompt count (null if unknown)
  "error": "transcript unreadable",    // only on failure
  "injection": {"optimizer_tokens": 0.0, "rendered_chars": 0},
  "untool": {"proposal": [...], "pending": false, "restored": [...]},
  "model": "<billed model id>",
  "requests": 42,
  "input_tokens": 0, "cache_read_input_tokens": 0,
  "cache_creation_input_tokens": 0, "output_tokens": 0,
  "effective_tokens": 123456.7, "priced_by": "model|fallback|no_usage",
  "turns": 12, "nudges": 0, "aborts": 0, "injected_chars": 812,
  "untool_applied": ["Notebook"],
  "overhead": {"optimizer_tokens": 0.0, "spiral_judge_tokens": 0.0,
               "spiral_nudge_writer_tokens": 0.0}
}
```
(`kind: "overhead"` records also exist in `ledger.jsonl` for paid calls whose session ended —
e.g. the background stuck judge, `plugin/judge.py:92`; `accounting.summarize` explicitly counts
`kind ∈ {"session","overhead"}` when summing overhead, `accounting.py:40-41`.)

### 6.4 Plugin accounting (`plugin/accounting.py`)

- `FALLBACK_WEIGHTS` (`accounting.py:14`): input 1.0, cache_read 0.10, cache_write 1.25,
  **output 6.0**. Rationale: a live user's session must be recorded even when the billed id is
  not in `MODEL_WEIGHTS`; the record then carries `priced_by: "fallback"`
  (`accounting.py:1-11,17-26`). Claude ids never need it.
- `effective(usage)` → `(effective_tokens, priced_by)`; `priced_by ∈ {"model","fallback",
  "no_usage"}`; `no_usage` when no breakdown (`accounting.py:17-19`).
- `summarize(records)` (`accounting.py:33-53`) → dict `{sessions, priced_sessions,
  effective_tokens, overhead_tokens, overhead_frac, requests, nudges, aborts, turns,
  injected_sessions}`; only priced sessions contribute exec totals; overhead counted from
  `kind ∈ {"session","overhead"}`.
- `fmt_tokens(n)` → `B/M/k` with 1 decimal (`n/a` for None) (`accounting.py:56-64`).
- Price data: **embedded snapshot only**, no network calls, no provider price API. Unknown
  pricing represented by (a) hard error in `pricing.weights_for`, (b) `priced_by:"fallback"` +
  labeled fallback curve in live accounting, (c) `no_usage` when the host log has no breakdown.
- **No fabricated savings**: README's accuracy claims are paper-sourced and the plugin's own
  text "makes no claims of effect" (CLAUDE.md). `te status` prints observed totals only. The DSH
  port must not synthesize "% saved" numbers; report ledger sums + overhead fraction, and let the
  user compare.

### 6.5 Where overhead is recorded / attributed

- Injection proposer: `_fold_microskills` returns `{"optimizer_tokens":..., "rendered_chars":...}`
  from `stage.after_task` (`fold.py:86-94`), which is `stage.after_task`'s optional-tokens return
  (`stage.py:1-29`); folded into the ledger `overhead.optimizer_tokens` (`fold.py:412-416`).
- Loop-guard judge / nudge writer: session record fields `judge_tokens`, `writer_tokens`
  (`fold.py:415-416`) → `overhead.spiral_judge_tokens`, `overhead.spiral_nudge_writer_tokens`.
- Tool judge/classifier: `untool_*` overhead keys (ledger.py:21-23); **UNKNOWN** which live
  plugin path writes them (benchmark-side; live pruning has no paid call by default).
- Side calls are made through the agent's own CLI (`plugin/sidecall.py`), so their cost appears in
  the host's usage totals too; `sidecall` returns effective tokens so the ledger attributes them
  (read `plugin/sidecall.py` in §7 work).

---

## 7. CONFIG & COMMANDS

### 7.1 Settings (`plugin/config.py`)

Defaults (`LiveConfig`, `plugin/config.py:141-166`):

| Setting | Default | Rejected min | Choices | Meaning |
|---|---|---|---|---|
| `enabled` | True | — | bool | master switch (not a JSON key? set via TE_DISABLE) |
| `mode` | `"auto"` | — | `auto,interactive,headless` | whether a person is at the UI |
| `microskills` | `"off"` | — | `off,envfacts,envfacts+distiller,distiller` | mechanism mode; `on` → `envfacts+distiller` |
| `microskills_max_facts` | 4 | 1 | int | injected fact cap |
| `microskills_max_tokens` | 150 | 1 | int | injected block token cap (~4 chars/token) |
| `microskills_propose_every` | 3 | 1 | int | k: sessions between paid proposer runs |
| `toolprune` | `"auto"` | — | `off,propose,auto` | mechanism mode; `on` → `auto` |
| `toolprune_evidence` | 10 | 1 | int | p: unused prompts required |
| `toolprune_min_sessions` | 2 | 1 | int | m: sessions those prompts must span |
| `toolprune_sessions` | 5 | 1 | int | s: OR this many sessions any length |
| `toolprune_quiet_minutes` | 60 | **0** | int | q: idle minutes before `auto` writes deny list |
| `toolprune_protect` | `[]` | — | list of names/globs | tools never proposed; comma-separated in files/env |
| `loopguard` | `"nudge"` | — | `off,nudge,stop` | `on` → nudge; `stop` read as nudge + warning (`config.py:311-314`) |
| `loopguard_aggr` | `"default"` | — | `conservative,default,aggressive` | threshold preset |
| `loopguard_nudges` | 1 | 1 | int | r: redirects per turn |
| `loopguard_thresholds` | `{}` | — | dict | pinned `loopguard.<name>` overrides |
| `repomap` | `"off"` | — | `off,on,start` | opt-in repository map |
| `repomap_tokens` | 2048 | 1 | int | map token budget |
| `repomap_python` | `""` | — | str | python exe for map generator |
| `repomap_timeout` | 8 | 1 | int | map generator seconds |
| `paid_model` | `""` | — | str | model for side calls ("" = host default) |
| `shadow` | False | — | bool | compute+log every decision, never act |
| `vocabulary` | `"auto"` | — | `auto,generic,python-git,node-web` | env-facts vocabulary |

`LOOPGUARD_KEYS` (`config.py:108-122`), the pinnable thresholds: `min_turns` (int≥1),
`edit_churn` (int≥1), `distinct_edit_files` (int≥1), `error_outputs` (int≥1), `stagnation`
(float 0..1), `envelope_pct` (float 1..100), `envelope_margin` (float≥0.1),
`envelope_min_samples` (int≥1), `backstop_mult` (float≥0.1), `judge_confidence` (float 0..1),
`gate_min_turns` (int≥1), `gate_error_outputs` (int≥1).

Precedence (`config.py:55-60,291-315`): defaults → `<root>/config.json` → `<repo>/config.json`
→ environment. Within a source, new name beats old alias. Invalid values are ignored with
`cfg.warnings` entries, never raised. Aliases (`config.py:82-95`): `inject→microskills`,
`inject_max_facts`, `inject_max_tokens`, `propose_every→microskills_propose_every`,
`untool→toolprune`, `untool_evidence`, `spiral→loopguard`, `spiral_aggr`, `spiral_nudges`,
`spiral_thresholds→loopguard_thresholds`. Obsolete: `paid` (`config.py:99-103`). Value alias:
`loopguard="guard"` → `"stop"` (`config.py:80`).
`TE_DISABLE=1|true|yes|on` → `enabled=False` (`config.py:309-310`).
Env vars = `TE_` + upper-cased setting name; old aliases also read, new wins
(`_ENV`, `config.py:253-273`); `TE_LOOPGUARD_THRESHOLDS`/`TE_SPIRAL_THRESHOLDS` take JSON
(`config.py:274,303-308`).
Writes: `write_config(path, updates)` validates against a fresh `LiveConfig`, canonicalizes,
moves `spiral_thresholds` into `loopguard_thresholds`, atomic `path+".tmp"` → `os.replace`
(`config.py:318-387`). `unset_config` removes keys by either spelling (`config.py:358-379`).
DSH port: same names/defaults for familiarity; env prefix may stay `TE_` (honour existing user
config) — Lead decision. Note `enabled` is not a dataclass field key users set; `TE_DISABLE`
is the switch.

### 7.2 Command surface (`plugin/cli.py`, `README.md:212-236`, `plugin/README.md` Commands)

Entry: `te [--cwd PATH] [--host HOST] <command> [args]` (`cli.py:705-758`); host defaults to
the agent whose shell runs it, else the agent whose state last changed (`cli.py:761-786`).
`main` always calls `secure_root()` in a `finally` (`cli.py:778-786`).

| Command (aliases) | Args | What it prints / does | Source |
|---|---|---|---|
| `status` | `--json` | repo label/root/key/`identified_by`, host, state dir, full config + warnings, session note; microskills {profile, injected_lines, sessions_folded}; toolprune {mode, sessions, prompts, catalog_source, proposal, applied}; loopguard {mode, envelope (tool calls or "not learned yet"), ended_green_turns}; ledger summary (sessions, effective tokens, overhead, overhead_frac, requests, nudges, aborts, turns, injected_sessions) | `cli.py:108-174`; JSON schema exactly that dict |
| `microskills` (`facts`) | — | the rendered block, or "(nothing injected yet: no fact has cleared its firing gate)"; if `off`: explanation + still shows tracked facts; then `facts tracked:` rows `STATE fire=n/m INJECTED? id` from `injection.json.facts` (distiller `debug_row`) | `cli.py:177-195` |
| `toolprune` (`untool`) | action ∈ `show, apply, restore, refresh-catalog, measure, apply-pending`; tools… | `show` prints evidence per unit (sessions/prompts unused, `USED (kept)`), pending status (`written once sessions idle q minutes`), proposal + whether evidence threshold met (`-p prompts over m+ sessions, or s sessions`), applied list; `apply` writes the proposal through the host writer and reports; `restore` removes the plugin's rules, tools become "given back"; `refresh-catalog` rebuilds catalog state; `measure` (agent-specific); `apply-pending` is the detached quiet-period waiter | `cli.py:199-389`, `_wait_and_apply:261-291` |
| `config` | action ∈ `show, set, unset`; pairs `k=v`; `--global` | `show` prints every setting in effect + provenance (which source set it) and warnings; `set` validates + writes to repo `config.json` (or global with `--global`), rejects obsolete keys with explanation; `unset` removes keys | `cli.py:426-504`; view helper `_config_view` |
| `fold` | `--session SID` (repeatable), `--verbose` | folds finished session(s) into all mechanisms; prints the ledger record(s) | `cli.py:505-515`; `fold.fold_session` |
| `judge` | `--session`, `--job` | background judge job worker (internal; called by hooks) | `cli.py:516-523`, `plugin/judge.py` |
| `repos` | action ∈ `list, migrate, merge`; keys…; `--json`, `--quiet` | per state-directory rows: identity/agents/sessions/checkouts/notes; `merged` count and "nothing deleted" note; migration output | `cli.py:540-604`; `repos.listing` |
| `repomap` | action ∈ `show, refresh` | opt-in repository map state (cached tokens/commit) or refresh | `cli.py:390-411` |
| `doctor` | — | environment/diagnostic checks | `cli.py:614-704` |
| `probe` | `--sessions N --model M --keep` | end-to-end live probe on real Copilot sessions (NOT ported) | `cli.py:606-613`, `probe.py` |

Behaviours to preserve in a DSH port: commands are read-only except `config set/unset`,
`toolprune apply/restore/apply-pending`, `fold`, `repos migrate/merge`, `repomap refresh`;
`status --json` is a stable machine-readable surface; all counts/sums come from the same
`ledger`/`accounting` definitions the mechanisms write (§6); output never claims savings.
Inside a host CLI a command costs one model turn; from a terminal it is free
(`README.md:234-236`) — same for DSH: implement as both a slash/agent command surface and a CLI.

### 7.3 Host names in the plugin

`plugin/hosts.py` defines `HOSTS` and per-host adapters (`claude, codex, copilot, pi, opencode`)
with hook names, transcript discovery, catalog parsing, usage extraction, deny-list writers,
headless detection (`hosts.py:1-519`). **DROPPED in the DSH port**; replaced by one DSH host
adapter (transcript reader from DSH session events, tool catalog from DSH tool registry, usage
from DSH usage events, deny list via DSH settings, headless detection via DSH mode).

## 8. SECURITY / PRIVACY

### 8.1 Session logs are untrusted data

- The paid proposer reads only a **compact digest**, never raw transcripts
  (`distiller.py:1-14,108-136`); the judge reads only `recent_digest` — commands, searches,
  edited file *basenames*, error *signatures* — never file contents, edit bodies, view output,
  or the task text (`state.py:1-8,214-232`; `judge.py:1-8`).
- `build_generic_digest` normalizes paths relative to the repo and `~`, masks hex/paths/numbers
  in error signatures (`distiller.py:174-195`), and the prompt says digests are data, not
  instructions implicitly (the proposer is told to emit JSON; a malicious command string is just
  an 80-char template). The judge prompt says "Judge ONLY the workflow from the digest; do NOT
  infer the task's solution" (`judge.py:21-26`).
- The nudge writer is constrained to be leakage-safe and redirect-only; **it must not tell the
  agent to stop** (`judge.py:66-80`). The template nudge mirrors only the agent's own actions
  (`rules.py:183-198`).
- No telemetry: "What it learns stays on your machine, in `~/.tokeneconomizer`" (`README.md:70-72`);
  the plugin makes no network calls of its own — model calls go through the user's own agent CLI
  login/plan (`README.md:69-71`, `plugin/sidecall.py:1-40`; CLAUDE.md: never hard-code a key).
- The plugin "needs no API key of its own and never handles credentials" (`README.md:110-112`);
  `sidecall` runs the host CLI with the user's existing auth, and `toolcheck.py:143` notes the
  credential/quota-free path. No secret env vars are stored.
- **No general secret-redaction pass** exists in `tokeneconomizer/`: privacy is achieved by
  *not sending* content (digests only) plus path normalization, not by pattern-masking secrets.
  Only the model **tool judge** text says "(redacted) task text" (`toolprune/tools.py:68`) but no
  redactor is shipped — the caller is expected to pass a redacted statement.
- File permissions: state root dir 0700, new files private via umask 077 in the launcher, an
  existing looser root is tightened (`plugin/paths.py:33-46,53-84`); launcher chmod 0700.
- Failure containment: every hook result is a single JSON object on stdout; exceptions become `{}`
  and one `errors.log` line, so mechanism prints can never corrupt agent protocol output
  (`plugin/hook.py:60-85`; tests `test_live_hooks.py:936`).
- Known weaknesses a DSH port must fix:
  1. **Injection framing**: the env-facts block is plain markdown (header + bullets), not
     delimited as untrusted data. A command string learned from a session ends up inside a fact
     claim; `lint_ok` only screens advice-like words (`envfacts.py:50-52`). DSH should wrap the
     block in explicit data delimiters and keep the "learned from past sessions, may be stale"
     framing, and should sanitize control chars/newlines in learned strings (upstream claims are
     single-line by construction but commands can contain `\n`; `segments()` splits on newlines so
     a form should not, yet `_usage`/`claim` do not re-check).
  2. **Path handling**: repo/home paths are stripped in distiller digests but a fact claim may
     embed absolute paths from a command (e.g. `~/.local/bin/pytest`) — that is user data inside
     the state dir; DSH root is private but a port should normalize/strip user paths where
     possible.
  3. **Shell parsing**: `segments()` is a hand-written splitter, not a real shell parser; it
     intentionally ignores expansion/subshells, so an adversarial command can influence
     classification but cannot execute anything (the plugin never runs observed commands).
     Acceptable; do not "improve" by executing/shelling out.
  4. **Unbounded growth**: `injection.json` grows with facts; ledger/events/fold logs are
     append-only JSONL with no rotation (`store.append` has no cap; `read_lines` tail-limits
     reads). `envelope.json` capped at 500 samples; `raw_window`/digests capped; `distiller`
     state can grow via facts/extractors (cap 12 extractors, no fact cap in distiller besides
     admission churn — facts retire but stay in state). DSH port should cap facts/extractors and
     rotate/compact logs.
  5. **Corrupt JSON fails closed**: `Store.read` returns default (fine), but `EnvFactsDistiller.load`
     / `Distiller.load` call `json.load` without try (raises); a port should catch and rebuild
     (one bad file should not disable learning forever).
  6. **Fact claims are injected text**: a wrong learned command reduces trust; the firing gate and
     contradiction lifecycle mitigate but a port should keep the "may be stale, verify" framing.

## 9. TEST CASES TO PORT

Upstream tests are offline (`pytest`, `tests/`). A DSH JS suite should reproduce the behavior
below against a fixture transcript adapter. Names marked **P** = port now; **D** = drop
(host-specific or benchmark-only).

### 9.1 Micro-skills / observation (`tests/test_envfacts.py`, `test_envfacts_args.py`, `test_generic_microskills.py`)

| Upstream test (file:line) | Setup | Asserts | Ported name |
|---|---|---|---|
| `test_classify_forms_and_intents` (envfacts.py:53) | dict of commands | intent/form classification incl. `python -m pytest`, `cd tests && python runtests.py`, activation prefixes | `observe.classifyFormsAndIntents` **P** |
| `test_error_classes_are_environmental_only` (:76) | outputs | only FORM/NETWORK error phrases classify; arbitrary errors don't | `observe.errorClassesAreEnvironmentalOnly` **P** |
| `test_interpreter_fact_forms_fires_and_renders` (:85) | 3 sessions: `python` fails w/ ModuleNotFoundError, later `python3` works | CANDIDATE→ACTIVE after 3 confirms, firing gate, rendered claim | `envfacts.formsInterpreterFact` **P** |
| `test_clean_environment_forms_nothing` (:98) | clean sessions | no facts | `envfacts.cleanEnvironmentFormsNothing` **P** |
| `test_prevented_waste_still_counts_as_firing` (:107) | injected fact, no failure | fired counts when waste prevented (injected + working form ran) | `envfacts.preventedWasteCountsAsFiring` **P** |
| `test_bare_runner_success_contradicts_and_retires` (:119) | bare `python -m pytest` succeeds | FormRepair contradict → RETIRED | `envfacts.bareRunnerSuccessRetires` **P** |
| `test_bare_one_liner_success_is_not_a_contradiction` (:133) | bare interpreter one-liner ok | no contradiction (not runner) | `envfacts.bareInterpreterOneLinerNotContradiction` **P** |
| `test_history_fact_forms_only_when_probes_return_nothing` (:145) | git probes empty vs hit | EmptyProbe forms/retires | `envfacts.emptyProbeFact` **P** |
| `test_refused_hosts_form_a_boundary_fact_and_a_reachable_host_does_not` (:162) | curl failures/success | Boundary forms, contradiction by reachable host | `envfacts.boundaryRefusedHosts` **P** |
| `test_lint_refuses_completion_advice` (:180) | claim texts | `lint_ok` rejects skip/verify/stop words | `envfacts.lintRejectsAdvice` **P** |
| `test_block_is_capped_in_facts_and_tokens` (:185) | many facts, small caps | ≤max_facts, rendered chars ≤max_tokens*4 | `envfacts.blockRespectsCaps` **P** |
| `test_form_repair_facts_sharing_the_working_form_merge_into_one_line` (:199) | two envs same root | merged single line | `envfacts.mergeFormRepairLines` **P** |
| `test_an_environment_fact_forms_in_a_repository_where_every_session_edits_one_file` (:225) | same file every session | drift=False → still promotes | `envfacts.envFactIgnoresEditDrift` **P** |
| `test_a_form_that_only_worked_with_an_assignment_before_it_is_not_named` (:263) | `PYTHONPATH=. pytest` | typed_ok excludes env-prefixed runs | `envfacts.envPrefixedRunNotNamed` **P** |
| `test_one_session_is_one_piece_of_evidence_per_form` (:273) | repeated success one session | one +1, failed takes back | `envfacts.oneEvidencePerFormPerSession` **P** |
| `test_a_named_form_that_stops_working_is_named_no_more` (:286) | later failures | b_fails subtract; claim drops | `envfacts.formStopsWorking` **P** |
| `test_env_assignments_after_env_are_part_of_how_a_command_was_typed` (:302) | `env VAR=x cmd` | assigned flag | `observe.envAssignmentForms` **P** |
| `test_save_load_roundtrip` (:312) | save/load | lifecycle state byte-stable | `envfacts.saveLoadRoundtrip` **P** |
| `test_claude_schema_yields_the_same_fact` (:320) | Claude transcript line | host adapter feeds same fact | `envfacts.dshTranscriptSameFact` (adapt to DSH fixture) **P** |
| `test_prefix_stage_envfacts_profile_needs_no_runner_and_reports_zero` (:333) | full PrefixStage | no runner call, opt_tokens 0 | `stage.envfactsProfileIsFree` **P** |
| `test_the_classifier_sees_through_rtks_command_prefix` (:350) | `rtk pytest` | same form | `observe.prefixWrappers` **P** |
| arg tests (`test_envfacts_args.py:39-337`) | label shapes, cd handling, repo top, filtered output, option errors, script-run-where-missing | `label_rule` pairs; facts form/contradict per rules; cd in form; cd stopped → nothing; absolute cd to start = no cd; cd up to repo top = no cd; repo top = nearest `.git`; subdir sessions learn repo's plain form; `bash -lc` cwd mapping | ~20 tests: port all (`argRepair.*`, `observe.cdHandling*`) **P** |
| `test_generic_microskills.py:18-148` | Node/npm build forms, language-neutral digest, proposer window persistence, prompt shows existing facts, experiments prompt identity | generic vocabulary works; digest relative to repo; window survives folds; existing claims in prompt | `observe.genericVocabulary`, `distiller.windowPersists`, `distiller.promptListsExistingFacts` **P** (last is host-free, keep) |

### 9.2 Injection / ledger / config / traces

| Upstream test | Setup / asserts | Ported name |
|---|---|---|
| `test_injection.py:14` `test_distiller_empty_render_before_formation` | fresh distiller renders "" | `distiller.emptyBeforeFormation` **P** |
| `test_injection.py:23` roundtrip | persist/load keeps facts/window | `distiller.persistRoundtrip` **P** |
| `test_injection.py:34` grounds and fires | 2 citations, detector confirms, injection appears | `distiller.groundsAndFires` **P** |
| `test_injection.py:58` after_task reports tokens | runner returns effective tokens; delta recorded | `stage.reportsProposerTokens` **P** |
| `test_ledger.py:6-40` | overhead sums only known keys; ignores non-numeric; all six keys; effective exec uses breakdown; falls back to total; amortizes | `ledger.*` (6 tests) **P** |
| `test_config.py:8-45` | mechanism config dataclass defaults/from_args | `config.coreDefaults` **P** (if we port `tokeneconomizer.config`; otherwise adapt to LiveConfig tests) |
| `test_live_config.py:22-215` | on/off aliases; threshold typing/ranges; set/unset; repo>global>env precedence; old names; fact cap defaults; pinned threshold wins; envelope settings reach tracker; base thresholds; guard off; more nudges; higher min_turns; injection off/tight caps; loopguard=stop warns; quiet window 0 | `config.*` (~11 tests) **P** |
| `test_trace.py:1-234` | per-host transcript readers (Claude/Codex/Copilot/Pi/opencode) | **D** — host readers dropped; but port the *normalized call shape* test with a DSH fixture (`test_trace.py` is a useful shape reference) |
| `test_plugin_package.py` | package boundaries: mechanisms never import plugin; no experiments imports; plugin manifests/scripts exist; state names stable | adapt: `arch.noPluginImportsFromMechanisms` **P** (our port: lib modules must not import the DSH adapter), `arch.stateNamesStable` **P**; drop manifest/bundle tests |
| `test_generic_microskills.py:143` `test_the_experiments_proposer_prompt_is_the_papers` | prompt text exact | **D**/adapt only if we keep the paid layer |

### 9.3 Loop guard (`tests/test_live_core.py`, `test_live_hooks.py` selected)

| Upstream test | Setup / asserts | Ported name |
|---|---|---|
| `test_live_core.py:615` `test_edits_made_through_the_shell_are_recognised` | `sed -i`/`perl -pi`/`patch`/redirect cmds → edit targets | `guard.shellEditsRecognized` **P** |
| `:619` shell edits reach state + ended-green proxy | shell edit counts as edit; verification after it decides green | `guard.shellEditsFeedProxy` **P** |
| `:633` reading an assert-heavy file is not a failure | content tools can't fail from output alone | `guard.contentToolNotFailure` **P** |
| `:653` judge told real verification state | live digest replaces "NOT green" | `guard.judgeDigestVerificationState` **P** |
| `:693` background judge starts once, verdict nudges a later call | async judge flow | `guard.backgroundJudge` **P** (if async ported) |
| `:705` productive verdict backs judge off | gap 5→10 | `guard.judgeBackoff` **P** |
| `:713` job that never answers stops blocking | JUDGE_STALE_S | `guard.staleJudge` **P** |
| `test_live_hooks.py:282` cold start never intervenes | no envelope → no action | `guard.coldStartSpares` **P** |
| `:287` warm guard nudges then only notifies | first stuck=redirect, second=notice only | `guard.nudgesThenNotifies` **P** |
| `:336` redirect then tells person how to stop on every agent | host delivery texts | adapt to DSH delivery: `guard.delivery` **P** |
| `:474` only turns that ended green feed the envelope | resolved_proxy | `guard.envelopeOnlyGreen` **P** |
| `:441` judge not asked before repo learned | envelope warm-up | `guard.noJudgeBeforeWarm` **P** |
| `:448` long trouble-free turn never wakes judge | gate | `guard.gateStaysClosed` **P** |
| `:1049` small envelope's backstop never preempts the nudge | nudge-first ladder | `guard.nudgeBeforeBackstop` **P** |
| `:1080` runner named by path counts as verification | VERIFY_RE paths | `guard.verifyPathForms` **P** |
| `test_live_core.py:141-227` host usage/pricing tests | Claude/Copilot/Codex usage conversion | **D** host-specific; port pricing tests separately (`test_ledger`) |

### 9.4 Tool pruning (`test_live_hooks.py` selected)

| Upstream test | Asserts | Ported name |
|---|---|---|
| `:497` propose mode proposes but changes nothing until applied | propose vs auto | `toolprune.proposeModeNoWrite` **P** |
| `:520` default removes unused tools from next session and says so | auto applies + announces | `toolprune.autoAppliesAndAnnounces` **P** |
| `:547` tools given back stay back until named again | kept list | `toolprune.givenBackStayBack` **P** |
| `:591` ten prompts over two sessions are enough and one session's are not | p=10,m=2 AND-semantics | `toolprune.evidencePrompts**m` **P** |
| `:613` five sessions are enough however short | s=5 OR-branch | `toolprune.sessionsThreshold` **P** |
| `:623` session without prompts is no evidence | prompts==0 skip | `toolprune.noPromptNoEvidence` **P** |
| `:633` high-risk tool needs 3× prompts | HIGH_RISK_FACTOR=3 | `toolprune.highRiskFactor` **P** |
| `:644` protected tool never left out; old rule comes back | protected restore | `toolprune.protectedNeverPruned` **P** |
| `:683` deny list waits for repo idle q minutes | quiet period | `toolprune.quietPeriod` **P** |
| `:714` session still writing keeps list waiting | last_activity transcript mtime | `toolprune.activityDelays` **P** |
| `:728` a list that waited a day is written even if sessions never pause | PENDING_MAX_S | `toolprune.pendingMaxAge` **P** |
| `:737` pending list leaves out what was given back meanwhile | filter kept | `toolprune.pendingSkipsKept` **P** |
| `:792` apply and restore touch only the plugin's own rules | host writer contract | adapt to DSH writer: `toolprune.writerOwnRulesOnly` **P** (DSH settings implementation) |
| `:833` plugin-created settings file kept out of git | writer gitignore | adapt/DSH-specific **P-if-applicable** |
| `:844` each session folded once and priced | fold dedupe | `fold.oncePerSession` **P** |
| `:900` garbage input and internal errors answer no change | fail-open hooks | `hook.failOpen` **P** |
| `:936` mechanism prints cannot corrupt hook output | stdout contract | `hook.stdoutSingleJson` **P** |

### 9.5 Do NOT port (host-/benchmark-specific)

`test_codex_cli.py`, `test_winspawn.py`, `test_live_repomap.py`, `test_live_repos.py` (repo
migration machinery; if DSH wants repo listing, port only identity tests), most of
`test_live_core.py` (Claude/Codex/Copilot/Pi/opencode hosts, side calls, probe, opencode
deletion), `test_live_hooks.py` host-specific halves (Pi/Copilot/Codex sections after :974),
`test_contribution_*` (repo hygiene), `experiments/**` (not distributed upstream either).
`tests/conftest.py` + `tests/fixtures/` give the fake-transcript/home conventions; a DSH port
should build an equivalent fixture transcript + temp state root.

## 10. MAPPING TABLE (upstream → planned DSH port)

Planned DSH plugin layout: `lib/{microskills,toolprune,loopguard,usage,store,project}.js` +
DSH adapter + `test/`. F = faithful port (same behavior, constants, formulas); S = simplified
(rationale given); D = dropped.

| Upstream module/function | DSH port | Class |
|---|---|---|
| `microskills/observe.py`: `Vocabulary`, `PYTHON_GIT/NODE_WEB/GENERIC`, `segments`, `unwrap`, `classify_command`, `_classify`, `_probe_kind`, `error_class`, `_test_labels`, `label_rule`, `_env_calls`, `form_failed`, `form_worked`, `is_bare`, `observe_task` | `lib/microskills/observe.js` | F |
| `microskills/lifecycle.py`: `Lifecycle`, `K_PROMOTE/GAMMA/LAMBDA/SCORE_FLOOR/HARD_KILL/FIRE_GATE/FIRE_MIN_N`, `edited_files` | `lib/microskills/lifecycle.js` | F |
| `microskills/envfacts.py`: `EnvFact`, `EnvFactsDistiller`, all five families, caps, lint, render/select/merge, persistence | `lib/microskills/envfacts.js` | F |
| `microskills/distiller.py` (paid proposer, detectors, extractors, prompt) | `lib/microskills/distiller.js` | S: keep only if we ship the paid layer; digest-only input; wrap runner exceptions; add env-facts-only mode first |
| `microskills/stage.py` `PrefixStage`, `ComposedDistiller` | `lib/microskills/stage.js` | F (thin) |
| `microskills/distiller.build_generic_digest`, `error_signature`, `_relative` | part of `observe.js`/`distiller.js` | F if paid layer kept |
| `loopguard/state.py` `SpiralState`, `canon_tool`, `completed_calls`, `_failure_sig` | `lib/loopguard/state.js` | F |
| `loopguard/rules.py` thresholds, `scaled_thresholds`, `gate_for_judge`, `is_stuck`, `assess_abort`, `nudge_text` | `lib/loopguard/rules.js` | F (add `gate_over_envelope=false` pin the plugin uses — upstream default True for harness; verify before porting) |
| `loopguard/envelope.py` `EnvelopeTracker`, percentile, learned thresholds, `load/save_envelope`, `record_turn`, `ENVELOPE_HISTORY` | `lib/loopguard/envelope.js` | F |
| `loopguard/turn.py` `TurnGuard`, `status_of_tests`, `runner_verdict`, `VERIFY_RE`, `resolved_proxy`, judge rate limits, nudge ladder, `after_nudge` | `lib/loopguard/guard.js` | F |
| `loopguard/judge.py` `llm_stuck_judge`, `llm_nudge_writer`, prompts | `lib/loopguard/judge.js` | F if paid judge enabled (DSH side call); else S: template nudge only (`nudge_text`) |
| `loopguard/shell_edits.py` | `lib/loopguard/shell-edits.js` | F (adapt detection to DSH shell tool args) |
| `toolprune/tools.py` `PROTECTED_TOOLS`, `INAPPLICABLE_TOOLS` | `lib/toolprune/tools.js` | F: keep protected concept; `INAPPLICABLE_TOOLS` mostly host tool names → replace with DSH tool names or drop; tool judge → D if no task text |
| `toolprune/stage.py` `ToolingStage` evidence (used_tools, streaks, catalog) | `lib/toolprune/evidence.js` | F |
| `toolprune/codex.py` capability packages | — | D (Codex-specific) |
| `trace/catalog.py` per-host parsers; `claude_tool_catalog.json`, `CODEX_DEFAULT_TOOL_CATALOG` | `lib/toolprune/catalog.js` reading DSH tool registry | S: one adapter, no host snapshots |
| `plugin/denylist.py` (host writers, apply/restore, copilot servers, codex toml) | `lib/toolprune/denylist.js` + DSH adapter | S: policy kept; writer reimplemented for DSH settings; copilot/codex parts D |
| `plugin/fold.py` `enough_evidence`, `_fold_microskills`, `_fold_toolprune`, `apply_pending`, `schedule_pending`, `last_activity`, `pending_sessions`, `fold_session`, ledger record | `lib/project/fold.js` (`lib/store.js` for Store) | F (minus host trace conversion) |
| `plugin/paths.py` `repo_identity`, `RepoId`, `state_root`, `secure_root`, slug/digest | `lib/project/repo.js` | F (identity algorithm), root renamed for DSH |
| `plugin/store.py` `Store` | `lib/store.js` | F (atomic write, JSONL, lock with timeout, tolerant read) |
| `plugin/repos.py` migration machinery | — | D/S: fresh DSH root needs no migration; keep `index.json` optional |
| `plugin/config.py` `LiveConfig`, `load_config`, `write_config`, `unset_config`, aliases | `lib/config.js` | F (same names/defaults; env prefix decision) |
| `plugin/controller.py` hook dispatch | `lib/hooks.js` + DSH event adapter | S: map DSH session/prompt/tool/stop events to mechanism calls; keep fail-open + one-line announcements |
| `plugin/hook.py`, `winspawn.py`, `hosts.py`, `probe.py`, `sidecall.py`, `repomap*.py`, `paths.py:ensure_launcher` | — | D (host plumbing; `sidecall` → DSH side-call adapter if paid layer kept) |
| `plugin/accounting.py`, `ledger.py`, `pricing.py` | `lib/usage/accounting.js`, `lib/usage/pricing.js` | F; extend `MODEL_WEIGHTS` with DeepSeek ids; keep labeled fallback + `priced_by` |
| `plugin/cli.py` command surface | `lib/cli.js` + DSH slash command(s) | F for status/microskills/toolprune/config/doctor; D/S for fold/judge/repos/repomap/probe |
| `plugin/judge.py` AsyncJudge (background side call) | DSH adapter side-call + ledger `kind:"overhead"` | S/F conditional |
| `trace/*.py` host readers, `plugin/hosts.py` writers | DSH session-event adapter | D (replaced) |
| `plugin/` manifests, hooks, slash commands, marketplace bundle, `experiments/` | — | D |
| `tests/*` | `test/*.js` | port per §9 |

Also drop: upstream `@dataclass InjectionConfig/ToolingConfig/SpiralConfig` + `from_args`
(`config.py` top-level, harness flags only) — DSH uses `LiveConfig` equivalents.

## 11. CONSTANTS TABLE (test-fixture reference)

| Constant | Value | File:line | Meaning |
|---|---|---|---|
| `K_PROMOTE` | 3 | lifecycle.py:15 | confirmations to promote CANDIDATE→ACTIVE |
| `GAMMA` | 0.8 | lifecycle.py:16 | recency decay per task |
| `LAMBDA` | 5.0 | lifecycle.py:17 | contradiction weight |
| `SCORE_FLOOR` | 0.0 | lifecycle.py:18 | retire ACTIVE below this score |
| `HARD_KILL` | True | lifecycle.py:19 | high-stakes: one contradiction retires |
| `FIRE_GATE` | 0.40 | lifecycle.py:20 | min firing rate to inject |
| `FIRE_MIN_N` | 4 | lifecycle.py:21 | min exercised tasks for the firing rate |
| `CONTRADICT_STREAK` | 2 | envfacts.py:146 | FormRepair consecutive contradicting tasks |
| `MAX_FACTS` / `MAX_TOKENS` | 4 / 150 | envfacts.py:44-45 | env block caps (token ≈ 4 chars) |
| `HEADER` / `GENERIC_HEADER` | strings | envfacts.py:46-48 | block header line |
| `PROPOSE_EVERY` (core default) | 8 | distiller.py:28 | proposer cadence if config absent |
| `microskills_propose_every` (plugin default) | 3 | plugin/config.py:148 | k: sessions between proposer calls |
| `microskills_max_facts` / `_max_tokens` | 4 / 150 | plugin/config.py:146-147 | env layer caps (plugin defaults) |
| `WINDOW` | 8 | distiller.py:30 | digests per proposer tick |
| `MAX_CANDS` | 4 | distiller.py:31 | facts/tick |
| `MIN_CITE` | 2 | distiller.py:32 | citations required to admit a fact |
| `MAX_EXTRACTORS` | 12 | distiller.py:33 | authored extractor cap |
| `RAW_SAMPLE` | 3 | distiller.py:34 | raw excerpts on abstaining tick |
| `ABSTAIN_GATE` | 0.5 | distiller.py:35 | abstaining if ≥50% commands uncovered |
| `BLOB_CAP` | 20000 | distiller.py:37 | chars of saved digest blobs |
| `toolprune_evidence` (p) | 10 | plugin/config.py:150 | unused prompts required |
| `toolprune_min_sessions` (m) | 2 | plugin/config.py:151 | sessions those prompts span |
| `toolprune_sessions` (s) | 5 | plugin/config.py:152 | OR sessions any length |
| `toolprune_quiet_minutes` (q) | 60 | plugin/config.py:153 | idle minutes before auto write |
| `HIGH_RISK` / `HIGH_RISK_FACTOR` | {"NotebookEdit"} / 3 | plugin/adapter.py:59-61 | 3× evidence for high-risk tools |
| `PENDING_MAX_S` | 86400 (24 h) | plugin/fold.py:51 | write a pending deny list regardless |
| `WAITER_POLL_S` | 600 | plugin/fold.py:52 | pending waiter poll interval |
| `STALE_S` | 600 | plugin/fold.py:32 | unfolded session quiet time before folding |
| `FOLD_LOCK_WAIT_S` | sidecall.TIMEOUT_S+60 | plugin/fold.py:40 | fold lock wait |
| `TURN_HISTORY` | 200 | plugin/controller.py:31 | per-session turn records kept |
| `PIN_MAX_AGE_S` | 30*86400 | plugin/repos.py:41 | session pin expiry |
| `LAYOUT` | 2 | plugin/repos.py:40 | state layout version |
| `ENVELOPE_HISTORY` | 500 | loopguard/envelope.py:148 | resolved turns kept |
| `min_turns` | 20 | rules.py:21 | stuck heuristic floor |
| `edit_churn` | 4 | rules.py:22 | churn threshold |
| `distinct_edit_files` | 3 | rules.py:23 | scatter threshold |
| `error_outputs` | 6 | rules.py:24 | error density threshold |
| `stagnation` | 0.20 | rules.py:25 | repeat-failure share |
| `envelope_margin` (base) | 1.25 | rules.py:26 | envelope multiplier |
| `envelope_pct` | 90 | rules.py:27 | percentile |
| `envelope_min_samples` (e) | 5 | rules.py:30 | warm-up green turns |
| `judge_confidence` (c) | 0.7 | rules.py:31 | judge cutoff |
| `backstop_mult` (b) | 2.5 | rules.py:32 | hard backstop multiplier |
| `gate_min_turns` | 18 | rules.py:41 | judge gate floor |
| `gate_error_outputs` | 8 | rules.py:42 | judge gate error density |
| `nudge_on_ambiguous` | only "aggressive" | rules.py:64 | ambiguous past envelope → nudge |
| conservative preset | .85/1.5/3.5/.30/24/28/5/8/7 | rules.py:54-58 | judge conf/margin/backstop/stagnation/gate_min/min_turns/edit_churn/error_outputs/min_samples |
| aggressive preset | .55/1.0/1.8/.12/12/14/3/4/3 | rules.py:60-65 | same order |
| `thresholds()` turn-scale factors | 0.6*p90, clamp [6, base] / [8, base] | envelope.py:122-123 | learned gates |
| learned backstop clamp | min(env*mult, 0.9*max_turns) | envelope.py:107-110 | reachable under cap |
| `loopguard_nudges` (r) | 1 | plugin/config.py:157 | redirects per prompt-turn |
| `JUDGE_BASE_GAP` / `JUDGE_MAX_GAP` | 5 / 20 | turn.py:191-192 | judge rate limit (tool calls) |
| `JUDGE_STALE_S` | 300 | turn.py:195 | background verdict timeout |
| `_SLOTS` recent log cap | 40 | state.py:211-212 | action log length |
| `recent_digest` n | 24 | state.py:214 | actions shown to judge |
| `nudge writer` reply cap | 1200 chars | judge.py:102 | redirect text truncation |
| `pricing.WEIGHTS_CLAUDE` | 1 / .10 / 1.25 / 5 | pricing.py:101-106 | input/cache_read/cache_write/output ratios |
| `accounting.FALLBACK_WEIGHTS` | 1 / .10 / 1.25 / 6 | plugin/accounting.py:14 | labeled fallback for unpriced ids |
| `approx_tokens` | max(1, len//4) | pricing.py:189-191 | char→token estimate |
| `MODEL_WEIGHTS` snapshot date | 2026-07-27 | pricing.py:41-42 | embedded price table |
| `PROTECTED_TOOLS` | work-surface set | toolprune/tools.py:41-48 | never pruned |
| `INAPPLICABLE_TOOLS` | orchestration/scheduling/memory/interactive set | toolprune/tools.py:14-39 | never loaded by construction (host tool names) |
| `MAX_FACTS` in PrefixStage | from cfg (4 default) | microskills/stage.py:83-86 | env layer caps |
| owner/permission bits | 0700 | plugin/paths.py:33-46,82 | private state root/launcher |
| `WAITER`/`locked` defaults | timeout 10 s, poll 0.05 s | plugin/store.py:103,125 | lock policy |
| `_LINT_RE` | word set | envfacts.py:50-52 | forbidden advice words |
| `_ERROR_PHRASE` | 5 strings | envfacts.py:54-60 | rendered error phrases |

**UNKNOWNs that remain (do not invent):** exact `index.json` full schema (`repos.py:597-660`
unread); exact per-host deny-list diff/verify algorithm (`denylist.py` unread);
whether the live plugin passes `gate_over_envelope=False` and where (`rules.py:152` comment only;
turn.py does not set it — likely in `plugin/judge.py`/controller thresholds; verify before
porting); `run_kwargs`/Codex capability semantics (dropped); `plugin/toolcheck.py`/`context.py`
status semantics beyond §2/§6; exact `probe.py` behavior (dropped); upstream has **no**
`te reset` or `te disable` command (the only disable is `TE_DISABLE=1`; verified in the parser
`cli.py:705-758`) — the task brief's "reset/disable" is a DSH design choice, not upstream
behavior to reproduce.
