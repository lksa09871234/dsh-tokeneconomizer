/**
 * Edits made through the shell, which an edit-tool counter does not see.
 *
 * `SpiralState` counts an edit only when an edit TOOL makes it (edit/create).
 * An agent that edits through bash — `sed -i`, `perl -pi`, a redirect or `tee`
 * into a source file, an inline script that writes the file back, `patch`/`git
 * apply`, an `apply_patch` heredoc — otherwise looks like one that edited
 * nothing, and the judge's digest would say no file was edited when four were.
 *
 * `shellEditTargets` reads those writes off the command; `foldShellEdits` counts
 * them after the regular state update, so the tool call still counts once.
 *
 * Faithful port of `tokeneconomizer/loopguard/shell_edits.py` (Apache-2.0
 * upstream, microsoft/TokenEconomizer @ e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9).
 * Nothing here executes a command: this module only parses text. Windows path
 * separators are accepted alongside POSIX ones (upstream is POSIX-only).
 *
 * @module dsh-tokeneconomizer/loopguard/shell-edits
 */

import { basename } from './state.js'

/** Heredoc opener: `<<EOF`, `<<'EOF'`, `<<-EOF`, `<<"EOF"`. */
const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/

/** Shell operators that separate simple commands. */
const OPS = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '\n', '(', ')'])

/** Redirects whose operand is written by the command. */
const OUT = new Set(['>', '>>', '>|', '&>', '&>>'])

/** Operands that are not written: input, heredoc tags, fd duplication. */
const SKIP_OPERAND = new Set(['<', '<<', '<<<', '<&', '>&', '<>'])

/**
 * Redirect/`tee` targets count only when they look like source, so `> out.log`
 * or `| tee /tmp/run.txt` (capturing output) is not mistaken for an edit.
 */
const SOURCE_FILE = /\.(?:py|pyi|pyx|pxd|js|jsx|mjs|cjs|ts|tsx|rs|go|java|kt|kts|scala|c|cc|cpp|cxx|h|hh|hpp|rb|php|cs|swift|m|mm|sh|bash|zsh|lua|jl|ex|exs|erl|hs|ml|clj|sql|toml|ya?ml|json|cfg|ini|conf|md|rst|html?|css|scss|vue|svelte|xml|gradle|properties|in)$/i

