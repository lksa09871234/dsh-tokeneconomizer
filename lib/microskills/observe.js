/**
 * What a finished session shows about its environment: classified commands and
 * outcomes.
 *
 * Ported from `tokeneconomizer/microskills/observe.py` (Apache-2.0,
 * microsoft/TokenEconomizer @ e428fc9). Modified for the DSH port:
 *
 * - the input is a normalized DSH tool-call array (`NormalizedCall`) instead of
 *   a host transcript path; the host's transcript readers are dropped
 *   (research/UPSTREAM.md §10), so `load_trajectory`/`call_cwds` have no
 *   analogue;
 * - tool names are mapped to coarse families here instead of upstream's
 *   `("shell", "bash", "stop_bash")` set, because DSH reports raw tool names
 *   (`bash`, `ops_bash`, `pwsh`, `ops_edit_file`, ...);
 * - the default vocabulary is `GENERIC` (the plugin's reading) rather than
 *   upstream's `PYTHON_GIT` (the experiments' narrower reading);
 * - `editedFiles` / `editedPyfiles` live here (upstream has them in
 *   lifecycle.py) because the session observer is their only caller in this
 *   port, and lifecycle.js is kept to the state machine;
 * - learned strings are sanitized by the env-facts layer (`envfacts.js`), not
 *   here: this module returns observations, not injected text.
 *
 * Each shell command is split into segments, and each segment is classified by
 * INTENT (run the interpreter, run the tests, use the package tool, fetch from
 * a host, probe the VCS) and FORM (how it was spelled: `python -m pytest`,
 * `/opt/env/bin/python -m pytest`, `cd tests && python runtests.py`). Its
 * outcome is read off the output as an environmental error class
 * (`module_missing`, `command_missing`, `connection_refused`, ...) or a sign
 * that tests ran. Nothing here names a path, a repository or a harness: the
 * words that name intents are a `Vocabulary` the domain supplies.
 *
 * Nothing here executes, expands or evaluates an observed command: `segments`
 * is a hand-written splitter (upstream's deliberate conservatism, UPSTREAM §8).
 *
 * @module dsh-tokeneconomizer/microskills/observe
 */

import fs from 'node:fs'
import path from 'node:path'

// --------------------------------------------------------------------------------------
// vocabulary -- the domain-supplied words that name intents (never harness constants)
// --------------------------------------------------------------------------------------

/**
 * What the families recognise as an interpreter, a test runner, a package tool,
 * a fetcher, an environment probe. A domain supplies one; the families
 * themselves are the same for every vocabulary.
 *
 * Upstream: `Vocabulary`, observe.py:25-46.
 */
export class Vocabulary {
  /**
   * @param {object} spec
   * @param {string} spec.name
   * @param {Iterable<string>} spec.interpreters Executables that run the language.
   * @param {string} spec.canonicalInterpreter How a shebang-run script is spelled as a form.
   * @param {Iterable<string>} spec.runnerHeads Bare test-runner executables.
   * @param {Iterable<string>} [spec.runnerScripts] Scripts that ARE the runner when an interpreter runs them.
   * @param {Iterable<string>} [spec.runnerModules] `<interpreter> -m <module>` runners.
   * @param {Iterable<string>} spec.packageTools
   * @param {Iterable<string>} [spec.fetchHeads]
   * @param {Iterable<string>} [spec.envProbeHeads]
   * @param {Iterable<string>} [spec.taskHeads] Tools whose `<tool> test` runs the tests.
   * @param {Iterable<string>} [spec.buildHeads] Executables that build, compile, lint or type-check.
   * @param {boolean} [spec.generic] Language-neutral reading: builds/checks are an intent of
   *   their own and every edited file counts.
   */
  constructor(spec) {
    /** @type {string} */
    this.name = spec.name
    /** @type {Set<string>} */
    this.interpreters = new Set(spec.interpreters)
    /** @type {string} */
    this.canonicalInterpreter = spec.canonicalInterpreter
    /** @type {Set<string>} */
    this.runnerHeads = new Set(spec.runnerHeads)
    /** @type {string[]} */
    this.runnerScripts = [...(spec.runnerScripts ?? [])]
    /** @type {Set<string>} */
    this.runnerModules = new Set(spec.runnerModules ?? [])
    /** @type {Set<string>} */
    this.packageTools = new Set(spec.packageTools)
    /** @type {Set<string>} */
    this.fetchHeads = new Set(spec.fetchHeads ?? ['curl', 'wget'])
    /** @type {Set<string>} */
    this.envProbeHeads = new Set(spec.envProbeHeads ?? ['which', 'command', 'type', 'whereis'])
    /** @type {Set<string>} */
    this.taskHeads = new Set(spec.taskHeads ?? ['make', 'npm', 'yarn', 'pnpm', 'cargo', 'go'])
    /** @type {Set<string>} */
    this.buildHeads = new Set(spec.buildHeads ?? [])
    /** @type {boolean} */
    this.generic = spec.generic === true
  }
}

/** Python/git reading: upstream's `PYTHON_GIT` (observe.py:49-58). */
export const PYTHON_GIT = new Vocabulary({
  name: 'python-git',
  interpreters: ['python', 'python2', 'python3', 'pypy', 'pypy3'],
  canonicalInterpreter: 'python',
  runnerHeads: ['pytest', 'py.test', 'tox', 'nox', 'nosetests', 'trial'],
  runnerScripts: ['runtests.py', 'bin/test', 'bin/doctest', 'manage.py'],
  runnerModules: ['pytest', 'unittest', 'nose', 'django', 'tox', 'nox'],
  packageTools: ['pip', 'pip3', 'conda', 'mamba', 'poetry', 'pipenv', 'uv', 'apt', 'apt-get'],
})

/** Node/web reading: upstream's `NODE_WEB` (observe.py:60-69). */
export const NODE_WEB = new Vocabulary({
  name: 'node-web',
  interpreters: ['node', 'nodejs', 'deno', 'bun', 'tsx', 'ts-node'],
  canonicalInterpreter: 'node',
  runnerHeads: ['jest', 'vitest', 'mocha', 'playwright', 'cypress', 'ava', 'karma'],
  runnerScripts: [],
  runnerModules: [],
  packageTools: ['npm', 'yarn', 'pnpm', 'corepack', 'apt', 'apt-get'],
})

/**
 * The plugin's reading: every ecosystem at once, since a repository a person
 * works in may mix them. Upstream's `GENERIC` (observe.py:72-90).
 */
