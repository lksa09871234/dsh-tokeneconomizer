# Contributing to dsh-tokeneconomizer

Thanks for helping. This project is a DSH plugin port of Microsoft
TokenEconomizer; behavior that is ported should stay faithful to the upstream
mechanism unless a divergence is documented in `docs/PORTING.md`.

## Development setup

```sh
git clone <this-repository>
cd dsh-tokeneconomizer
npm ci
npm run verify
```

No build step: the plugin ships hand-written ESM (`lib/`) and installs directly
from a checkout. `npm ci` installs only development/test dependencies (the DSH
packages used by the offline integration harness, TypeScript for JSDoc type
checking).

## Layout and rules

- `lib/microskills/`, `lib/toolprune/`, `lib/loopguard/`, `lib/usage/` are pure
  JavaScript over plain JSON state. They must not import `lib/dsh/`, DSH
  packages, or `node:fs`. This boundary is enforced by
  `test/unit/architecture.test.js`.
- `lib/dsh/` is the only place that talks to the harness (Cordis events,
  services, commands). Every host callback must be failure-isolated and must
  never throw into a session or agent-creation path.
- Learned content is untrusted data: sanitize newlines/control characters and
  never interpolate it as instructions.
- Do not add runtime dependencies without a strong reason; the plugin is
  intentionally close to zero-dependency (configuration schema only).
- Never fabricate token, cost, or savings numbers in code, tests, docs, or
  output.

## Tests

```sh
npm test                 # unit tests (offline)
npm run test:integration # offline harness against real DSH package code
npm run typecheck        # tsc --noEmit with JSDoc checking
npm run pack:check       # package manifest/files/forbidden-content checks
npm run verify           # all of the above
```

Please add a regression test for every behavior change. Ported upstream test
cases are named in `docs/UPSTREAM.md` §9; keep those names in the test titles so
parity stays traceable.

## Commit and PR

- Keep commits focused; describe the mechanism and the evidence.
- Update `CHANGELOG.md` under `Unreleased` for user-visible changes.
- If you change a threshold or a state schema, update `docs/UPSTREAM.md` §11/§2
  and note the divergence in `docs/PORTING.md`.
- PRs must pass CI (typecheck, unit, integration, pack check) and contain no
  secrets, personal paths, or generated state.

## License

By contributing you agree that your contribution is licensed under the Apache
License 2.0, the same license as this project and the upstream work.
