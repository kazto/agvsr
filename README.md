# agvsr (AGents superViSoR)

`agvsr` is an AI agent orchestrator. It assigns roles — supervisor, design,
implementation, QA — to multiple coding-agent CLIs (Claude Code, Codex, Gemini /
Antigravity) and lets them coordinate by passing messages to each other while
working a single goal to completion.

Each job runs in its own isolated git worktree on its own branch, so agents never
touch your working tree directly. You submit a goal, the supervisor delegates to
the worker roles, and you review the resulting branch.

## Requirements

- **[Bun](https://bun.sh) ≥ 1.3.14** — the only runtime dependency. All scripts are
  TypeScript executed by Bun; Node-only environments are not supported.
- **At least one agent CLI** for the adapters you configure:
  - `claude-code` adapter → the `claude` CLI
  - `codex` adapter → the `codex` CLI
  - `agy` adapter → the Antigravity / Gemini CLI
- A **git repository** for the target project (jobs run in per-job worktrees).

Run `agvsr doctor` to check that the adapter CLIs are installed and authenticated.

## Install

```sh
# Run without installing
bunx agvsr --help

# Or install from npm (still requires Bun at runtime)
npm install -g agvsr
agvsr --help
```

## Quick start

```sh
# 1. Generate a team.yaml (4 standard roles, all claude-code)
agvsr init

# 2. Check adapters are installed and authenticated
agvsr doctor

# 3. Start the daemon
agvsr daemon start

# 4. Submit a job from inside your project repo
agvsr job "add a health endpoint"

# 5. Watch the roles coordinate in real time
agvsr watch
```

When the job finishes, its work is on a branch named `agvsr/<job-id>` in a worktree
under `~/.config/agvsr/worktrees/<job-id>`. Review and merge it like any branch.

## Concepts

### Roles and the star topology

A team is a set of **roles**, each bound to an adapter (CLI) and a model. The
**supervisor** is the hub: it talks to the human and delegates to worker roles. The
standard workers are:

- **supervisor** — owns the goal, plans, delegates, reports back to you
- **design** — produces the implementation design (gated before coding by default)
- **implementation** — writes the code
- **qa** — verifies the change actually works

Messaging follows a star topology: the supervisor may message any worker (and the
human); a worker may only message the supervisor.

### Charters

Each role runs under a **charter** — a system prompt defining its responsibilities
and guardrails. The four standard roles ship with bundled charters (English and
Japanese variants under `charters/defaults/`). In `team.yaml` you can:

- omit `charter` → use the bundled default
- set `charter_append` → keep the default and add project-specific rules (most common)
- set `charter` → replace the default wholesale

### Worktree isolation

Every job is provisioned a dedicated git worktree on a fresh `agvsr/<id>` branch.
Agents do all their work there, never in your main checkout. This is the core safety
guarantee — destructive commands an agent might run are confined to the job's
worktree.

### Messages

Roles communicate through a SQLite-backed inbox at `~/.config/agvsr/inbox.sqlite`.
`agvsr watch` and `agvsr logs` read from it so you can follow the conversation.

## Configuration: `team.yaml`

`team.yaml` is the source of truth for a team. Generate one with `agvsr init` or
write it by hand:

```yaml
roles:
  supervisor:
    adapter: claude-code
    model: claude-opus-4-8
  design:
    adapter: claude-code
    model: claude-sonnet-4-6
  implementation:
    adapter: codex
    model: gpt-5-codex
  qa:
    adapter: agy
    model: gemini-3-pro

# Optional event hooks. Each value is a shell command run via `sh -c`;
# the event JSON is written to the command's stdin. All keys are optional.
# hooks:
#   on_job_done: "notify-send 'agvsr' 'Job complete'"
#   on_job_failed: "notify-send 'agvsr' 'Job failed'"
#   on_supervisor_message: "notify-send 'agvsr' 'Supervisor needs input'"
#   on_job_stalled: "notify-send 'agvsr' 'Job stalled'"
```

Per-role fields:

| Field             | Description                                                 |
| ----------------- | ----------------------------------------------------------- |
| `adapter`         | One of `claude-code`, `codex`, `agy` (required)             |
| `model`           | Raw per-CLI model string (required)                         |
| `charter`         | Replace the bundled default charter wholesale               |
| `charter_append`  | Append project rules to the bundled default charter         |
| `instances`       | Number of instances of this role (default `1`)              |
| `hard_timeout_ms` | Absolute per-turn time limit, overriding the env/default    |
| `idle_timeout_ms` | No-progress per-turn time limit, overriding the env/default |

The team must define a `supervisor` role. The daemon's default team file is
resolved as: explicit `--team` flag → `$AGVSR_TEAM` → `./team.yaml` (relative
to wherever the daemon was started). One daemon serves every project on the
machine, but each job resolves its own team from `<job-target-repo>/team.yaml`
first if that repo has one, before falling back to the daemon's default — so
a single always-running daemon correctly serves multiple projects with
different roles/adapters/models, as long as each has run `agvsr init`.

### `agvsr init` options

```
agvsr init [options]

  -o, --output <path>   Write to this file (default: ./team.yaml)
      --stdout          Write to stdout instead of a file
  -f, --force           Overwrite the output file if it already exists
      --no-skill        Skip installing the bundled skill and /agvsr command
      --skill-target    Agent integration target(s): claude, gemini, codex
                        Repeatable or comma-separated. Default: claude
      --roles <list>    Comma-separated role names
                        (default: supervisor,design,implementation,qa)
      --adapter <a>     Default adapter for every role (default: claude-code)
      --model <m>       Default model for every role
      --role <spec>     Per-role override, repeatable. Form: name:adapter:model
      --no-comments     Emit bare YAML without header/hooks comments
  -h, --help            Show this help
```

Example — mix adapters per role:

```sh
agvsr init \
  --role supervisor:claude-code:claude-opus-4-8 \
  --role implementation:codex:gpt-5-codex \
  --role qa:agy:gemini-3-pro
```

By default, `agvsr init` also installs the bundled `agvsr` skill and a
`/agvsr` slash command for Claude under the generated project directory.
`gemini` installs the skill and an equivalent `/agvsr` command under the
generated project directory as well. `codex` installs only the skill —
globally to `$CODEX_HOME/skills/agvsr/SKILL.md` or
`~/.codex/skills/agvsr/SKILL.md` when `CODEX_HOME` is unset, and only when
explicitly selected — since Codex has no user-definable custom-command
mechanism; invoke the skill there with `$agvsr` or browse via `/skills`
instead. Use `--skill-target` to add Gemini or Codex targets, or `--no-skill`
to skip installation entirely.

The `/agvsr` command only bootstraps the daemon (confirms this project has
its own `team.yaml`, runs `agvsr doctor`, and starts the daemon if it isn't
running yet) — actual job submission, approvals, and monitoring are covered
by the skill.

## Command reference

| Command                                                   | Description                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| `agvsr init [options]`                                    | Generate a `team.yaml`                                           |
| `agvsr daemon [--team F]`                                 | Run the daemon in the foreground                                 |
| `agvsr daemon start [--team F]`                           | Start the daemon in the background                               |
| `agvsr daemon stop`                                       | Stop the running daemon gracefully                               |
| `agvsr daemon restart [--team F]`                         | Restart the daemon (optionally with a new team file)             |
| `agvsr ping`                                              | Check the daemon is up                                           |
| `agvsr job "<goal>" [--cwd D] [--id ID]`                  | Submit a job (`D` is the target repo, default: cwd)              |
| `agvsr status [job-id]`                                   | List jobs, or show one job with recent audit state               |
| `agvsr logs <job-id> [-f]`                                | Show audit messages for a job (`-f` to follow)                   |
| `agvsr watch [--all] [--poll N]`                          | Stream role messages across running jobs in real time            |
| `agvsr tell <job-id> "<message>"`                         | Send a message to a running job's supervisor                     |
| `agvsr stop <job-id>`                                     | Stop a running job gracefully (marks it failed)                  |
| `agvsr kill <job-id>`                                     | Kill a running job immediately (marks it interrupted)            |
| `agvsr wait <job-id>... [--poll-sec N] [--timeout-sec N]` | Block until each job needs approval or reaches a terminal status |
| `agvsr reload`                                            | Reload `team.yaml` without restarting the daemon                 |
| `agvsr team`                                              | Show configured roles                                            |
| `agvsr cleanup [--apply]`                                 | Report (or remove) job worktrees/branches safe to delete         |
| `agvsr doctor [--team F] [--json] [--probe]`              | Check adapter CLIs and auth; exit 0 if all pass                  |

### Typical workflow

```sh
agvsr daemon start                      # once per machine/session
agvsr job "refactor the auth module"    # returns a job id, runs in background
agvsr watch                             # follow the roles in real time
agvsr tell <job-id> "prefer minimal diffs; don't touch the CLI"  # steer mid-flight
agvsr status <job-id>                   # check progress and whether it's stalled
```

`agvsr watch` highlights running jobs by default; pass `--all` to include finished
ones and `--poll N` to change the poll interval (milliseconds, minimum 500).

## Environment variables

| Variable                     | Purpose                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `AGVSR_TEAM`                 | Default team file path                                                                         |
| `AGVSR_STORE`                | SQLite store path (default `~/.config/agvsr/inbox.sqlite`)                                     |
| `AGVSR_SOCK`                 | IPC endpoint (unix socket / named pipe) override                                               |
| `AGVSR_DESIGN_GATE`          | Design-approval gate before implementation; on by default, disable with `0`/`off`/`false`/`no` |
| `AGVSR_STALL_TIMEOUT_MS`     | Idle-watchdog threshold for marking a job stalled                                              |
| `AGVSR_NO_PROGRESS_TURNS`    | No-progress turn limit before intervention                                                     |
| `AGVSR_LOOP_REPEAT_TURNS`    | Repeated-turn detection threshold                                                              |
| `AGVSR_MAX_LOOP_ESCALATIONS` | Max loop escalations before giving up                                                          |
| `AGVSR_MAX_WORKER_FAILURES`  | Max worker failures tolerated                                                                  |
| `AGVSR_DEBUG`                | Enable verbose daemon debug logging                                                            |

## Files and locations

- `~/.config/agvsr/inbox.sqlite` — message + job store
- `~/.config/agvsr/worktrees/<job-id>` — per-job git worktree
- `~/.config/agvsr/agvsrd.sock` — daemon IPC socket (POSIX; named pipe on Windows)
- `team.yaml` — team configuration (per project, or via `$AGVSR_TEAM`)

Paths honor `XDG_CONFIG_HOME` / `XDG_RUNTIME_DIR` on POSIX and `%APPDATA%` on Windows.

## npm distribution

`agvsr` is published as an npm package but requires Bun at runtime.

- Install: `npm install agvsr`
- Run directly: `bunx agvsr --help`
- Run after a local install: `npm exec agvsr -- --help`

When building a release tarball, verify `src/`, `charters/`, `examples/`,
`skills/`, and `README.md` are included:

```sh
npm pack --dry-run --json
```
