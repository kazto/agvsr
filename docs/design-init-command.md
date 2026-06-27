# Design: `agvsr init` — non-interactive team.yaml generator

## Goal

Add a CLI command that generates a valid `team.yaml` **without any hand editing and
without an interactive prompt**, so a fresh user (or a test, or a script) can go from a
clean checkout to a runnable team config in one command.

This is the non-interactive form of the `agvsr init` idea in
`docs/action-plan.md` §1. The action plan framed it as an interactive wizard; this design
deliberately specifies a **flag-driven, TTY-free** command instead. A wizard can be layered
on later as a thin front-end that calls the same pure generator.

## Why non-interactive first

- **Testable.** Generation becomes a pure function of its inputs — no stdin mocking, no TTY.
- **Scriptable / CI-friendly.** `agvsr init --stdout ... | ...` and provisioning scripts work.
- **Smaller surface.** No prompt library, no terminal state handling.

## Grounding in the existing code

- `src/config/team.ts` — schema is the contract the output must satisfy:
  - `roles` is a record; each role = `{ adapter, model, charter?, charter_append?, instances=1 }`.
  - `adapter` ∈ `ADAPTERS = ["claude-code", "codex", "agy"]`.
  - `model` is a required non-empty string.
  - A `supervisor` role is **mandatory** (`parseTeam` throws otherwise).
- `src/daemon/daemon.ts:33` — default team path the daemon looks for is
  `join(process.cwd(), "team.yaml")` (overridable by `--team` / `AGVSR_TEAM`).
  `init` must therefore default its output to `./team.yaml` so `agvsr daemon` / `job` find it.
- `src/adapters/charter.ts:64` — a role's default charter is read from
  `charters/defaults/<role>.md`. Bundled defaults exist only for
  **supervisor, design, implementation, qa**. A role outside this set with no
  `charter`/`charter_append` will fail at spawn time → `init` must guard against this (below).
- `examples/team.yaml` — shape and comment style the generated file should mirror
  (header comment, commented-out `hooks:` block). `team.yaml.example` is a near-duplicate;
  `init` makes both copy-templates largely unnecessary.
- `src/cli/agvsr.ts` — command dispatch is a `switch` in `main(argv)` using `parseArgs`.
  Local-only commands (e.g. `daemon start`) do **not** call `withClient`. `init` is purely
  local: **it must not require a running daemon.** Pattern to follow: `startDaemonDetached`
  is an exported, dependency-injected, unit-testable function with a thin CLI wrapper.

## Architecture

Two layers, mirroring `startDaemonDetached` + its `case`:

1. **Pure generator** (new module, e.g. `src/config/init.ts`):
   - `interface RoleSpec { role: string; adapter: Adapter; model: string }`
   - `interface InitSpec { roles: RoleSpec[]; comments: boolean }`
   - `buildTeamYaml(spec: InitSpec): string` — returns the YAML text. No I/O.
   - Internally builds the object and serializes with the existing `yaml` dependency
     (`stringify`), then prepends the header/`hooks` comment block as text.
   - **Self-check:** before returning, the result is fed through `parseTeam()` so the
     generator can never emit a file the loader would reject. (Catches supervisor-missing,
     bad adapter, empty model.)
2. **CLI wrapper** (`case "init"` in `main`):
   - Parses flags, resolves the role list + per-role adapter/model, calls `buildTeamYaml`,
     then handles output target / overwrite / exit codes.

Keeping `buildTeamYaml` pure (string in → string out) is the testability lever: the
end-to-end test drives the real `init` command; unit tests cover the generator directly.

## UX / options

```
agvsr init [options]

  -o, --output <path>   Where to write team.yaml (default: ./team.yaml)
      --stdout          Write to stdout instead of a file (implies no overwrite checks)
  -f, --force           Overwrite the output file if it already exists
      --roles <list>    Comma-separated role names (default: supervisor,design,implementation,qa)
      --adapter <a>     Default adapter for every role (default: claude-code)
      --model <m>       Default model for every role (overrides the per-adapter default)
      --role <spec>     Per-role override, repeatable. Form: name:adapter:model
      --no-comments     Emit bare YAML with no header/hooks comments
  -h, --help            Show usage
```

Resolution order for each role's `adapter`/`model`:
`--role name:adapter:model`  >  `--adapter` / `--model`  >  built-in default.

### Built-in default models (per adapter)

Used when neither `--role` nor `--model` specifies one. Best-effort, documented as
"verify with your CLI" (a future `doctor` validates availability — action-plan §1):

| adapter      | default model        |
| ------------ | -------------------- |
| claude-code  | `claude-opus-4-8`    |
| codex        | `gpt-5.5`            |
| agy          | `gemini-3-pro`       |

`supervisor` always gets the chosen adapter's strongest default; workers may be set
explicitly via `--role`. (No special-casing beyond the table for v1 — keep it predictable.)

### Examples

```
# Zero-config: 4 standard roles, all claude-code, to ./team.yaml
agvsr init

# Codex everywhere, print to stdout (great for inspection / piping / tests)
agvsr init --adapter codex --stdout

# Mixed team with explicit models
agvsr init \
  --role supervisor:codex:gpt-5.5 \
  --role design:claude-code:claude-opus-4-8 \
  --role implementation:claude-code:claude-sonnet-4-6 \
  --role qa:agy:gemini-3-pro

# Regenerate over an existing file
agvsr init --force
```

