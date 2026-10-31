# Security policy

## What this plugin stores

All state is local and lives under `<DSH_HOME>/tokeneconomizer` (or a configured
`dataDir`):

- project identity: a SHA-256 key of the project root path and a symbolic
  display path (`$DSH_HOME/...` or `~/...`), never an absolute home path in
  diagnostics;
- learned facts: short claim strings derived from command/error observations,
  with fact ids and counters;
- tool-pruning evidence: tool names/descriptions and counts;
- loop-guard envelope: numeric turn-length samples;
- ledger: session ids, token categories, counts, and plugin overhead fields;
- diagnostics: redacted, bounded, single-line records.

It does **not** store prompts, assistant replies, file contents, tool output
bodies, environment values, credentials, cookies, or API keys. Diagnostics pass
through a redactor that removes common token formats, emails, and personal
absolute paths.

## Untrusted data handling

Session logs are data, not instructions. Learned strings are sanitized to a
single line and injected inside an explicitly delimited notes section that says
they were learned from earlier sessions, may be stale, and are not user
instructions. The optional model proposer reads only a compact digest (commands,
edited file names, normalized error signatures), never raw transcripts. The
optional judge reads a leakage-safe activity digest.

## Network and telemetry

The plugin makes no network requests of its own and has no telemetry. Optional
model calls use the DSH session's configured model route through the harness;
their token usage appears as plugin overhead in the ledger.

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's GitHub
Security Advisories ("Report a vulnerability") instead of a public issue. If
advisories are unavailable, open an issue that contains only a minimal
description and request a private channel; do **not** include secrets or user
data in any issue.

Include: affected version, DSH version, platform, reproduction steps, and the
impact. This is a community port with no bounty program.