const PYTHON = /(?:^|[\s/;&|(])python\d?(?:\.\d+)?\b/
const PY_OPEN_LIT = /open\(\s*(['"])([^'"\n]+)\1\s*,\s*(['"])([^'"]*)\3/
const PY_OPEN_VAR = /open\(\s*([A-Za-z_]\w*)\s*,\s*(['"])([^'"]*)\2/
const PY_WRITE_PATH_LIT = /(?:pathlib\.)?Path\(\s*(['"])([^'"\n]+)\1\s*\)\.write_(?:text|bytes)\(/
const PY_WRITE_PATH_VAR = /\b([A-Za-z_]\w*)\.write_(?:text|bytes)\(/

/** Codex's patch format, as `apply_patch <<'PATCH'` takes it on stdin. */
const PATCH_FILE = /^\*\*\* (?:Update|Add|Delete) File:[ \t]*(.+?)[ \t]*$/gm

/** Punctuation characters split into token runs (Python: `punctuation_chars`). */
const PUNCTUATION = new Set(['(', ')', ';', '<', '>', '|', '&'])

/**
 * @param {string} path
 * @returns {boolean}
 */
function notScratch(path) {
  return path !== ''
    && !path.startsWith('/dev/')
    && !path.startsWith('/proc/')
    && !path.startsWith('/tmp/')
}

/**
 * Strip one pair of surrounding quotes, if present (upstream `_unquote`).
 *
 * @param {string} token
 * @returns {string}
 */
function unquote(token) {
  const first = token[0]
  if (token.length >= 2 && first === token[token.length - 1] && (first === "'" || first === '"')) {
    return token.slice(1, -1)
  }
  return token
}

/**
 * Split a command into its shell text (without heredoc bodies) and the bodies.
 *
 * @param {string} cmd
 * @returns {{shell: string, bodies: string[]}}
 */
export function splitHeredocs(cmd) {
  /** @type {string[]} */
  const shell = []
  /** @type {string[]} */
  const bodies = []
  /** @type {string|null} */
  let tag = null
  /** @type {string[]} */
  let body = []
  for (const line of cmd.split('\n')) {
    if (tag !== null) {
      if (line.trim() === tag) {
        bodies.push(body.join('\n'))
        tag = null
        body = []
      } else {
        body.push(line)
      }
      continue
    }
    shell.push(line)
    const match = HEREDOC_START.exec(line)
    if (match) tag = match[2]
  }
  if (tag !== null) bodies.push(body.join('\n'))
  return { shell: shell.join('\n'), bodies }
}

/**
 * Tokenize shell text the way upstream's `shlex.shlex(posix=False,
 * punctuation_chars="();<>|&\n")` does: quotes stay in the token (so a quoted
 * `'>'` or `'|'` is never read as an operator), and runs of unquoted punctuation
 * become single tokens. One deviation: a newline is always its own token (the
 * upstream tokenizer can fuse adjacent newlines into a run, which merges the
 * commands around a blank line); every operator boundary is thereby preserved.
 *
 * @param {string} text
 * @returns {string[]}
 * @throws {Error} on an unbalanced quote, like `shlex`.
 */
export function tokenizeShell(text) {
  /** @type {string[]} */
  const tokens = []
  let current = ''
  let i = 0
  const flush = () => {
    if (current !== '') {
      tokens.push(current)
      current = ''
    }
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush()
      i += 1
      continue
    }
    if (ch === '\n') {
      flush()
      tokens.push('\n')
      i += 1
      continue
    }
    if (ch === "'") {
      let j = i + 1
      while (j < text.length && text[j] !== "'") j += 1
      if (j >= text.length) throw new Error('tokenizeShell: unbalanced single quote')
      current += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        j += text[j] === '\\' && j + 1 < text.length ? 2 : 1
      }
      if (j >= text.length) throw new Error('tokenizeShell: unbalanced double quote')
      current += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (PUNCTUATION.has(ch)) {
      flush()
      let j = i + 1
      while (j < text.length && PUNCTUATION.has(text[j])) j += 1
      tokens.push(text.slice(i, j))
      i = j
      continue
    }
    current += ch
    i += 1
  }
  flush()
  return tokens
}

/**
 * Split tokenized shell text into simple commands (unquoted word lists) and the
 * files its redirects write (upstream `_commands`).
 *
 * @param {string} shell
 * @returns {{cmds: string[][], writes: string[]}}
 */
export function parseCommands(shell) {
  /** @type {string[][]} */
  const cmds = []
  /** @type {string[]} */
  const writes = []
  /** @type {string[][]} */
  let streams
  try {
    streams = [tokenizeShell(shell)]
  } catch {
    // One bad line must not hide the others.
    streams = []
    for (const line of shell.split('\n')) {
      try {
        streams.push([...tokenizeShell(line), '\n'])
      } catch {
        // Skip the unparsable line.
      }
    }
  }
  for (const toks of streams) {
    /** @type {string[]} */
    let cur = []
    let i = 0
    while (i < toks.length) {
      const token = toks[i]
      if (OPS.has(token)) {
        if (cur.length > 0) cmds.push(cur)
        cur = []
      } else if (OUT.has(token) || SKIP_OPERAND.has(token)) {
        if (cur.length > 0 && /^\d+$/.test(cur[cur.length - 1])) cur.pop()
        if (OUT.has(token) && i + 1 < toks.length && !OPS.has(toks[i + 1])) {
          writes.push(unquote(toks[i + 1]))
        }
        i += 1 // consume the operand (redirect target / heredoc tag / fd)
      } else {
        cur.push(unquote(token))
      }
      i += 1
    }
    if (cur.length > 0) cmds.push(cur)
  }
  return { cmds, writes }
}

/**
 * File operands of an in-place editor (`sed -i`, `perl -pi`), or [] if not in
 * place (upstream `_inplace_files`).
 *
 * @param {string[]} tokens
 * @param {(token: string) => boolean} inPlaceFlag
 * @param {(token: string) => boolean} scriptFlag
 * @returns {string[]}
 */
function inplaceFiles(tokens, inPlaceFlag, scriptFlag) {
  if (!tokens.slice(1).some(inPlaceFlag)) return []
  /** @type {string[]} */
  const files = []
  let haveScript = false
  let skip = false
  for (const token of tokens.slice(1)) {
    if (skip) {
      skip = false
      haveScript = true
      continue
    }
    if (token === '' || token.startsWith('-')) {
      if (token !== '' && scriptFlag(token)) skip = true
      continue
    }
    if (!haveScript) {
      haveScript = true
      continue
    }
    files.push(token)
  }
  return files
}

/**
 * Paths an inline Python script writes; `"(script)"` for a write whose path
 * cannot be resolved (upstream `_py_writes`).
 *
 * @param {string} text
 * @returns {string[]}
 */
function pyWrites(text) {
  /** @type {string[]} */
  const out = []
  for (const match of text.matchAll(globalCopy(PY_OPEN_LIT))) {
    if ([...match[4]].some((ch) => 'wax+'.includes(ch))) out.push(match[2])
  }
  /** @type {string[]} */
  const variables = []
  for (const match of text.matchAll(globalCopy(PY_OPEN_VAR))) {
    if ([...match[3]].some((ch) => 'wax+'.includes(ch))) variables.push(match[1])
  }
  for (const match of text.matchAll(globalCopy(PY_WRITE_PATH_LIT))) {
    out.push(match[2])
  }
  for (const match of text.matchAll(globalCopy(PY_WRITE_PATH_VAR))) {
    variables.push(match[1])
  }
  for (const variable of [...new Set(variables)]) {
    const escaped = escapeRegExp(variable)
    /** @type {string[]} */
    const paths = []
    const assignment = new RegExp(
      `\\b${escaped}\\s*=\\s*(?:(?:pathlib\\.)?Path\\(\\s*)?(['"])([^'"\\n]+)\\1`,
      'g',
    )
    for (const match of text.matchAll(assignment)) paths.push(match[2])
    const loop = new RegExp(`\\bfor\\s+${escaped}\\s+in\\s+[\\[(]([^\\])]*)[\\])]`).exec(text)
    if (loop) {
      for (const match of loop[1].matchAll(/['"]([^'"\n]+)['"]/g)) paths.push(match[1])
    }
    if (paths.length > 0) out.push(...paths)
    else out.push('(script)')
  }
  return out
}

/**
 * Basenames of the files a shell command writes, in order, without repeats
 * (upstream `shell_edit_targets`). Never executes anything.
 *
 * @param {unknown} cmd Shell command text.
 * @returns {string[]}
 */
export function shellEditTargets(cmd) {
  if (typeof cmd !== 'string' || cmd.trim() === '') return []
  const { shell, bodies } = splitHeredocs(cmd)
  const { cmds, writes } = parseCommands(shell)
  /** @type {string[]} */
  const found = writes.filter((target) => SOURCE_FILE.test(target))
  for (const rawTokens of cmds) {
    let tokens = rawTokens
    while (
      tokens.length > 0
      && (['sudo', 'command', 'env', 'time', 'nohup'].includes(tokens[0])
        || /^\w+=/.test(tokens[0]))
    ) {
      tokens = tokens.slice(1)
    }
    if (tokens.length === 0) continue
    const head = basename(tokens[0])
    if (head === 'sed') {
      found.push(...inplaceFiles(
        tokens,
        (token) => /^(?:-[a-zA-Z]*i|--in-place)/.test(token),
        (token) => ['-e', '-f', '--expression', '--file'].includes(token),
      ))
    } else if (head === 'perl') {
      found.push(...inplaceFiles(
        tokens,
        (token) => /^-[a-zA-Z]*i/.test(token),
        (token) => /^-[a-zA-Z]*e$/.test(token),
      ))
    } else if (head === 'tee') {
      for (const token of tokens.slice(1)) {
        if (!token.startsWith('-') && SOURCE_FILE.test(token)) found.push(token)
      }
    } else if (head === 'apply_patch') {
      const text = [...bodies, tokens.slice(1).join(' ')].join('\n')
      const patchFiles = [...text.matchAll(globalCopy(PATCH_FILE))]
        .map((match) => match[1])
      found.push(...(patchFiles.length > 0 ? patchFiles : ['(patch)']))
    } else if (head === 'patch' || (head === 'git' && tokens[1] === 'apply')) {
      found.push('(patch)')
    } else if (head === 'git' && (tokens[1] === 'checkout' || tokens[1] === 'restore')) {
      const dashIndex = tokens.indexOf('--')
      const rest = dashIndex >= 0
        ? tokens.slice(dashIndex + 1)
        : tokens[1] === 'restore' ? tokens.slice(2) : []
      for (const token of rest) {
        if (!token.startsWith('-')) found.push(token)
      }
    }
  }
  if (PYTHON.test(shell)) found.push(...pyWrites([shell, ...bodies].join('\n')))
  /** @type {string[]} */
  const names = []
  for (const target of found) {
    if (target.startsWith('(')) {
      names.push(target)
    } else if (notScratch(target)) {
      names.push(basename(target))
    }
  }
  return [...new Set(names.filter((name) => name !== ''))]
}

/**
 * Count `names` as edits in a SpiralState and say so in its action log
 * (upstream `fold_shell_edits`).
 *
 * @param {import('./state.js').SpiralState} state
 * @param {string[]} names
 * @returns {void}
 */
export function foldShellEdits(state, names) {
  for (const name of names) {
    state.editOrder.push(name)
    state.editCounts[name] = (state.editCounts[name] ?? 0) + 1
  }
  if (names.length > 0 && state.recent.length > 0) {
    const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? ', ...' : '')
    state.recent[state.recent.length - 1] += `  [edits ${shown}]`
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A global copy of a regexp, for `matchAll`/repeated stateful matching.
 *
 * @param {RegExp} pattern
 * @returns {RegExp}
 */
function globalCopy(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
}
