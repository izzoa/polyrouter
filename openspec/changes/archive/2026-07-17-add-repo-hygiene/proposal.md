## Why

Three repository-hygiene backlog nits (FABLE_AUDIT A-1, A-18, A-20): `format:check` fails on
Drizzle-generated JSON; there is no security-disclosure route or contributor guide; and the root
`package.json` has no `repository` field. Individually minor, but they're the first things an adopter
or contributor looks for.

## What Changes

- **A-1** Add the generated Drizzle migration artifacts (`packages/*/src/database/migrations/`) to
  `.prettierignore` — machine-authored snapshot/journal JSON should not be prettier-checked (reformatting
  churns generated output and can desync drizzle-kit).
- **A-18** Add a top-level `SECURITY.md` (private disclosure route + the sensitive-area map) and
  `CONTRIBUTING.md` (setup, the build/test commands, and the OpenSpec spec-driven workflow).
- **A-20** Add a `repository` field to the root `package.json` (the four workspace `package.json` license
  fields were already aligned in E8).

## Capabilities

### Modified Capabilities

- `packaging`: the repository ships a security-disclosure policy and a contributor guide, and its
  packaging metadata (root `repository`, generated-file formatting exclusions) is complete.

## Impact

- **Files:** `.prettierignore`, `SECURITY.md` (new), `CONTRIBUTING.md` (new), root `package.json`. No
  code, no schema, no runtime change. No changeset (repo docs/config only).
