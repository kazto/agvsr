# agvsr

## lint, format

use `oxlint`, `oxfmt`.

## test

use `bun test`.

## cleanup safety

- Do not delete files from the main worktree during cleanup.
- Never delete `team.yaml`, `.env*`, local config files, or untracked docs without explicit user confirmation in chat for the exact path list.
- Before deleting untracked files, show `git status --short` and `git clean -nd`.
- Do not run `rm`, `git clean -f`, or equivalent destructive cleanup commands unless the user explicitly approves the exact path list.
