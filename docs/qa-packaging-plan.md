# QA Plan: npm Packaging for `agvsr`

## Goal

Verify that `agvsr` can be shipped as a publishable npm package without exposing internal implementation details, while keeping the runtime tarball intentionally small and Bun-specific at runtime.

This plan is based on the packaging design:

- `package.json` must be publishable and not `private`
- published files must be focused via a whitelist
- the public API must be exposed through a new `src/index.ts`
- README must document `npm`/`bunx` usage and state that Bun is required at runtime
- a packaging smoke test must validate the packed file set with `npm pack --dry-run --json`
- do not assume `license` or `publishConfig.access` unless policy is explicitly provided

## Scope

### In scope

- `package.json` publishability and package metadata
- public entry points and export surface
- packed file set and exclusion of test-only content
- README packaging/runtime documentation
- smoke test coverage for the npm tarball shape

### Out of scope

- changing runtime behavior unrelated to packaging
- deciding repository license or npm access policy
- redesigning the CLI, daemon, or adapter internals

## Expected package shape

The package should expose only the stable surface required for users to:

- invoke the CLI via `bin`
- import the documented public API via `exports`
- run the package under Bun at runtime

The packed tarball should include:

- `package.json`
- `README.md`
- `src/` runtime sources, including the new `src/index.ts`
- `charters/`
- `examples/`
- any other explicitly required runtime files

The packed tarball should exclude:

- `test/`
- `docs/` other than `README.md`
- local repo plumbing and developer-only files
- build/test fixtures that are not needed at runtime

## Verification matrix

### 1. Package metadata is publishable

Check:

- `private` is absent or `false`
- `files` is a focused allowlist, not a broad include-all default
- `bin` points at the published CLI entry
- `exports` points at the intended public surface
- no policy is silently invented for `license` or `publishConfig.access`

Commands:

```bash
jq '.private, .files, .bin, .exports, .license, .publishConfig' package.json
```

Acceptance criteria:

- the package is publishable
- the file allowlist matches the design intent
- the published entry points resolve to package-facing files only
- missing `license` or `publishConfig.access` is acceptable unless the human supplies a policy

### 2. Public API surface is isolated

Check:

- `src/index.ts` exists
- it exports only the stable public API intended for consumers
- it does not re-export internal daemon/router/adapters implementation details unless those are explicitly meant to be public
- internal files remain importable internally but are not part of the documented public contract

Commands:

```bash
sed -n '1,220p' src/index.ts
sed -n '1,220p' package.json
```

Acceptance criteria:

- the public import path is a single stable entry point
- consumers can use the documented API without reaching into internal modules
- the export surface is minimal and intentional

### 3. README documents packaging/runtime usage

Check:

- README shows installation or execution examples using `npm` and `bunx`
- README explicitly states Bun is required at runtime
- README does not imply Node-only execution
- README matches the published CLI/API entry points

Commands:

```bash
sed -n '1,260p' README.md
```

Acceptance criteria:

- a user can tell how to install and run the package from npm
- a user can tell that Bun is the runtime requirement
- the documented commands match the packaged binary name and entry points

### 4. Tarball contents are whitelisted and clean

Check:

- `npm pack --dry-run --json` produces a tarball manifest
- the packed file list contains the intended runtime files
- `test/` content is excluded
- non-runtime documentation and development-only content are excluded
- the tarball does not leak broad repository internals by accident

Commands:

```bash
npm pack --dry-run --json
```

Acceptance criteria:

- the tarball contains the expected runtime files and directories
- the tarball does not contain test files or other development-only content
- only intentional files appear in the packed manifest

### 5. Packaging smoke test is automated

Check:

- there is a test that shells out to `npm pack --dry-run --json`
- the test parses the JSON output and asserts the file list
- the test fails if an unexpected file is included or an expected runtime file is missing
- the test explicitly encodes the allowlist/denylist relationship from the design

Commands:

```bash
bun test
```

Acceptance criteria:

- the packaging smoke test runs in the normal test suite
- the smoke test protects the tarball shape from regression
- test-only content stays excluded over time

## Specific cases to cover

### Positive cases

- package metadata is publishable
- `src/index.ts` exists and is the public entry point
- CLI entrypoint is present in `bin`
- tarball includes `src/`, `charters/`, `examples/`, and `README.md`
- README includes `npm` and `bunx` usage

### Negative cases

- `private: true` is rejected
- internal implementation files are not exposed as public API
- `test/` files are absent from the tarball
- docs other than `README.md` are absent from the tarball
- missing `license` or `publishConfig.access` is not treated as a failure unless a policy is provided

### Edge cases

- nested runtime files under `src/` are included when needed
- package metadata still works if optional policy fields are intentionally absent
- the smoke test remains stable across platforms and Bun versions used in CI

## Review outcome

The implementation is acceptable only if all of the following are true:

- the package is publishable
- the public API is constrained to the intended stable surface
- the tarball contains only the intended runtime files
- README tells users how to consume the package and that Bun is required
- the smoke test enforces the tarball shape