export const GENERIC = new Vocabulary({
  name: 'generic',
  interpreters: [
    'python', 'python2', 'python3', 'pypy', 'pypy3',
    'node', 'nodejs', 'deno', 'bun', 'tsx', 'ts-node',
    'ruby', 'perl', 'php', 'Rscript', 'julia', 'lua', 'elixir',
  ],
  canonicalInterpreter: 'python',
  runnerHeads: [
    'pytest', 'py.test', 'tox', 'nox', 'nosetests', 'trial',
    'jest', 'vitest', 'mocha', 'playwright', 'cypress', 'ava', 'karma',
    'rspec', 'phpunit', 'ctest', 'bats',
  ],
  runnerScripts: ['runtests.py', 'bin/test', 'bin/doctest', 'manage.py'],
  runnerModules: ['pytest', 'unittest', 'nose', 'django', 'tox', 'nox'],
  packageTools: [
    'pip', 'pip3', 'conda', 'mamba', 'poetry', 'pipenv', 'uv', 'apt', 'apt-get',
    'npm', 'yarn', 'pnpm', 'corepack',
    'gem', 'bundle', 'composer', 'cargo', 'go', 'mvn', 'gradle', 'dotnet', 'brew',
    'rustup', 'pyenv', 'nvm', 'asdf',
  ],
  taskHeads: ['make', 'npm', 'yarn', 'pnpm', 'cargo', 'go', 'mvn', 'gradle', 'gradlew', 'dotnet', 'mix', 'swift', 'rake'],
  buildHeads: [
    'make', 'cmake', 'ninja', 'bazel', 'tsc', 'eslint', 'prettier', 'ruff', 'flake8',
    'pylint', 'mypy', 'pyright', 'black', 'isort', 'golangci-lint', 'gcc', 'g++', 'clang',
    'javac', 'webpack', 'vite',
  ],
  generic: true,
})

/** The DSH plugin's default domain reading (see module docstring). */
export const DEFAULT_VOCAB = GENERIC

/**
 * `<tool> build`, `npm run lint`, ...: what a generic reading counts as
 * building or checking. Upstream: `BUILD_SUBS`, observe.py:92-93.
 */
export const BUILD_SUBS = new Set(['build', 'check', 'compile', 'lint', 'vet', 'typecheck', 'type-check', 'clippy', 'package', 'verify', 'fmt', 'format'])

/** Upstream: `_RUN_SCRIPT_HEADS`, observe.py:94. */
const RUN_SCRIPT_HEADS = new Set(['npm', 'yarn', 'pnpm', 'bun'])

/** `git <sub>` that fetches from a remote. Upstream: `GIT_FETCH_SUBS`, observe.py:104. */
export const GIT_FETCH_SUBS = new Set(['fetch', 'clone', 'pull', 'ls-remote'])
/** `git <sub>` that can probe refs beyond the checkout. Upstream: observe.py:105-106. */
export const GIT_PROBE_SUBS = new Set(['remote', 'branch', 'tag', 'fsck', 'stash', 'show-ref', 'for-each-ref'])
/** Commands that consult the environment without changing it. */
export const ENV_PROBE_HEADS = PYTHON_GIT.envProbeHeads
/** Transparent wrappers stripped before the intent head is read. Upstream: `PREFIX_HEADS`, observe.py:108. */
export const PREFIX_HEADS = new Set(['sudo', 'env', 'time', 'exec', 'nice', 'nohup', 'timeout'])
/** Segments that neither add evidence nor pollute a call's output. Upstream: `_PASSTHROUGH`, observe.py:109-110. */
const PASSTHROUGH = new Set(['cd', 'echo', 'head', 'tail', 'cat', 'sort', 'uniq', 'tee', 'true', 'printf', 'less', 'more'])

/** Intents whose outcomes are attributed per call (observe.py:645-673). */
const ACTING_INTENTS = new Set(['run_interpreter', 'run_tests', 'run_build', 'package_tool', 'fetch_remote'])

// ---- tool-name families -----------------------------------------------------------------
// `lib/microskills` must not import the DSH adapter (upstream pins the same
// separation for its mechanisms), so the coarse families the observer needs are
// matched here. Kept in sync with `lib/dsh/normalize.js:toolFamily`; the DSH
// adapter tests pin the other spelling of these rules.
const SHELL_TOOL_RE = /(^|_)(bash|shell|pwsh|powershell|terminal)(_|$)/
const EDIT_TOOL_RE = /edit_file|str_replace|replace_|apply_patch|^edit$|multiedit/
const CREATE_TOOL_RE = /write_file|create_file|^write$|^create$/

/** Upstream's exact shell-tool names (observe.py:607). */
const SHELL_TOOLS = new Set(['shell', 'bash', 'stop_bash'])

/**
 * Whether a raw host tool name is a shell call the observer classifies.
 *
 * @param {string} tool
 * @returns {boolean}
 */
export function isShellTool(tool) {
  const lower = String(tool ?? '').toLowerCase()
  return SHELL_TOOLS.has(lower) || SHELL_TOOL_RE.test(lower)
}

/**
 * @param {string} tool
 * @returns {boolean}
 */
function isEditTool(tool) {
  const lower = String(tool ?? '').toLowerCase()
  return EDIT_TOOL_RE.test(lower) || CREATE_TOOL_RE.test(lower)
}

/**
 * @param {string} tool
 * @returns {boolean}
 */
function isApplyPatchTool(tool) {
  return /apply_patch/.test(String(tool ?? '').toLowerCase())
}