## Generated file behavior

- **Default output:** `./team.yaml` (matches the daemon's default lookup).
- **`supervisor` is always present.** If `--roles` omits it, it is prepended automatically
  (with a one-line stderr notice) rather than producing an invalid file.
- **Key order is stable:** `supervisor` first, then the remaining roles in the order given;
  within a role, `adapter` then `model`. Deterministic output → snapshot-testable.
- **Comments** (unless `--no-comments`): a short header explaining the file + the
  commented-out `hooks:` block, mirroring `examples/team.yaml`.
- **Overwrite policy:** if the output exists and neither `--force` nor `--stdout` is given,
  **refuse** with a clear message (`team.yaml already exists; pass --force to overwrite`)
  and a non-zero exit. Never silently clobber.
- **Trailing newline**, LF line endings.

## Schema / charter alignment

- Adapter values are validated against `ADAPTERS`; an unknown adapter in a `--role` spec is
  a usage error (exit non-zero) **before** writing anything.
- Model must be non-empty; empty → usage error.
- The whole generated document is round-tripped through `parseTeam()` and must pass; this
  guarantees alignment with `src/config/team.ts` without duplicating its rules.
- **Charter guard:** if a requested role is **not** one of the bundled-charter roles
  (`supervisor`, `design`, `implementation`, `qa`), `init` prints a warning that the role
  has no bundled charter and will need a `charter`/`charter_append` entry to run, and emits
  the role with a `# TODO: add charter or charter_append` comment line. (It still writes a
  syntactically valid file; the human is told what to finish.) This keeps `init` honest
  about `charter.ts`'s lookup behavior.
- `instances` is omitted from output (schema default is 1); keeps the file minimal.

## What "works end-to-end" means (for QA)

- **Entry point:** the `agvsr init` CLI command (`src/cli/agvsr.ts`), run as
  `bun run src/cli/agvsr.ts init ...` (or the built binary).
- **Happy path, file mode:** in a fresh temp dir, `agvsr init -o $TMP/team.yaml` exits 0,
  the file exists, and `loadTeam($TMP/team.yaml)` parses without throwing and contains a
  `supervisor` role. This generated file is sufficient for `agvsr daemon` to start (no
  manual editing required) — the core acceptance.
- **Happy path, stdout mode:** `agvsr init --stdout` prints YAML to stdout, exit 0, and
  `parseTeam(stdout)` succeeds. No file is created.
- **Idempotency / safety:** running `init` twice without `--force` exits non-zero on the
  second run and leaves the first file untouched; with `--force` it overwrites.

## Test plan (the implementer should add)

Unit (`test/init.test.ts`), against the pure generator — no daemon, no TTY:

- `buildTeamYaml` with defaults → parses via `parseTeam`, supervisor first, 4 roles.
- `--role` overrides applied; resolution precedence honored.
- supervisor auto-prepended when omitted from `--roles`.
- invalid adapter / empty model → throws (surfaced as CLI usage error).
- `--no-comments` produces a header-free document that still parses.
- Snapshot of the default output for stable formatting.

CLI/E2E (extend `test/cli-daemon.test.ts` or a new `test/cli-init.test.ts`):

- `init -o <tmp>` writes a file that `loadTeam` accepts; exit 0.
- second run without `--force` → non-zero exit, file unchanged.
- `--force` → overwrites.
- `--stdout` → no file written, stdout parses.

Follow project tooling (`CLAUDE.md`): `bun test`, `bunx oxlint`, `bunx oxfmt`.

## Docs impacts

- `src/cli/agvsr.ts` `USAGE` string — add the `agvsr init` line.
- `README.md` — add an "Getting started" step: `agvsr init` before `agvsr daemon`.
- `docs/action-plan.md` §1 — mark `agvsr init` as delivered in non-interactive form; note
  the interactive wizard can wrap the same generator later.
- `examples/team.yaml` / `team.yaml.example` — note (or eventually drop) that copying these
  is no longer the recommended path; `agvsr init` is. Out of scope to delete here.

## Acceptance criteria

1. `agvsr init` with no arguments writes a valid `./team.yaml` (4 standard roles) that
   `loadTeam` accepts and `agvsr daemon` can start against — with **no** hand editing.
2. The command is fully non-interactive: it never reads stdin and behaves identically with
   or without a TTY.
3. Output target is configurable (`--output`, `--stdout`); default is `./team.yaml`.
4. Existing files are never silently overwritten; `--force` is required, otherwise exit
   non-zero with a clear message.
5. Role set and per-role adapter/model are controllable via `--roles`, `--adapter`,
   `--model`, and repeatable `--role name:adapter:model`, with the documented precedence.
6. `supervisor` is always present in the output; a missing supervisor cannot be produced.
7. Invalid input (unknown adapter, empty model) fails fast with a non-zero exit and a clear
   message, before any file is written.
8. The generated document always passes `parseTeam()` (self-checked by the generator).
9. Roles without a bundled charter produce a visible warning + a TODO marker, never a
   silently-broken config.
10. `init` requires **no running daemon**.
11. Unit + CLI tests above pass; `bun test`, `oxlint`, `oxfmt` are clean.
