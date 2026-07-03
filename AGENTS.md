# agvsr

## lint, format

use `bunx oxlint`, `bunx oxfmt`.

## test

use `bun test`.

## workspace & file safety

The hazard is any destructive command in the user's working tree — not only "cleanup".
These rules apply in every context.

- **Default-deny on destruction.** Never delete, overwrite, or revert a file you did not
  create in this session without explicit user confirmation naming the exact paths. This
  covers *all* files, not a fixed allowlist: untracked docs, `team.yaml`, `.env*`, local
  config, scratch data, and generated artifacts are all included.
- **Never run destructive working-tree commands** — `rm` / `rm -rf`, `git clean -f` / `-fd`
  / `-fdx`, `git reset --hard`, `git checkout -- <path>`, or a `git stash` that discards
  work — unless the user explicitly approves the exact path list first.
- **Dry-run before any deletion of untracked files:** show `git status --short` and
  `git clean -nd`, then wait for approval of the exact paths.
- These rules are a backstop. The real guarantee is **isolation**: do your work inside your
  job's own worktree, never in the user's main checkout.

## task completion

When completing a task, be sure to run `git commit` before marking it as complete.

