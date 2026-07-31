# Design: `self-improve` skill + multi-skill `agvsr skill install`

## Goal

Add a second bundled skill, `self-improve`, that turns an explicitly-flagged
mistake or lesson-learned into a durable guardrail appended to the user's
global `~/.claude/CLAUDE.md`. Install it through the existing
`agvsr skill install` command so it's available both to agvsr job/worker
agents and to ordinary Claude Code sessions, the same way the `agvsr` skill
already is.

## Why

`agvsr skill install` previously assumed exactly one skill (`agvsr`) —
`BUNDLED_SKILL_SOURCE_PATH` was a single constant, and every path-resolution
function had `"agvsr"` baked into its return value. Adding a second skill
required generalizing that to a `SkillName` axis orthogonal to the existing
`SkillTarget` axis (claude/gemini/codex), producing a skill × target
install matrix instead of a single-skill × target one.

## Architecture

`src/config/skill-install.ts`:
- `VALID_SKILL_NAMES = ["agvsr", "self-improve"] as const`, `type SkillName`,
  `DEFAULT_SKILL_NAMES = ["agvsr"] as const` — mirrors the existing
  `SkillTarget`/`VALID_SKILL_TARGETS`/`DEFAULT_SKILL_TARGETS` triad.
  `DEFAULT_SKILL_NAMES` is the single place backward compatibility is
  guaranteed: `agvsr skill install` with no `--skill` flag must keep
  installing only `agvsr`, exactly as before this change.
- `BUNDLED_SKILL_SOURCE_PATH` (single constant) → `BUNDLED_SKILL_SOURCE_PATHS:
  Record<SkillName, string>`.
- `BUNDLED_COMMAND_SOURCE_PATHS` gained a `SkillName` layer:
  `Partial<Record<SkillName, Partial<Record<SkillTarget, string>>>>`. Only
  `agvsr` has entries — `self-improve` has no bundled command for any target,
  so `resolveCommandTargetPath`/`readBundledCommandSource` return `null` for
  it everywhere, the same way they already did for `codex`.
- `readBundledSkillSource`, `readBundledCommandSource`,
  `resolveSkillTargetPath`, `resolveCommandTargetPath` all gained a leading
  `skill: SkillName` parameter (breaking change to these functions' call
  sites, all internal to this repo — CLI and tests updated in the same
  change).
- `parseSkillTargets` and the new `parseSkillNames` now share one generic
  `parseNames<T>` helper (comma/repeatable parsing, first-seen dedupe,
  `SkillInstallError` on empty/unknown entries) instead of duplicating the
  loop.

`src/cli/agvsr.ts` `case "skill"`:
- New `--skill <s>` option (repeatable/comma-separated, same shape as
  `--target`), parsed with `parseSkillNames`.
- Skill and command destinations are computed as the `skillNames × targets`
  cross product; the existing all-or-nothing overwrite check (`--force`
  required if *any* intended path already exists) is unchanged, just applied
  to the larger destination list.

## Why `self-improve` ships with no slash command

The `/agvsr` command exists because agvsr has a real bootstrap step (confirm
`team.yaml`, run `agvsr doctor`, start the daemon) that's worth a dedicated
entry point. `self-improve` has no equivalent setup step and is meant to
trigger only on an explicit, occasional request ("make this a permanent
rule") — the skill's own frontmatter `description` is sufficient for
discovery, and adding a command would only add another row to the
skill × target matrix for no benefit.

## Why the skill enforces a confirmation gate before writing

`~/.claude/CLAUDE.md` is loaded into every Claude Code session on the
machine, across every project, with instructions that explicitly override
default behavior. That makes it high-leverage in both directions: a good
guardrail prevents a class of mistakes across all future work, but a bad
one (too specific, duplicated, or simply wrong) silently degrades every
other instruction in the file, indefinitely, in every project. Unlike a
one-off code edit, a bad write here can't be caught by tests. `skills/
self-improve/SKILL.md` therefore hard-requires: only trigger on an explicit
user request (not merely because a mistake occurred), check the existing
file for duplicates/contradictions first, and show the exact diff for
explicit confirmation before writing — never write speculatively.

## Test plan

`test/skill-install.test.ts`: existing `resolveSkillTargetPath`/
`resolveCommandTargetPath`/`readBundledCommandSource` calls updated to pass
`"agvsr"` as the new leading argument. Added: `parseSkillNames` default/
dedupe/rejection cases (mirroring `parseSkillTargets`'s), and `self-improve`
path resolution / bundled-source / no-command-for-any-target coverage.

`test/cli-skill-install.test.ts`: `skillPath`/`commandPath` helpers gained an
optional `skill = "agvsr"` parameter so existing call sites are unaffected.
Added: a backward-compat regression test asserting a default (no `--skill`)
run never writes `self-improve` files, `--skill self-improve` (skill file
only, no command), `--skill agvsr,self-improve` (both skills, command only
for `agvsr`), `--skill self-improve --target gemini,codex`, and rejection of
an unknown `--skill` value before any write happens.

## Acceptance criteria

1. `agvsr skill install` with no `--skill` flag behaves exactly as before —
   installs only the `agvsr` skill + `/agvsr` command.
2. `agvsr skill install --skill self-improve` installs
   `skills/self-improve/SKILL.md` to the resolved skill path for each
   `--target`, and writes no command file for any target.
3. `agvsr skill install --skill agvsr,self-improve` installs both, in one
   pass, sharing the same overwrite/`--force` semantics.
4. `bun test`, `oxlint`, `oxfmt`, and `tsc --noEmit` are clean.
