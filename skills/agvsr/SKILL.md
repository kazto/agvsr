---
name: agvsr
description: >
  Operate the agvsr multi-agent job daemon: submit jobs, handle the design-approval
  gate, monitor long-running jobs without polling in the foreground, recover work
  from crashed/timed-out workers, verify results independently before trusting them,
  and merge/clean up job worktrees safely. Use whenever the user asks to submit an
  agvsr job, check on running agvsr jobs, approve a design, or clean up agvsr
  worktrees/branches. Trigger for phrases like "agvsrにジョブ投入して",
  "承認して", "進捗確認", "worktree掃除", "マージして".
---

# agvsr

`agvsr` is a daemon that runs job branches through supervisor → design → QA →
implementation agent roles in isolated git worktrees under
`~/.config/agvsr/worktrees/<job-id>`. It is a **structural**, not advisory,
system: several safety nets (design-approval gate, commit gate, dirty-worktree
recovery reporting) are enforced by the daemon, not just by charter prose. Rely
on them, but still verify — see "Don't trust self-reports" below.

## Command reference

```
agvsr job "<goal>" [--cwd D] [--id ID]   Submit a job (D = target repo, default cwd)
agvsr status [job-id]                    List jobs, or show one with runtime state
agvsr logs <job-id> [-f]                 Audit messages for a job
agvsr watch [--all] [--poll N]           Live role-message stream across jobs
agvsr tell <job-id> "<message>"          Send a message to the job's supervisor
agvsr stop <job-id>                      Stop gracefully (marks failed)
agvsr kill <job-id>                      Kill immediately (marks interrupted)
agvsr ping / team / doctor               Daemon health / configured roles / adapter checks
```

## 1. Writing the job prompt — always include a constraint block

Under-specified prompts push agent teams toward maximal, over-engineered
solutions (e.g. an unasked-for docker/chroot sandbox). Every `agvsr job` prompt
should state the positive goal **and** an explicit non-goal/constraint block:

- No new runtime dependencies (docker/containers/chroot/new daemons/network
  services) without explicit human approval; prefer the smallest mechanism and
  reuse existing assets.
- Do not remap HOME/auth; agents keep using the host's real credentials.
- A test that mocks away the core dependency the change is about does not count
  as validation. Prefer a minimal real end-to-end smoke for
  execution/spawn/auth/IPC paths, and declare what is not covered.
- Never run destructive commands (`rm`, `git clean -f`, `git reset --hard`) in
  the **main** worktree; follow `AGENTS.md` / `charters/scaffold.md` §6.
