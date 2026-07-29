# Design: split `agvsr init` into `agvsr init` + `agvsr skill install`

## Goal

`agvsr init` (see `docs/design-init-command.md`) grew a second, unrelated
responsibility: installing the bundled skill (`skills/agvsr/SKILL.md`) and
the `/agvsr` slash command into agent-specific paths. This design splits
that back out into its own command, `agvsr skill install`, so the two
concerns line up with how often each actually needs to run.

## Why split

- **Different lifecycles.** The skill/command content is identical across
  every project on a machine; `team.yaml` is unique per project. Bundling
  them meant every new project re-wrote byte-identical skill files.
- **Per-project skill paths were the wrong default.** `resolveSkillTargetPath`
  already treated `codex` as global (keyed off `$CODEX_HOME`/`~/.codex`,
  ignoring the project directory) while `claude`/`gemini` were project-local
  — an inconsistency with no real justification once you no longer need the
  skill files sitting next to `team.yaml`.
- **Triggered by real use:** adding a second project surfaced that `init`
  either had to be re-run with skill install repeated, or skipped with
  `--no-skill` and the user had to remember to install the skill separately
  anyway. Neither is good UX.

## Architecture

Mirrors the split that already exists between `src/config/team.ts` (schema)
and `src/config/init.ts` (generator): skill/command installation moves into
its own pure-ish module, `src/config/skill-install.ts`, with a thin CLI
wrapper.

`src/config/skill-install.ts`:
- `VALID_SKILL_TARGETS` / `SkillTarget` / `DEFAULT_SKILL_TARGETS` — unchanged
  from before, just relocated.
- `type InstallScope = "global" | "project"` — new. Replaces the old
  `targetDir`-only parameter.
- `resolveSkillTargetPath(target, scope, projectDir?)` /
  `resolveCommandTargetPath(target, scope, projectDir?)` — for `claude` and
  `gemini`, `scope: "global"` resolves under `homedir()`
  (`~/.claude/skills/agvsr/SKILL.md`, `~/.claude/commands/agvsr.md`, and the
  `~/.gemini/...` equivalents); `scope: "project"` resolves under the given
  `projectDir` exactly as `init` used to. `codex` ignores `scope` entirely
  and always resolves under `$CODEX_HOME`/`~/.codex`, matching its prior
  (already-global) behavior.
- `readBundledSkillSource`, `readBundledCommandSource`, `parseSkillTargets` —
  unchanged in behavior, just relocated out of `src/config/init.ts`.
- `SkillInstallError` — new error class, replacing `InitError` for this
  module's validation failures (unknown/empty `--target`, missing
  `projectDir` in project scope).

`src/config/init.ts` is left with only team.yaml concerns: `buildTeamYaml`,
`resolveRoleSpecs`, `BUNDLED_CHARTER_ROLES`, `DEFAULT_MODELS`,
`DEFAULT_ROLES`, `RoleSpec`, `InitSpec`, `InitError`.

`src/cli/agvsr.ts`:
- `case "init"` drops `--no-skill` / `--skill-target` entirely and the
  destination-computation/write logic for skill/command files. It now only
  ever generates and writes `team.yaml`.
- New `case "skill"`, dispatching on a positional verb the same way
  `case "daemon"` dispatches to `start`/`stop`/`restart` — only `install` is
  currently valid; anything else is `unknown skill subcommand: <x>` + usage,
  non-zero exit.

## UX / options

```
agvsr init [options]              Generate a team.yaml without hand editing (unchanged surface,
                                   minus --no-skill/--skill-target)

agvsr skill install [options]
      --target <t>      Agent integration target(s): claude, gemini, codex
                        Repeatable or comma-separated. Default: claude.
      --project <dir>   Install into <dir> instead of the global location.
                        Default: global (~/.claude/skills/agvsr/SKILL.md, etc).
                        Codex always installs globally, ignoring --project.
  -f, --force           Overwrite existing skill/command files
  -h, --help            Show this help
```

### Examples

```
# One-time, machine-wide setup (new default)
agvsr skill install

# Also wire up Gemini
agvsr skill install --target claude,gemini

# Project-scoped install (e.g. testing a modified SKILL.md before it's bundled,
# or pinning a project to a local copy instead of the global one)
agvsr skill install --project .

# Every new project after that just needs its own team.yaml
agvsr init
```

## Backward compatibility

No compatibility shim: `--no-skill` and `--skill-target` are removed from
`agvsr init` outright, not deprecated. The project has no external users
depending on the old flags yet, so a clean cut is preferable to carrying
dead/warn-only flags. `agvsr init`'s core team.yaml behavior (`--output`,
`--stdout`, `--force`, `--roles`, `--adapter`, `--model`, `--role`,
`--no-comments`) is unchanged.

## Docs / bundled-content impacts

- `src/cli/agvsr.ts` `USAGE` string — add the `agvsr skill install` line.
- `commands/agvsr.md` / `commands/agvsr.toml` — clarify that the skill and
  `/agvsr` command are installed once, globally, via `agvsr skill install`,
  separately from `agvsr init`.
- `skills/agvsr/SKILL.md` — the command-reference section previously implied
  `agvsr init` installs the `/agvsr` command; corrected to attribute that to
  `agvsr skill install`.

## Test plan

Unit (`test/skill-install.test.ts`, replacing the skill-target section of
`test/init.test.ts`):
- `resolveSkillTargetPath` / `resolveCommandTargetPath` for `scope: "global"`
  (resolves under `homedir()`, no `projectDir` needed).
- Same for `scope: "project"` (resolves under a given `projectDir`; throws
  `SkillInstallError` without one).
- `codex` ignores `scope` — always keyed off `$CODEX_HOME`/`~/.codex`.
- `parseSkillTargets` dedupe/validation, unchanged from before.

CLI/E2E (`test/cli-skill-install.test.ts`, replacing the skill/command
assertions in `test/cli-init.test.ts`): spawn
`bun src/cli/agvsr.ts skill install ...` with `HOME` (and, for the codex
case, `CODEX_HOME`) overridden to a temp directory so a default run never
touches the real developer's `~/.claude`/`~/.gemini`. Cover: default
global install, `--force` overwrite, `--target gemini`,
comma/repeated `--target claude,gemini`, unknown target rejection, codex
writes only to `$CODEX_HOME` with no command file, and `--project <dir>`
installing under that directory instead of `$HOME`.

`test/cli-init.test.ts` keeps only its team.yaml-focused cases; `--help`
assertions stop expecting `--skill-target`/`--no-skill`.

Follow project tooling (`CLAUDE.md`): `bun test`, `bunx oxlint`, `bunx oxfmt`.

## Acceptance criteria

1. `agvsr init` never writes skill or command files, and no longer accepts
   `--no-skill`/`--skill-target`.
2. `agvsr skill install` with no arguments installs the `claude` skill +
   command globally (`~/.claude/skills/agvsr/SKILL.md`,
   `~/.claude/commands/agvsr.md`), requiring no project context.
3. `--target` accepts `claude`, `gemini`, `codex`, repeatable or
   comma-separated, same validation semantics as the old `--skill-target`.
4. `--project <dir>` installs claude/gemini targets under `<dir>` instead of
   the global location; `codex` is unaffected by `--project`.
5. Existing files are never silently overwritten; `--force` is required.
6. `bun test`, `oxlint`, `oxfmt`, and `tsc --noEmit` are clean.
