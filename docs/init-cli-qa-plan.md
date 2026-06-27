# QA Test Plan: `agvsr init`

## Goal

Verify the `agvsr init` command described in `docs/action-plan.md` as a local,
non-interactive setup command that:

- generates a valid `team.yaml`
- does not require a running daemon
- respects the current team schema and bundled charter behavior
- avoids clobbering an existing `team.yaml` by default
- remains deterministic and CI-friendly

This plan is written before implementation and defines the acceptance gate for the
feature.

## Assumptions

The design under review is treated as a one-shot CLI, not a wizard:

- the command runs to completion without prompts
- the command writes a `team.yaml`-compatible file to the chosen destination
- the generated file is intended to work with the existing `parseTeam` and
  `composeCharter` behavior

If the implementation adds optional flags such as explicit output selection or force
overwrite, those flags should be covered by the same acceptance criteria below.

## Scope

### In scope

- CLI behavior for `agvsr init`
- generated file shape and schema compatibility
- charter compatibility with the bundled defaults/scaffold
- no-daemon execution
- overwrite/clobber safety
- docs/help/manual checks
- CI-safe execution and regression checks

### Out of scope

- daemon lifecycle changes
- job routing, message transport, or worktree behavior
- interactive prompting behavior
- adapter/model probing against live external services

## Acceptance Criteria

The implementation is acceptable only if all of the following hold:

1. `agvsr init` completes non-interactively.
2. The command produces a valid `team.yaml` that `parseTeam` accepts.
3. The generated roles and values remain compatible with the current schema:
   `supervisor`, `design`, `implementation`, and `qa`, with valid adapter/model
   combinations and no schema-breaking extras.
4. The generated config works with the bundled charter system, including the current
   scaffold/default role-charter layering.
5. The command does not need a running daemon and does not attempt to connect to one.
6. If `team.yaml` already exists, the default behavior is to refuse or preserve it rather
   than silently clobbering it.
7. The command is deterministic enough to run in CI using temp directories and without
   network, credentials, or installed model CLIs.
8. User-facing help/docs do not contradict the non-interactive, file-generating behavior.

## Verification Matrix

### 1. Unit coverage for config generation

What to verify:

- the generator produces a stable `team.yaml` body from the bundled defaults
- the output includes all required roles
- the role entries use adapters and model strings accepted by the current schema
- the output does not introduce unsupported schema keys or rely on daemon state

How to check:

- add a pure unit test around the rendering/generation helper if the implementation
  factors one out
- parse the rendered file with `parseTeam`
- assert the resulting object contains exactly the expected core roles
- assert any optional fields are omitted or populated intentionally, not accidentally

Acceptance criteria:

- generation is deterministic
- the file round-trips through the existing team parser
- the generated data matches the existing charter layering model

### 2. CLI integration for `agvsr init`

What to verify:

- the command runs from a temp directory without a daemon
- it creates the expected `team.yaml` file
- it exits successfully and prints a useful status/result message
- it does not try to reach IPC or depend on `agvsrd`

How to check:

- run `agvsr init` in a temp workspace with no daemon started
- set `AGVSR_SOCK` to a bogus path or otherwise ensure any accidental IPC connection would
  fail fast
- assert the command still succeeds and writes the file locally
- if the command reports the output path, verify that message is correct

Acceptance criteria:

- no daemon process is required
- the command behaves like a normal local filesystem tool
- the command is suitable for CI because it only uses local temp paths

### 3. No-clobber default behavior

What to verify:

- an existing `team.yaml` is not overwritten silently
- the command either fails clearly or preserves the existing file, depending on the final
  design
- the original file contents remain intact after the attempted init

How to check:

- precreate a sentinel `team.yaml`
- run `agvsr init` again in the same directory
- assert the command does not replace the sentinel contents unless an explicit overwrite
  mode is used
- if a force/overwrite flag exists, test that it is required and behaves intentionally

Acceptance criteria:

- the default path is safe
- any overwrite path is explicit, not implicit

### 4. Charter compatibility

What to verify:

- the generated team config works with the existing bundled charter layout
- `composeCharter` can load the generated roles without missing-default errors
- the scaffold/default charter layering remains intact
- the generator does not produce role names or charter references that the current code
  cannot resolve

How to check:

- feed the generated file through the existing team parser
- compose charters for at least `supervisor` and one worker role
- assert the prompt contains the expected scaffold and role-charter structure
- confirm there are no unresolved placeholders or missing bundled charter files

Acceptance criteria:

- the generated file is not just syntactically valid YAML; it is usable by the current
  charter system
- the default role architecture remains unchanged

### 5. Help / docs / manual checks

What to verify:

- `agvsr --help` or equivalent top-level usage includes `init`
- `agvsr init --help` or equivalent explains the command as non-interactive
- the user-facing description mentions the generated `team.yaml` and overwrite policy
- any related docs do not describe the command as an interactive wizard if the final
  implementation is non-interactive

How to check:

- run the help text in a terminal
- review the command description and options manually
- compare the wording with the feature contract above

Acceptance criteria:

- the docs and CLI help match the implemented behavior
- there is no mismatch between the plan and the shipped usage text

### 6. Regression and CI checks

What to verify:

- the new command does not break the existing CLI surface
- the repository test suite still passes
- lint/format checks remain clean

How to check:

- run `bun test`
- run `bunx oxlint src test`
- run `bunx oxfmt`

Acceptance criteria:

- the repo’s standard checks pass after the change
- the feature is runnable in CI without extra services

## Concrete Cases

### Positive cases

- `agvsr init` in an empty temp directory creates a valid `team.yaml`
- the generated file parses with `parseTeam`
- `composeCharter` succeeds for `supervisor` and a worker role using the generated config
- `agvsr init` succeeds when no daemon is running and the IPC socket path is invalid

### Negative cases

- running `agvsr init` when `team.yaml` already exists does not silently overwrite it
- the command does not require adapter binaries, models, or network access
- the command does not fail just because no daemon or store exists

### Edge cases

- a preexisting `team.yaml` with user edits remains byte-identical after a rejected init
- help text remains accurate if the implementation adds an explicit overwrite flag
- the generated file remains valid if executed from a directory with unusual but local
  paths

## Recommended Test Harness Shape

- Use `mkdtempSync` or equivalent temp directories so the test never touches the real
  workspace.
- Keep all checks local and deterministic; do not depend on daemon startup, model CLI
  availability, or network services.
- Prefer a pure generation helper for unit tests, then a real CLI smoke test for the
  filesystem write path.
- Use the existing `parseTeam` and `composeCharter` helpers to validate schema/charter
  compatibility instead of re-implementing those checks in the test.

## Review Outcome

The `agvsr init` change is acceptable only if:

- the command is non-interactive
- `team.yaml` generation is valid against the current schema and charter behavior
- the daemon is not required
- the default path does not clobber existing files
- the command is practical to run in CI
- repository tests and lint/format checks stay green