- Commit the work on the job branch before reporting completion — uncommitted
  work is lost (the daemon's commit-gate enforces this, but say it anyway).
- State the required verification commands (this repo: `bun test`,
  `bun run typecheck`, `bunx oxlint src test`, `oxfmt`) and ask for results.

If the task is non-trivial (touches daemon/adapter/auth/spawn, or many files),
expect the design-approval gate to fire (see below) — say so isn't required,
it's automatic.

## 2. The design-approval gate — jobs park, they are not stuck

For non-trivial jobs, after design + QA planning the supervisor must get human
approval before delegating to implementation. The daemon enforces this
structurally: it blocks the supervisor→implementation handoff and escalates a
design summary to `user`.

**Symptom**: `agvsr status <job>` shows `running — no in-flight turn, idle
Nm (possibly stalled)`. This looks like a hang but usually isn't.

**How to tell approval-wait from a real stall**: check the last message.

```bash
agvsr logs <job-id> 2>&1 | tail -40
```

- Last message is `supervisor -> user` with a design summary / "Please
  approve..." → it's waiting on you. Read the summary, check it matches the
  approved scope and constraint block, then unblock:
  ```bash
  agvsr tell <job-id> "approved。<any extra constraints to restate>"
  ```
  (or reply with requested changes instead of "approved" to send it back to
  design).
- Last message is a mid-turn worker note with recent progress timestamps and
  no request → treat as a genuine stall and investigate.

A **second**, similar gate exists after two implementation-turn crashes without
a handoff: the supervisor pauses and asks the human to pick retry / diagnostic
retry / fail — same pattern, reply via `agvsr tell`.

## 3. Monitoring without blocking the foreground

Don't `sleep`-poll in the foreground for a job that can run tens of minutes.
Launch a polling loop with the Bash tool's `run_in_background: true`, matching
on the job's status line and last message, e.g.:

```bash
for i in $(seq 1 60); do
  st=$(agvsr status "$JOB_ID" 2>/dev/null)
  line=$(echo "$st" | grep -m1 "^$JOB_ID")
  last=$(echo "$st" | grep -m1 "^last_message:")
  if echo "$last" | grep -qiE "supervisor -> user"; then echo "APPROVAL_REQUEST"; break; fi
  if echo "$line" | grep -qiE "  (done|failed|interrupted)\b"; then echo "TERMINAL"; break; fi
  sleep 45
done
```

When the background task notifies completion, read its output file and act
(approve, or move to recovery/verification). If a monitor loop stops without a
completion record (e.g. a session boundary), the daemon job itself is usually
still running fine — re-check `agvsr status` directly and just restart the
loop; don't assume the job died.

## 4. Don't trust self-reports — verify independently

Agents reliably over-report success: "bun test 220/220 passed" can be true in
isolation and still hide a flaky suite, or can simply be wrong. Before treating
a job's completion report as fact:

1. `cd` into the job's worktree (`~/.config/agvsr/worktrees/<job-id>`) — not
   the description, the actual directory.
2. Re-run the verification commands yourself, more than once if IO/subprocess
   heavy (`bun test` two or three times) — flakiness often only shows up
   piped/under load and not in a single clean run.
3. Run `bun run typecheck` / `bunx oxlint src test` yourself.
4. If a test spawns a real subprocess (e.g. a live watch/server smoke test),
   check it isn't destabilizing the rest of the suite by running the *full*
   suite repeatedly, not just the new test file alone.

If you find flakiness or a regression the job's own report didn't catch, fix
it before merging (usually a small, targeted change — e.g. raise a test
timeout, or extract the logic under test into a pure function you can
unit-test in-process instead of spawning a real CLI).

## 5. Recovering from a crashed/timed-out worker

Implementation turns can crash (exit 1) or hit the turn timeout right before
committing. The job then shows `failed`, but the work is very often sitting
**uncommitted** in the job worktree. Since the "fix test worktree isolation" +
"dirty-worktree recovery reporting" changes landed on main, a failed job's
escalation message may already say so explicitly (worktree path, changed file
count, branch). Regardless, check yourself:

```bash
WT=/home/kazto/.config/agvsr/worktrees/<job-id>
git -C "$WT" status -s          # uncommitted work?
git -C "$WT" log --oneline main..HEAD   # anything already committed on the branch?
```

If real work is there: verify it (section 4), fix any gaps yourself if small,
commit it on the job branch, then merge. If the partial work is broken/
regresses existing tests and finishing it is nontrivial, don't patch a half-
finished diff onto main — discard it and resubmit a fresh job with the lesson
folded into the prompt (what broke, what to avoid). Don't burn effort trying to
rescue a genuinely broken partial implementation.

## 6. Merging a job's work

```bash
cd /home/kazto/.config/agvsr/worktrees/<job-id>
git add -A && git commit -m "..."         # only if there's uncommitted work to recover
cd /home/kazto/src/agvsr
git merge --no-ff agvsr/<job-id> -m "Merge agvsr/<job-id>: <summary>"
bun run typecheck && bun test && bun test   # re-verify on main, twice
bunx oxlint src test
```

If multiple jobs touch the same files (most often `src/cli/agvsr.ts` or
`src/web/*`), merge and verify them **one at a time**, sequentially — don't run
them fully in parallel expecting a clean auto-merge, and re-run the full suite
after each merge before starting the next.

Never `git push` unless the user explicitly asks for it in that turn, even if
they approved a push earlier in the session — confirm each time.

## 7. Cleaning up worktrees and branches

Job worktrees/branches accumulate fast (the daemon creates one per job, and
some test suites can leak extras into the real `~/.config/agvsr/worktrees` if
they don't override the worktree root — this has been a real, fixed bug, not
just a theoretical risk). Periodic cleanup is safe as long as you don't touch
`main`:

```bash
# Never operate on the /home/kazto/src/agvsr entry itself.
git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r path; do
  [ "$path" = "/home/kazto/src/agvsr" ] && continue
  br=$(git -C "$path" symbolic-ref --short HEAD 2>/dev/null)
  git worktree remove --force "$path" && [ -n "$br" ] && git branch -D "$br"
done
git worktree prune
```

Before mass-removing, cross-check `agvsr status` for any job still `running`
— never remove a running job's worktree. For jobs whose work you intend to
keep but haven't merged yet, leave those specific worktrees/branches alone.

## Safety — non-negotiable

- Spawned agents run arbitrary shell commands at your privilege. They operate
  inside their own job worktree, but a prompt or charter gap can let one `cd`
  into and damage the **main** worktree (this has happened before — untracked
  design docs were lost to a stray `git clean -fd`). Never approve a design
  that has the agent operating outside its own worktree.
- Before any command that could discard uncommitted work in the main
  worktree (`git checkout`, `git reset`, `git clean`), run `git status` first
  and stop if there's anything unexpected.
- If in doubt about whether cleanup, merge, or push is in scope for what the
  user asked, ask — especially for `git push`, which is never assumed.
