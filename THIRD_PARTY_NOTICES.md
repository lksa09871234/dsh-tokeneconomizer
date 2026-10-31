# Third-party notices

This project is distributed under the Apache License 2.0 (see `LICENSE`).

## TokenEconomizer (upstream, Apache-2.0)

The mechanisms in this project are a port of TokenEconomizer:

- Project: https://github.com/microsoft/TokenEconomizer
- Commit studied: `e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9` (2026-10-30)
- Paper: "TokenEconomizer: Experience-Driven Black-Box Cost Control for Coding
  Agents", Li et al., https://arxiv.org/abs/2610.22732
- Copyright: Microsoft Corporation and the TokenEconomizer authors
- License: Apache License 2.0 — full text in `LICENSE`

No NOTICE file or per-file copyright headers exist in the upstream repository
at the studied commit. This project retains the upstream license, states the
changes made (a DSH adaptation plus a JavaScript reimplementation of the
mechanisms), and does not claim to be an official Microsoft product. The
derivation map is in `docs/UPSTREAM.md`.

## @deepseek-ai/schemastery (MIT)

Runtime dependency used only to declare the plugin's configuration schema, the
same schema library the DeepSeek Harness packages use.

- Package: https://www.npmjs.com/package/@deepseek-ai/schemastery
- License: MIT

## Development-only dependencies

TypeScript, Node type definitions, and the DeepSeek Harness packages used by the
offline integration tests are development dependencies and are not distributed
with the plugin. Their licenses apply to their respective packages.