// ---- regexes (observe.py:112-125) --------------------------------------------------------
const ACTIVATE_RE = /^(?:source|\.)\s+\S*activate\s+([\w.-]+)\s*$/
const CD_RE = /^cd\s+(['"]?)([^\s;&|'"]+)\1\s*$/
const CD_FAILED_RE = /\bcd: [^\n]*: (?:No such file or directory|Not a directory)/
const CONDA_ACTIVATE_RE = /^(?:conda|mamba)\s+activate\s+([\w.-]+)\s*$/
const CONDA_RUN_RE = /^(?:conda|mamba)\s+run\s+(?:--no-capture-output\s+|--live-stream\s+)*(?:-n|--name)\s+([\w.-]+)\s+/
const TOOL_RUN_RE = /^(poetry|pipenv|uv|npx|bundle|yarn|pnpm)\s+(?:run|exec)\s+/
const NPX_RE = /^npx\s+(?:(?:--yes|-y|--no-install|--no)\s+)*/
const INTERP_VERSIONED_RE = /^(?:python|node)\d(?:\.\d+)?$/
const ENV_ASSIGN_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/
const ASSIGN_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const WRAP_RE = /^\/bin\/(?:ba)?sh\s+-l?c\s+([\s\S]*)$/
const HEREDOC_RE = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/
const URL_HOST_RE = /https?:\/\/([^/\s'"`]+)/g
const DRIVE_RE = /^\/([A-Za-z])(?=\/|$)|^([A-Za-z]):(?=\/|$)/

// rtk in its Codex mode puts `rtk`/`rtk proxy` in front of every command the
// agent types (trace/calls.py:22). Upstream strips it in trace; the DSH adapter
// has no rtk layer, but the helper is kept and exported for parity.
const RTK_PREFIX_RE = /^rtk\s+(?:proxy\s+)?(?=\S)/

/**
 * `rtk pytest -q` -> `pytest -q`; anything else unchanged.
 *
 * @param {string} command
 * @returns {string}
 */
export function stripRtkPrefix(command) {
  return String(command ?? '').replace(RTK_PREFIX_RE, '')
}

// ---- error classes (observe.py:127-149) --------------------------------------------------
/**
 * Error classes an ENVIRONMENT produces (as opposed to the code under test).
 * Order matters: the first match names the class.
 *
 * @type {Array<[string, RegExp]>}
 */
export const ERROR_CLASSES = [
  ['module_missing', /ModuleNotFoundError|No module named|Cannot find module|ERR_MODULE_NOT_FOUND/i],
  ['command_missing', /command not found|: not found\b|is not recognized/i],
  // The interpreter started, but the script it was told to run is not where it looked:
  // `python runtests.py` outside the directory that has it.
  ['script_missing', /can't open file .*No such file or directory/i],
  ['permission_denied', /Permission denied|EACCES/i],
  ['usage_error', /^usage:|unrecognized arguments|no such option|error: argument|unknown option/im],
  ['connection_refused', /Connection refused|Failed to connect to|couldn't connect to|Could not connect|ECONNREFUSED/i],
  ['name_resolution', /Could not resolve host|Temporary failure in name resolution|Name or service not known|getaddrinfo|nodename nor servname|ENOTFOUND/i],
  ['unreachable', /Network is unreachable|No route to host|Connection timed out|Operation timed out|timed out after|ETIMEDOUT/i],
]

/** @type {Map<string, RegExp>} */
const ERROR_CLASS_RX = new Map(ERROR_CLASSES)

/** Environmental errors that mean "the network/host is not reachable from here". */
export const NETWORK_ERRORS = new Set(['connection_refused', 'name_resolution', 'unreachable'])
/** Environmental errors that mean "this form of the command does not work here". */
export const FORM_ERRORS = new Set(['module_missing', 'command_missing', 'script_missing', 'usage_error', 'permission_denied'])

/**
 * What "the probe returned something" looks like, per VCS probe kind.
 * Deliberately narrow so an unrelated segment of a compound command cannot
 * masquerade as a hit. Upstream: `_PROBE_HIT`, observe.py:151-161.
 *
 * @type {Record<string, RegExp>}
 */
export const PROBE_HIT = {
  remote: /^\S+\s+\S+\s+\((?:fetch|push)\)\s*$/m,
  branch: /^\s*remotes\/\S+/m,
  tag: /^v?\d+(?:\.\d+)+(?:[a-z]+\d*|\.post\d+|-\S+)?\s*$/m,
  fsck: /^(?:unreachable|dangling)\s+(?:commit|tree|blob|tag)\s+[0-9a-f]{7,}/m,
  stash: /^stash@\{\d+\}/m,
  refs: /^[0-9a-f]{7,}\s+refs\//m,
}

// ---- observations ------------------------------------------------------------------------
/**
 * One normalized host tool call, as produced by the DSH adapter
 * (`lib/dsh/normalize.js`). The observer only needs the tool name, the parsed
 * arguments and the model-facing result text.
 *
 * @typedef {object} NormalizedCall
 * @property {string} [tool] Raw tool name as the host reported it.
 * @property {Record<string, unknown>} [args] Parsed tool arguments.
 * @property {string} [resultText] Model-facing result text.
 * @property {boolean} [failed] Host-reported failure (`isError`).
 * @property {boolean} [ok] Explicit success when the caller has it (wins over `failed`).
 * @property {number|null} [exitCode] Recovered shell exit code when the host reports one.
 * @property {string} [cwd] Absolute working directory the call started in, when known.
 */

/**
 * @typedef {object} ClassifyOptions
 * @property {number} [callIndex]
 * @property {Vocabulary} [vocab]
 * @property {string} [cwd] Command start directory, relative to the session start ('' = start).
 * @property {string|null} [root] Absolute session-start directory when known.
 * @property {string|null} [top] Repository top that `root` lies in, when known.
 */

/**
 * Strip an agent's `/bin/bash -lc "<cmd>"` wrapper, if present.
 * Upstream: `unwrap`, observe.py:167-179.
 *
 * @param {string} cmd
 * @returns {string}
 */
export function unwrap(cmd) {
  const text = String(cmd ?? '')
  const match = WRAP_RE.exec(text.trim())
  if (!match) return text
  let inner = match[1].trim()
  if (inner.length >= 2 && inner[0] === inner[inner.length - 1] && (inner[0] === '"' || inner[0] === "'")) {
    const quote = inner[0]
    inner = inner.slice(1, -1)
    if (quote === '"') inner = inner.replace(/\\"/g, '"').replace(/\\\$/g, '$').replace(/\\\\/g, '\\')
  }
  return inner
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripParens(text) {
  let start = 0
  let end = text.length
  while (start < end && (text[start] === '(' || text[start] === ')')) start += 1
  while (end > start && (text[end - 1] === '(' || text[end - 1] === ')')) end -= 1
  return text.slice(start, end).trim()
}

/**
 * Split a shell command into simple segments on `&&`, `||`, `;`, `|` and
 * newlines, outside quotes. Heredoc bodies are elided first so their contents
 * are never mistaken for commands. Deliberately a hand-written splitter, not a
 * shell parser: nothing is expanded, globbed or evaluated (UPSTREAM §8.3).
 *
 * Upstream: `segments`, observe.py:182-205.
 *
 * @param {string} cmd
 * @returns {string[]}
 */
export function segments(cmd) {
  const input = String(cmd ?? '').replace(HEREDOC_RE, (match) => `${match.split('\n')[0]} <heredoc>`)
  /** @type {string[]} */
  const parts = []
  let buffer = ''
  /** @type {string|null} */
  let quote = null
  let index = 0
  while (index < input.length) {
    const char = input[index]
    if (quote !== null) {
      buffer += char
      if (char === quote) quote = null
      else if (char === '\\' && index + 1 < input.length) {
        buffer += input[index + 1]
        index += 1
      }
    } else if (char === '"' || char === "'") {
      quote = char
      buffer += char
    } else if (char === '\n' || char === ';' || char === '|' || (char === '&' && input.slice(index, index + 2) === '&&')) {
      parts.push(buffer)
      buffer = ''
      const pair = input.slice(index, index + 2)
      if (pair === '&&' || pair === '||') index += 1
    } else {
      buffer += char
    }
    index += 1
  }
  parts.push(buffer)
  /** @type {string[]} */
  const out = []
  for (const part of parts) {
    const stripped = stripParens(part.trim())
    if (stripped !== '') out.push(stripped)
  }
  return out
}

/**
 * One classified command segment.
 *
 * Upstream: `Observation`, observe.py:212-225. Fields are camelCase here; the
 * serialized form keeps upstream's snake_case (`toJSON`).
 */
export class Observation {
  /**
   * @param {number} call Index of the originating tool call.
   * @param {string} intent
   * @param {string} form How the command was spelled, as a poolable identity.
   * @param {string} head Executable token as typed.
   * @param {string} prefix Carried `cd`/activation/wrapper prefix.
   * @param {string} segment The source segment.
   * @param {Iterable<string>} [hosts] Hosts a fetch mentions.
   * @param {string|null} [probe] VCS probe kind.
   */
  constructor(call, intent, form, head, prefix, segment, hosts = [], probe = null) {
    /** @type {number} */
    this.call = call
    /** @type {string} */
    this.intent = intent
    /** @type {string} */
    this.form = form
    /** @type {string} */
    this.head = head
    /** @type {string} */
    this.prefix = prefix
    /** @type {string} */
    this.segment = segment
    /** @type {string[]} */
    this.hosts = [...hosts]
    /** @type {string|null} */
    this.probe = probe
    /** @type {string|null} Outcome class, `'ran'`, `'hit'`, `'empty'`, or null (unknown). */
    this.outcome = null
    /** @type {string[]} */
    this.labels = []
    /** @type {boolean} */
    this.labelErr = false
    /** @type {boolean} */
    this.loaded = false
    /** @type {boolean} */
    this.testsRan = false
    /** @type {boolean} Typed with `VAR=value` before it, which its form leaves out. */
    this.env = false
  }

  /** @returns {string} */
  toString() {
    return `Obs(${this.intent},${JSON.stringify(this.form)},${String(this.outcome)})`
  }

  /** @returns {Record<string, unknown>} */
  toJSON() {
    return {
      call: this.call,
      intent: this.intent,
      form: this.form,
      head: this.head,
      prefix: this.prefix,
      segment: this.segment,
      hosts: [...this.hosts],
      probe: this.probe,
      outcome: this.outcome,
      labels: [...this.labels],
      label_err: this.labelErr,
      loaded: this.loaded,
      tests_ran: this.testsRan,
      env: this.env,
    }
  }
}

/**
 * The repository a directory belongs to: the nearest directory at or above
 * `start` that holds a `.git` (a directory, or a worktree's file); null when
 * there is none on disk, or `start` itself is gone (a removed checkout must not
 * borrow an enclosing repository).
 *
 * Upstream: `repository_top`, observe.py:228-241.
 *
 * @param {string} start
 * @returns {string|null} Absolute repository root.
 */
export function repositoryTop(start) {
  if (!start || !path.isAbsolute(start)) return null
  try {
    if (!fs.statSync(start).isDirectory()) return null
  } catch {
    return null
  }
  let dir = path.normalize(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/**
 * `p` with forward slashes and a Windows drive spelled `c:`; a POSIX path is
 * returned as it is. Upstream: `_shell_path`, observe.py:278-285.
 *
 * @param {string} p
 * @returns {string}
 */
function shellPath(p) {
  const text = String(p ?? '')
  if (path.sep !== '\\') return text
  const forward = text.replace(/\\/g, '/')
  const match = DRIVE_RE.exec(forward)
  if (!match) return forward
  const drive = (match[1] ?? match[2] ?? '').toLowerCase()
  return `${drive}:${forward.slice(match[0].length)}`
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function shellIsAbs(p) {
  return p.startsWith('/') || (path.sep === '\\' && /^[a-z]:(?:\/|$)/.test(p))
}

/**
 * Where `cd target` from `cur` lands, relative to the directory the session
 * started in (`''` for that directory itself); null when it leaves it or cannot
 * be told (`~`, `$VAR`, `-`, an absolute path with no known start).
 *
 * A session started in a subdirectory of its repository (`top`) that changes up
 * to the repository's top runs what a session started there runs:
 * `cd <top> && pytest` is the plain `pytest`, not a form of its own spelled
 * with one machine's path. Any other directory above the start is taken as
 * typed.
 *
 * Upstream: `_cd_target`, observe.py:244-272.
 *
 * @param {string|null} cur Current directory relative to the session start.
 * @param {string} target The `cd` argument as typed.
 * @param {string|null} [root] Absolute session-start directory.
 * @param {string|null} [top] Absolute repository top of `root`.
 * @returns {string|null}
 */
export function cdTarget(cur, target, root = null, top = null) {
  if (!target || '~$-'.includes(target[0])) return null
  const targetPath = shellPath(target)
  const currentPath = shellPath(cur || '.')
  /** @type {string} */
  let rel
  if (shellIsAbs(targetPath)) {
    if (!root) return null
    rel = path.posix.relative(path.posix.normalize(shellPath(root)), path.posix.normalize(targetPath))
  } else {
    rel = path.posix.normalize(path.posix.join(currentPath, targetPath))
  }
  if (rel === '.') return ''
  if (rel === '..' || rel.startsWith('../')) {
    if (!top || !root) return null
    const at = path.posix.normalize(path.posix.join(shellPath(root), rel))
    return at === path.posix.normalize(shellPath(top)) ? '' : null
  }
  return rel
}

/**
 * Observations for one shell command (possibly compound). Activation prefixes
 * carry across the segments of one command, which is how
 * `source activate X && python ...` becomes a single form.
 *
 * `cwd` is the directory the command started in, relative to the one the
 * session started in (`root`, an absolute path when known): a shell that keeps
 * its directory between calls runs a bare `python runtests.py` in `tests/` after
 * an earlier `cd tests`, and that is the same form as `cd tests && python
 * runtests.py` typed at the start. `top` is the repository `root` lies in
 * (`repositoryTop`), for a `cd` up to it from a subdirectory.
 *
 * Upstream: `classify_command`, observe.py:292-367.
 *
 * @param {string} cmd
 * @param {ClassifyOptions} [options]
 * @returns {Observation[]}
 */
export function classifyCommand(cmd, options = {}) {
  const vocab = options.vocab ?? DEFAULT_VOCAB
  const callIndex = options.callIndex ?? 0
  const root = options.root ?? null
  const top = options.top ?? null
  /** @type {Observation[]} */
  const observations = []
  let carried = ''
  /** @type {string|null} */
  let here = options.cwd ?? ''
  let cd = here ? `cd ${here} &&` : ''
  for (const source of segments(unwrap(cmd))) {
    // Transparent wrappers first: `K=V rtk pytest`, `rtk K=V pytest` and
    // `rtk proxy pytest` are all a pytest run.
    const typed = source.trim()
    let seg = typed.replace(ENV_ASSIGN_RE, '').trim()
    let assigned = seg !== typed
    const unwrapped = stripRtkPrefix(seg).trim()
    seg = unwrapped.replace(ENV_ASSIGN_RE, '').trim()
    assigned = assigned || seg !== unwrapped
    if (!seg) continue

    // A directory change is part of how the rest of the command runs, so it is
    // carried into the forms that follow, as an activation is.
    const cdMatch = CD_RE.exec(seg)
    if (cdMatch) {
      /** @type {string|null} */
      const there = here !== null ? cdTarget(here, cdMatch[2], root, top) : null
      if (there === null) {
        here = null
        cd = `cd ${cdMatch[2]} &&`
      } else {
        here = there
        cd = there ? `cd ${there} &&` : ''
      }
      continue
    }
    const activateMatch = ACTIVATE_RE.exec(seg) ?? CONDA_ACTIVATE_RE.exec(seg)
    if (activateMatch) {
      const manager = seg.startsWith('conda') || seg.startsWith('mamba') ? 'conda' : 'source'
      carried = `${manager} activate ${activateMatch[1]} &&`
      continue
    }

    let prefix = [cd, carried].filter(Boolean).join(' ')
    let body = seg
    const condaMatch = CONDA_RUN_RE.exec(body)
    if (condaMatch) {
      prefix = prefix === '' ? `conda run -n ${condaMatch[1]}` : `${prefix} conda run -n ${condaMatch[1]}`
      body = body.slice(condaMatch[0].length)
    }
    const toolMatch = TOOL_RUN_RE.exec(body)
    if (toolMatch) {
      prefix = prefix === '' ? `${toolMatch[1]} run` : `${prefix} ${toolMatch[1]} run`
      body = body.slice(toolMatch[0].length)
    } else {
      const npxMatch = NPX_RE.exec(body)
      if (npxMatch && npxMatch[0].length > 0) {
        prefix = prefix === '' ? 'npx' : `${prefix} npx`
        body = body.slice(npxMatch[0].length)
      }
    }

    /** @type {string[]} */
    let tokens = body.split(/\s+/).filter(Boolean)
    while (tokens.length > 0 && (PREFIX_HEADS.has(tokens[0]) || ASSIGN_TOKEN_RE.test(tokens[0]))) {
      if (ASSIGN_TOKEN_RE.test(tokens[0])) {
        assigned = true
        tokens = tokens.slice(1)
      } else {
        tokens = tokens[0] === 'timeout' ? tokens.slice(2) : tokens.slice(1)
      }
    }
    if (tokens.length === 0) continue
    const head = tokens[0]
    const baseParts = head.split('/')
    const base = baseParts[baseParts.length - 1] ?? head
    const observation = classifySegment(head, base, tokens.slice(1), body, prefix, seg, callIndex, vocab)
    if (observation !== null) {
      observation.env = assigned
      observations.push(observation)
    }
  }
  return observations
}

/**
 * The runner script a command names, if the first positional token is one.
 * Faithful to upstream's control flow (`_runner_script`, observe.py:370-378):
 * only the first non-option token is considered.
 *
 * @param {string[]} rest
 * @param {Vocabulary} vocab
 * @returns {string|null}
 */
function runnerScript(rest, vocab) {
  for (const token of rest) {
    if (token.startsWith('-')) continue
    for (const script of vocab.runnerScripts) {
      if (token === script || token.endsWith(`/${script}`) || token.endsWith(script)) {
        return token.startsWith('./') ? token.replace(/^[./]+/, '') : token
      }
    }
    return null
  }
  return null
}

/**
 * @param {string} head
 * @param {string} base
 * @param {string[]} rest
 * @param {string} body
 * @param {string} prefix
 * @param {string} seg
 * @param {number} call
 * @param {Vocabulary} vocab
 * @returns {Observation|null}
 */
function classifySegment(head, base, rest, body, prefix, seg, call, vocab) {
  /**
   * @param {string} expr
   * @returns {string}
   */
  const form = (expr) => (prefix === '' ? expr : `${prefix} ${expr}`)
  const versionOnly = rest.length > 0 && rest.every((token) => ['--version', '-V', '-VV', '-v'].includes(token))

  if (vocab.interpreters.has(base) || INTERP_VERSIONED_RE.test(base)) {
    if (versionOnly) return new Observation(call, 'probe_env', form(head), head, prefix, seg)
    if (rest.includes('-m')) {
      const index = rest.indexOf('-m')
      const moduleName = index + 1 < rest.length ? rest[index + 1] : ''
      if (vocab.runnerModules.has(moduleName)) {
        return new Observation(call, 'run_tests', form(`${head} -m ${moduleName}`), head, prefix, seg)
      }
    }
    const script = runnerScript(rest, vocab)
    if (script !== null && (script !== 'manage.py' || rest.includes('test'))) {
      return new Observation(call, 'run_tests', form(`${head} ${script}`), head, prefix, seg)
    }
    return new Observation(call, 'run_interpreter', form(head), head, prefix, seg)
  }
  if (vocab.runnerHeads.has(base)) {
    return new Observation(call, 'run_tests', form(head), head, prefix, seg)
  }
  for (const script of vocab.runnerScripts) {
    if (head === script || head.endsWith(`/${script}`) || head === `./${script}`) {
      if (script === 'manage.py' && !rest.includes('test')) break
      // A script run through its shebang is the interpreter running it; spell
      // the form that way so `./tests/runtests.py` and `python tests/runtests.py` pool.
      const stripped = head.replace(/^[./]+/, '')
      return new Observation(call, 'run_tests', form(`${vocab.canonicalInterpreter} ${stripped}`), head, prefix, seg)
    }
  }
  if (vocab.taskHeads.has(base) && rest[0] === 'test') {
    return new Observation(call, 'run_tests', form(`${base} test`), head, prefix, seg)
  }
  if (vocab.generic) {
    if (RUN_SCRIPT_HEADS.has(base) && rest.length > 1 && rest[0] === 'run') {
      const script = rest[1]
      const kind = script.split(':')[0]
      if (kind === 'test') return new Observation(call, 'run_tests', form(`${base} run ${script}`), head, prefix, seg)
      if (BUILD_SUBS.has(kind)) return new Observation(call, 'run_build', form(`${base} run ${script}`), head, prefix, seg)
    }
    if (vocab.taskHeads.has(base) && BUILD_SUBS.has(rest[0])) {
      return new Observation(call, 'run_build', form(`${base} ${rest[0]}`), head, prefix, seg)
    }
    if (vocab.buildHeads.has(base)) {
      return new Observation(call, 'run_build', form(base), head, prefix, seg)
    }
  }
  if (vocab.envProbeHeads.has(base)) {
    return new Observation(call, 'probe_env', form(base), head, prefix, seg)
  }
  if (vocab.fetchHeads.has(base)) {
    return new Observation(call, 'fetch_remote', form(base), head, prefix, seg, urlHosts(body))
  }
  if (base === 'git' && rest.length > 0) {
    const sub = rest[0]
    if (GIT_FETCH_SUBS.has(sub)) {
      return new Observation(call, 'fetch_remote', form(`git ${sub}`), head, prefix, seg, urlHosts(body))
    }
    if (GIT_PROBE_SUBS.has(sub)) {
      const kind = probeKind(sub, rest.slice(1))
      if (kind !== null) {
        return new Observation(call, 'probe_vcs_refs', form(`git ${sub}`), head, prefix, seg, [], kind)
      }
    }
    return null
  }
  if (vocab.packageTools.has(base)) {
    if (/^(?:pip|npm|yarn|pnpm)/.test(base) && ['install', 'download', 'add', 'ci'].includes(rest[0])) {
      return new Observation(call, 'fetch_remote', form(`${base} ${rest[0]}`), head, prefix, seg, urlHosts(body))
    }
    return new Observation(call, 'package_tool', form(base), head, prefix, seg)
  }
  return null
}

/**
 * The VCS probe kind a `git <sub>` invocation can answer, or null.
 * Upstream: `_probe_kind`, observe.py:449-463.
 *
 * @param {string} sub
 * @param {string[]} args
 * @returns {string|null}
 */
function probeKind(sub, args) {
  const flags = new Set(args)
  if (sub === 'remote') return 'remote'
  if (sub === 'branch' && ['-a', '-r', '--all', '--remotes', '-ar', '-ra'].some((flag) => flags.has(flag))) return 'branch'
  if (sub === 'tag' && flags.has('--contains')) return 'tag' // plain `git tag` lists PAST tags too
  if (sub === 'fsck') return 'fsck'
  if (sub === 'stash' && args[0] === 'list') return 'stash'
  if (sub === 'show-ref' || sub === 'for-each-ref') return 'refs'
  return null
}

/**
 * @param {string} body
 * @returns {string[]}
 */
function urlHosts(body) {
  /** @type {string[]} */
  const hosts = []
  for (const match of String(body ?? '').matchAll(URL_HOST_RE)) hosts.push(match[1])
  return hosts
}

/**
 * The environmental error class an output names, or null.
 *
 * @param {string} output
 * @returns {string|null}
 */
export function errorClass(output) {
  const text = String(output ?? '')
  for (const [name, regex] of ERROR_CLASSES) {
    if (regex.test(text)) return name
  }
  return null
}

/**
 * `exit code: N` / `exit code=N` recovered from result text, or null.
 * Upstream: `_exit_code_hint`, observe.py:473-475.
 *
 * @param {string} output
 * @returns {number|null}
 */
export function exitCodeHint(output) {
  const match = /\bexit code[:=\s]+(\d+)/i.exec(String(output ?? ''))
  return match === null ? null : Number.parseInt(match[1], 10)
}

// The runner could not load a test label: the module, file or name it names does
// not resolve. Read off the output rather than the exit code -- agents pipe test
// runs through `| tail`. Upstream: observe.py:480-482.
const LABEL_ERR_RE = /Failed to import test module|unittest\.loader\._FailedTest|ERROR: (?:file or directory )?not found|no tests ran|module '[\w.]+' has no attribute/i
const NO_MODULE_RE = /No module named ['"]?([\w.]+)/g
// ... and positive evidence that it loaded: tests actually ran. Output an agent
// filtered away (`| grep FAILED`, a silent run) proves nothing either way.
const LOADED_RE = /\bRan [1-9]\d* tests?\b|\b[1-9]\d* (?:passed|failed|passing|failing)\b|\bcollected [1-9]\d* items?\b/
// Other runners' summaries, for the generic reading: Go's `ok  pkg 0.01s` and
// `--- PASS`, Rust's `test result:`, RSpec's `3 examples, 0 failures`, .NET's
// `Passed!`, Maven's `Tests run: 3`.
const LOADED_GENERIC_RE = /^ok\s+\S+\s+[\d.]+s\b|^--- (?:PASS|FAIL)\b|\btest result: (?:ok|FAILED)\b|\b[1-9]\d* examples?, \d+ failures?\b|\b(?:Passed|Failed)!\s+-|\bTests run: [1-9]\d*/m
// Code asking for an environment variable by name, and the ways a command sets one.
const ENV_NEED_RE = /environment variable\s+['"`]?([A-Z][A-Z0-9_]{2,})/g
const ENV_PREFIX_RE = /(?:^|[\s;&(])(?:export\s+)?([A-Z][A-Z0-9_]{2,})=(['"]?)([\w.\-/:]+)\2/g
const ENV_INCODE_RE = /os\.environ(?:\.setdefault\(\s*|\[\s*)['"]([A-Z][A-Z0-9_]{2,})['"]\s*(?:,|\]\s*=)\s*['"]([\w.\-/:]+)['"]/g
const FAILED_RE = /Traceback \(most recent call last\)|^\w*Error\b|\b[Ee]xit [Cc]ode[:=\s]+[1-9]/m

const LABEL_TOKEN_RE = /^[A-Za-z_][\w.\-/]*(?:::[\w.\-\[\]]+)*$/

/**
 * Did the runner fail to load one of these labels? Either it says so, or the
 * module it cannot import is the label's own (`tests` for `tests.app`) -- a
 * missing `pytest` is not.
 *
 * Upstream: `_label_failed`, observe.py:486-492.
 *
 * @param {string[]} labels
 * @param {string} output
 * @returns {boolean}
 */
export function labelFailed(labels, output) {
  const out = String(output ?? '')
  if (LABEL_ERR_RE.test(out)) return true
  /** @type {Set<string>} */
  const heads = new Set(labels.map((label) => label.split(/[./:]/)[0]))
  for (const match of out.matchAll(NO_MODULE_RE)) {
    if (heads.has(match[1].split('.')[0])) return true
  }
  return false
}

/**
 * The test labels a runner observation was given: positional arguments after the
 * runner's own token that look like a module, a path or a test id. A plain name
 * right after an option is taken to be that option's value (`-k name`), so it is
 * not a label.
 *
 * Upstream: `_test_labels`, observe.py:517-540.
 *
 * @param {Observation} observation
 * @returns {string[]}
 */
export function testLabels(observation) {
  /** @type {string[]} */
  const tokens = observation.segment.split(/\s+/).filter(Boolean)
  const formTokens = observation.form.split(/\s+/).filter(Boolean)
  const last = formTokens.length > 0 ? formTokens[formTokens.length - 1] : ''
  let start = tokens.length
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === last || token.replace(/^[./]+/, '') === last || token.endsWith(`/${last}`)) {
      start = index + 1
      break
    }
  }
  /** @type {string[]} */
  const out = []
  let skip = false
  let previous = ''
  for (const token of tokens.slice(start)) {
    if (skip) {
      skip = false
      previous = token
      continue
    }
    if (['>', '>>', '2>', '<', '|'].includes(token) || ['2>', '>', '<', '|'].some((prefixText) => token.startsWith(prefixText))) {
      skip = ['>', '>>', '2>', '<'].includes(token)
      previous = token
      continue
    }
    const structured = token.includes('.') || token.includes('::') || token.includes('/')
    const afterOption = previous.startsWith('-') && !previous.includes('=')
    if (!token.startsWith('-') && LABEL_TOKEN_RE.test(token) && (structured || !afterOption)) {
      out.push(token)
    }
    previous = token
  }
  return out
}

/**
 * `['sep', '::']` or `['strip', prefix]` when label `b` is label `a` rewritten
 * into the shape the runner loads, else null.
 *
 * Upstream: `label_rule`, observe.py:543-558.
 *
 * @param {string} a The label the runner rejected.
 * @param {string} b The label the runner loaded.
 * @returns {[string, string]|null}
 */
export function labelRule(a, b) {
  if (a.includes('::') && !b.includes('::')) {
    const dotted = a.split('::').join('.')
    if (b === dotted || dotted.startsWith(`${b}.`) || b.startsWith(`${dotted}.`)) return ['sep', '::']
  }
  for (const separator of ['.', '/']) {
    if (!a.includes(separator)) continue
    const cut = a.indexOf(separator)
    const prefix = a.slice(0, cut + separator.length)
    const rest = a.slice(prefix.length)
    if (rest && !b.startsWith(prefix) && (b === rest || rest.startsWith(`${b}${separator}`) || b.startsWith(`${rest}${separator}`))) {
      return ['strip', prefix]
    }
  }
  return null
}

/**
 * What one call says about environment variables: those its output asks for,
 * and those its command sets (inline, exported or in the code it runs).
 *
 * Upstream: `_env_calls`, observe.py:561-567.
 *
 * @param {string} cmd
 * @param {string} output
 * @param {boolean} success
 * @returns {{need: string[], sets: Record<string, string>, ok: boolean}}
 */
export function envCalls(cmd, output, success) {
  const command = String(cmd ?? '')
  const out = String(output ?? '')
  /** @type {Record<string, string>} */
  const sets = {}
  for (const match of command.matchAll(ENV_PREFIX_RE)) sets[match[1]] = match[3]
  for (const match of command.matchAll(ENV_INCODE_RE)) sets[match[1]] = match[2]
  /** @type {string[]} */
  const need = [...new Set([...out.matchAll(ENV_NEED_RE)].map((match) => match[1]))].sort()
  return { need, sets, ok: Boolean(success) && !FAILED_RE.test(out) }
}

/**
 * Did this run show that the way the command was CALLED fails here? Not when the
 * runner started and rejected what it was given: a label it could not load or an
 * option it does not take is a mistake in the arguments.
 *
 * Upstream: `form_failed`, observe.py:570-577.
 *
 * @param {Observation} observation
 * @returns {boolean}
 */
export function formFailed(observation) {
  if (observation.outcome === null || !FORM_ERRORS.has(observation.outcome) || observation.labelErr) return false
  return !(observation.intent === 'run_tests' && observation.outcome === 'usage_error')
}

/**
 * Did this run show the form works? A test run must show tests running: one
 * whose output was filtered away proves nothing.
 *
 * Upstream: `form_worked`, observe.py:580-584.
 *
 * @param {Observation} observation
 * @returns {boolean}
 */
export function formWorked(observation) {
  return observation.outcome === 'ran' && (observation.intent !== 'run_tests' || observation.testsRan)
}

/**
 * A form with no activation prefix and no explicit path is 'bare'.
 * Upstream: `is_bare`, observe.py:705-709.
 *
 * @param {string} form
 * @returns {boolean}
 */
export function isBare(form) {
  const text = String(form ?? '')
  const head = text.split(/\s+/)[0] ?? ''
  return (
    !head.includes('/') &&
    !text.includes(' activate ') &&
    !text.includes(' run ') &&
    !['conda run', 'poetry run', 'pipenv run', 'uv run', 'npx '].some((prefix) => text.startsWith(prefix))
  )
}

/**
 * The line of `output` that carries the matched environmental error.
 *
 * Upstream: `_error_line`, observe.py:695-702.
 *
 * @param {string} output
 * @param {string|null} name Class name from `errorClass`.
 * @returns {string}
 */
function errorLine(output, name) {
  if (name === null) return ''
  const regex = ERROR_CLASS_RX.get(name)
  if (!regex) return ''
  const text = String(output ?? '')
  const match = regex.exec(text)
  if (match === null) return ''
  const start = text.lastIndexOf('\n', match.index) + 1
  const end = text.indexOf('\n', match.index + match[0].length)
  return text.slice(start, end >= 0 ? end : undefined)
}

/**
 * The file an edit/write/create call wrote: upstream reads `file_path` then
 * `path`; DSH's ops tools use `path`, Claude-style tools `file_path`, and some
 * adapters `filePath`, so all three spellings are accepted.
 *
 * @param {Record<string, unknown>} args
 * @returns {string|null}
 */
function editTarget(args) {
  for (const key of ['file_path', 'path', 'filePath']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/**
 * Every file an edit tool wrote, by basename, whatever its language (the
 * plugin's reading). Upstream: `edited_files`, lifecycle.py:38-50, moved here so
 * the state machine module stays free of session I/O.
 *
 * @param {Array<[string, Record<string, unknown>, string]>} calls `[tool, args, resultText]` triples.
 * @returns {Set<string>} Edited-file basenames.
 */
export function editedFiles(calls) {
  /** @type {Set<string>} */
  const files = new Set()
  for (const [tool, args] of calls) {
    const name = String(tool ?? '').toLowerCase()
    if (isApplyPatchTool(name)) {
      const paths = Array.isArray(args.paths) ? args.paths : (typeof args.path === 'string' ? [args.path] : [])
      for (const file of paths) {
        if (typeof file === 'string' && file !== '') files.add(path.basename(file))
      }
    } else if (isEditTool(name)) {
      const file = editTarget(args)
      if (file !== null) files.add(path.basename(file))
    }
  }
  return files
}

/**
 * Python files only (the experiments' reading). Upstream: `edited_pyfiles`,
 * lifecycle.py:24-35.
 *
 * @param {Array<[string, Record<string, unknown>, string]>} calls
 * @returns {Set<string>} Edited `.py` basenames.
 */
export function editedPyfiles(calls) {
  /** @type {Set<string>} */
  const files = new Set()
  for (const [tool, args] of calls) {
    const name = String(tool ?? '').toLowerCase()
    if (isApplyPatchTool(name)) {
      const paths = Array.isArray(args.paths) ? args.paths : (typeof args.path === 'string' ? [args.path] : [])
      for (const file of paths) {
        if (typeof file === 'string' && path.basename(file).endsWith('.py')) files.add(path.basename(file))
      }
    } else if (isEditTool(name)) {
      const file = editTarget(args)
      if (file !== null && path.basename(file).endsWith('.py')) files.add(path.basename(file))
    }
  }
  return files
}

/**
 * The success of one call: an explicit `ok` wins, then the host's `failed`
 * flag, then a recovered exit code; absent evidence is treated as success (the
 * host reports failure through `isError` in DSH).
 *
 * @param {NormalizedCall} call
 * @returns {boolean}
 */
function callSucceeded(call) {
  if (typeof call.ok === 'boolean') return call.ok
  if (typeof call.failed === 'boolean') return !call.failed
  if (typeof call.exitCode === 'number') return call.exitCode === 0
  return true
}

/**
 * Per-task digest: observations with outcomes, the edited files, the call count
 * and the environment-variable evidence.
 *
 * Outcome attribution inside a compound command is heuristic and conservative:
 * an infrastructure error is attributed to the segment whose executable the
 * error names, else to the last relevant segment; a call that succeeded marks
 * every relevant segment as having run; a failed call with no infrastructure
 * error marks only the first relevant segment as having run and leaves the
 * others unknown (an `&&` chain may not have reached them).
 *
 * Upstream: `observe_task`, observe.py:587-692, reading a host transcript; this
 * port takes the DSH adapter's normalized calls.
 *
 * @param {NormalizedCall[]} calls
 * @param {{cwd?: string, repoRoot?: string|null, vocab?: Vocabulary}} [options]
 *   `cwd` is the absolute directory the session started in; `repoRoot` the
 *   absolute repository top (computed from `cwd` on disk when omitted).
 * @returns {{obs: Observation[], edited: string[], nCalls: number, env: Array<{need: string[], sets: Record<string, string>, ok: boolean, call: number}>}}
 */
export function observeSession(calls, options = {}) {
  const list = Array.isArray(calls) ? calls : []
  const vocab = options.vocab ?? DEFAULT_VOCAB
  const root = options.cwd ? String(options.cwd) : null
  const top = options.repoRoot !== undefined && options.repoRoot !== null
    ? String(options.repoRoot)
    : (root === null ? null : repositoryTop(root))
  /** @type {Observation[]} */
  const observations = []
  /** @type {Array<[string, Record<string, unknown>, string]>} */
  const triples = []
  /** @type {Array<{need: string[], sets: Record<string, string>, ok: boolean, call: number}>} */
  const envEvidence = []
  for (let index = 0; index < list.length; index += 1) {
    const call = /** @type {NormalizedCall} */ (list[index] ?? {})
    const tool = String(call.tool ?? '').toLowerCase()
    const args = call.args !== null && typeof call.args === 'object' ? /** @type {Record<string, unknown>} */ (call.args) : {}
    const output = typeof call.resultText === 'string' ? call.resultText : String(call.resultText ?? '')
    triples.push([tool, args, output])
    if (!isShellTool(tool)) continue
    const command = typeof args.command === 'string' ? args.command : (typeof args.cmd === 'string' ? args.cmd : '')
    if (CD_FAILED_RE.test(output)) continue // stopped at its `cd`: nothing after it ran
    /** @type {string|null} */
    let here = '' // relative to the session start; null = started outside it
    if (root !== null && typeof call.cwd === 'string' && call.cwd !== '') {
      here = cdTarget('', call.cwd, root, top)
    }
    /** @type {Observation[]} */
    let obs
    if (here === null) {
      // Started outside the session's directory: its own `cd`s are taken as typed.
      obs = classifyCommand(command, { callIndex: index, vocab })
    } else {
      obs = classifyCommand(command, { callIndex: index, vocab, cwd: here, root, top })
    }
    const hint = exitCodeHint(output)
    const success = hint === null ? callSucceeded(call) : hint === 0
    if (vocab.generic || command.includes('python') || command.includes('=')) {
      const evidence = envCalls(command, output, success)
      if (evidence.need.length > 0 || Object.keys(evidence.sets).length > 0) {
        envEvidence.push({ ...evidence, call: index })
      }
    }
    if (obs.length === 0) continue
    for (const observation of obs) {
      if (observation.intent === 'run_tests') {
        observation.labels = testLabels(observation)
        observation.labelErr = observation.labels.length > 0 && labelFailed(observation.labels, output)
        observation.loaded = observation.labels.length > 0 && !observation.labelErr && LOADED_RE.test(output)
        observation.testsRan = LOADED_RE.test(output) || (vocab.generic && LOADED_GENERIC_RE.test(output))
      }
    }
    // Pass-through segments (a leading `cd`, a trailing `| head`, an `echo ---`
    // separator) neither add evidence nor pollute the output, so they do not
    // break a call's homogeneity; filters that rewrite content (grep, sed, awk,
    // wc) do.
    const segmentCount = segments(unwrap(command)).filter((segment) => {
      const first = segment.split(/\s+/).filter(Boolean)[0] ?? ''
      const parts = first.split('/')
      return !PASSTHROUGH.has(parts[parts.length - 1] ?? first)
    }).length
    const homogeneous = segmentCount === obs.length && new Set(obs.map((observation) => observation.intent)).size === 1
    const errorName = errorClass(output)
    /** @type {Observation[]} */
    const targets = obs.filter((observation) => ACTING_INTENTS.has(observation.intent))
    if (errorName !== null && (FORM_ERRORS.has(errorName) || NETWORK_ERRORS.has(errorName))) {
      const line = errorLine(output, errorName)
      let named = targets.filter((observation) => {
        const headParts = observation.head.split('/')
        const tail = headParts[headParts.length - 1] ?? observation.head
        return observation.head !== '' && (output.includes(observation.head) || line.includes(tail))
      })
      if (NETWORK_ERRORS.has(errorName)) {
        named = targets.filter((observation) => observation.intent === 'fetch_remote' && (observation.hosts.length === 0 || observation.hosts.some((host) => output.includes(host))))
        if (named.length === 0) named = targets.filter((observation) => observation.intent === 'fetch_remote')
      }
      const chosen = named.length > 0 ? named : (success ? [] : targets.slice(-1))
      for (const observation of chosen) observation.outcome = errorName
      if (success) {
        for (const observation of obs) {
          if (observation.outcome === null) observation.outcome = 'ran'
        }
      }
    } else if (success) {
      for (const observation of obs) observation.outcome = 'ran'
    } else {
      let first = true
      for (const observation of obs) {
        if (ACTING_INTENTS.has(observation.intent)) {
          observation.outcome = first ? 'ran' : null
          first = false
        } else {
          observation.outcome = observation.intent !== 'probe_vcs_refs' ? 'ran' : null
        }
      }
    }
    for (const observation of obs) {
      if (observation.intent === 'probe_vcs_refs') {
        // Judged only when every segment of the call is a probe: another
        // segment's output would otherwise be read as the probe's.
        if (!homogeneous) observation.outcome = null
        else {
          const probeRegex = observation.probe === null ? undefined : PROBE_HIT[observation.probe]
          observation.outcome = probeRegex !== undefined && probeRegex.test(output) ? 'hit' : (success ? 'empty' : null)
        }
      }
      if (observation.intent === 'fetch_remote' && observation.outcome === 'ran') {
        // Reachability needs a homogeneous call that exited 0 with real output
        // and no network error; a compound command's exit code and output belong
        // to its last segment, not to the fetch.
        if (!homogeneous || !success || output.trim() === '' || (errorName !== null && NETWORK_ERRORS.has(errorName))) {
          observation.outcome = null
        }
      }
    }
    observations.push(...obs)
  }
  const edited = vocab.generic ? editedFiles(triples) : editedPyfiles(triples)
  return {
    obs: observations,
    edited: [...edited].sort(),
    nCalls: list.length,
    env: envEvidence,
  }
}
