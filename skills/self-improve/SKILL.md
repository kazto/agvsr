---
name: self-improve
description: >
  Turn a mistake, correction, or lesson-learned into a durable guardrail in
  ~/.claude/CLAUDE.md, the global Claude Code instructions file that every
  project loads and that overrides default behavior. Use ONLY when the user
  explicitly asks to persist the lesson so it never recurs — trigger phrases
  like "これをガードレール化して", "二度と同じミスをしないようにして",
  "make this a permanent rule", "add this to CLAUDE.md", "覚えておいて（恒久的に）".
  Do not invoke this on your own just because a mistake or correction just
  happened — wait for an explicit request to make it permanent.
---

# self-improve

`~/.claude/CLAUDE.md` is loaded into every Claude Code session on this
machine, in every project, with wording ("IMPORTANT: these instructions
OVERRIDE any default behavior") that makes it one of the highest-leverage
files a user has. That leverage cuts both ways: a well-aimed guardrail
prevents a whole class of future mistakes, but a sloppy or overly-specific
one adds noise that dilutes every other instruction in the file forever.
This skill exists to make additions to it deliberate, not automatic.

## 1. Only on explicit request

Trigger only when the user explicitly asks to make something permanent —
not merely because a mistake, correction, or near-miss just occurred.
Mistakes happen constantly; most don't warrant a standing global rule.

Also skip this skill (don't propose a CLAUDE.md addition) when the lesson
is:
- **Project-specific** — tied to this repo's structure, tooling, or a
  file/function that won't exist elsewhere. That belongs in the project's
  own `CLAUDE.md`, not the global one.
- **A one-off bug** — a specific broken line, not a repeatable pattern. Fix
  the code; there's no standing rule to extract.
- **Already covered** — see step 3 before writing anything.

If the user's request is ambiguous about scope (this project vs. every
project), ask before writing to the global file.

## 2. Find the general lesson, not the symptom

Write down, in your own words, before touching any file:
- **What happened** — the concrete failure (1 sentence).
- **Why it happened** — the root cause, not the symptom. "Ran `git clean -fd`
  in the wrong worktree" is a symptom; "no check for which worktree a shell
  command is running in before a destructive git operation" is closer to a
  root cause.
- **The general rule** — the smallest instruction that would have prevented
  it, phrased so it applies to future unrelated tasks, not just a re-run of
  this one.

If you can't state the general rule in one or two sentences without
reference to this specific task's file names or job IDs, it's probably not
generalizable enough for the global file — reconsider step 1.

## 3. Read `~/.claude/CLAUDE.md` before writing anything

```bash
cat ~/.claude/CLAUDE.md 2>/dev/null || echo "(does not exist yet)"
```

- If a similar rule already exists, don't add a duplicate — propose tightening
  or clarifying the existing one instead (say why the current wording didn't
  prevent this).
- If an existing rule is now contradicted or superseded by the new one, say so
  explicitly and propose removing/updating it rather than leaving both.
- Otherwise, identify (or propose) the right section heading to append under
  — keep related guardrails grouped instead of one flat list.

## 4. Write the guardrail

Keep each entry short: an imperative instruction, optionally one clause of
*why* if the reasoning isn't obvious from the instruction alone. Avoid code
blocks, multi-paragraph explanations, or task-specific detail (file paths,
job IDs, dates) — those belong in a commit message or docs, not here.

```markdown
- Never run `git clean -f`/`git reset --hard` in a worktree without first
  confirming which worktree the shell's cwd actually is — a spawned agent
  once destroyed untracked files in the main worktree this way.
```

## 5. Confirm before writing — never skip this

Show the user the exact diff you intend to write (new section + heading if
the file doesn't exist yet, or the specific lines if appending/editing) and
get an explicit go-ahead. Do not write to `~/.claude/CLAUDE.md` on an
assumed yes, and do not fold this confirmation into a larger unrelated
approval. If the user pushes back on the wording or scope, revise and show
the diff again — don't write a partial version now and "fix it later."

## 6. This skill vs. auto-memory `feedback`

Claude Code also keeps a project-scoped auto-memory system
(`~/.claude/projects/<project>/memory/`) with a `feedback` type for lessons
about how to collaborate with this particular user on this particular
project — those are saved automatically as they come up, carry a `Why:` and
`How to apply:`, and don't need this skill.

Use this skill instead when the rule should hold everywhere, for everyone
sitting down with Claude Code on this machine, not just in the current
project's memory — and only when the user asked for that explicitly (step 1).
If unsure which one fits, default to auto-memory (lower leverage, easier to
revise) and only escalate to CLAUDE.md if the user asks for it to be
permanent and global.

## Safety — non-negotiable

- Never write to `~/.claude/CLAUDE.md` without showing the exact addition and
  getting explicit confirmation first (step 5).
- Never delete or rewrite unrelated content in the file while adding a
  guardrail — touch only the section you're adding to or amending.
- If you're not confident the lesson generalizes past this one task, say so
  and ask, rather than writing a guardrail that will misfire on unrelated
  future work.
