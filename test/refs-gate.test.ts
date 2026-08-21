/**
 * The handoff artifact gate (D46 mechanism A).
 * Real git worktrees: the guarantee is exactly "what git considers committed".
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import { uncommittedRefs } from "../src/git/refs-gate.ts";
import type { Daemon } from "../src/daemon/daemon.ts";
import type { Job, Message } from "../src/protocol.ts";

function git(cwd: string, args: string[]): void {
  spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
  design: { adapter: claude-code, model: m }
  qa: { adapter: agy, model: m }
`);

const trash: string[] = [];
let openDaemon: Daemon | null = null;
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(async () => {
  if (openDaemon) {
    await openDaemon.close();
    openDaemon = null;
  }
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const p of trash.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

/** A repo with one commit, a running daemon, and a created job. */
async function setup() {
  const base = join(tmpdir(), `agvsr-refs-${randomUUID()}`);
  trash.push(base);
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });

  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);

  setEnv("AGVSR_WORKTREES", join(base, "worktrees"));
  setEnv("AGVSR_SEED_PATHS", "off");

  const { startDaemon } = await import("../src/daemon/daemon.ts");
  const sock = join(base, "d.sock");
  openDaemon = await startDaemon({
    endpoint: sock,
    storeFile: join(base, "d.sqlite"),
    team: TEAM,
    interruptRunningJobsOnStart: false,
    turnRunner: async (d) => ({
      events: [{ kind: "result", ok: true, text: d.role }],
      outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
    }),
  });

  const c = await Client.connect(sock);
  const created = await c.request<{ job: Job }>("job.create", { goal: "g", cwd: repo });
  if (!created.ok) throw new Error("job.create failed");
  return { c, job: created.result.job, worktree: created.result.job.worktree! };
}

describe("uncommittedRefs", () => {
  it("reports an untracked file", async () => {
    const { worktree, c } = await setup();
    writeFileSync(join(worktree, "design.md"), "D-1: keep the design stable\n");
    const problems = uncommittedRefs(worktree, ["design.md"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toBe("untracked");
    c.close();
  });

  it("reports a tracked file with uncommitted edits", async () => {
    const { worktree, c } = await setup();
    writeFileSync(join(worktree, "README.md"), "changed\n");
    const problems = uncommittedRefs(worktree, ["README.md"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toBe("uncommitted");
    c.close();
  });

  it("accepts a committed file", async () => {
    const { worktree, c } = await setup();
    writeFileSync(join(worktree, "design.md"), "# design\n");
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", "design"]);
    expect(uncommittedRefs(worktree, ["design.md"])).toEqual([]);
    c.close();
  });

  it("reports a path that holds nothing at all", async () => {
    const { worktree, c } = await setup();
    const problems = uncommittedRefs(worktree, ["docs/nope.md"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toBe("untracked");
    c.close();
  });

  it("accepts an absolute path inside the worktree", async () => {
    const { worktree, c } = await setup();
    writeFileSync(join(worktree, "design.md"), "# design\n");
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", "design"]);
    expect(uncommittedRefs(worktree, [join(worktree, "design.md")])).toEqual([]);
    c.close();
  });

  it("does not judge a path outside the worktree", async () => {
    const { worktree, c } = await setup();
    expect(uncommittedRefs(worktree, ["/etc/hostname"])).toEqual([]);
    c.close();
  });

  it("catches an uncommitted file under a referenced directory", async () => {
    const { worktree, c } = await setup();
    mkdirSync(join(worktree, "docs"), { recursive: true });
    writeFileSync(join(worktree, "docs", "design.md"), "# design\n");
    const problems = uncommittedRefs(worktree, ["docs"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toBe("untracked");
    c.close();
  });
});

describe("handoff artifact gate (D46)", () => {
  it("refuses a worker handoff citing an uncommitted artifact", async () => {
    const { c, job, worktree } = await setup();
    writeFileSync(join(worktree, "design.md"), "# design\n");

    const sent = await c.request("msg.send", {
      from: "design",
      job_id: job.id,
      to: "supervisor",
      body: "design ready",
      refs: ["design.md"],
    });

    expect(sent.ok).toBe(false);
    if (!sent.ok) {
      expect(sent.error.code).toBe("refs_uncommitted");
      expect(sent.error.message).toContain("design.md");
      // The message must carry the fix, not just the complaint.
      expect(sent.error.message).toContain("Commit them on");
    }
    c.close();
  });

  it("records no message when it refuses", async () => {
    const { c, job, worktree } = await setup();
    writeFileSync(join(worktree, "design.md"), "# design\n");
    await c.request("msg.send", {
      from: "design",
      job_id: job.id,
      to: "supervisor",
      body: "design ready",
      refs: ["design.md"],
    });

    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: job.id });
    const fromDesign = (logs.ok ? logs.result.messages : []).filter(
      (m) => m.from_role === "design",
    );
    expect(fromDesign).toHaveLength(0);
    c.close();
  });

  it("accepts the same handoff once the artifact is committed", async () => {
    const { c, job, worktree } = await setup();
    writeFileSync(join(worktree, "design.md"), "D-1: keep the design stable\n");
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", "design"]);

    const sent = await c.request("msg.send", {
      from: "design",
      job_id: job.id,
      to: "supervisor",
      body: "design ready",
      refs: ["design.md"],
    });
    expect(sent.ok).toBe(true);
    c.close();
  });

  it("requires a design handoff to cite its artifacts", async () => {
    const { c, job } = await setup();
    const sent = await c.request("msg.send", {
      from: "design",
      job_id: job.id,
      to: "supervisor",
      body: "the design is done, trust me",
    });
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.error.code).toBe("design_refs_required");
    c.close();
  });

  it("leaves a supervisor delegation alone", async () => {
    const { c, job, worktree } = await setup();
    writeFileSync(join(worktree, "notes.md"), "scratch\n");
    // The supervisor routes work; it is not the role that produced the artifact.
    const sent = await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "please design this",
      refs: ["notes.md"],
    });
    expect(sent.ok).toBe(true);
    c.close();
  });

  it("stands down when AGVSR_REFS_GATE is disabled", async () => {
    setEnv("AGVSR_REFS_GATE", "0");
    setEnv("AGVSR_DECISION_LEDGER", "0");
    const { c, job, worktree } = await setup();
    writeFileSync(join(worktree, "design.md"), "# design\n");
    const sent = await c.request("msg.send", {
      from: "design",
      job_id: job.id,
      to: "supervisor",
      body: "design ready",
      refs: ["design.md"],
    });
    expect(sent.ok).toBe(true);
    c.close();
  });
});

describe("approved decision ledger (D45)", () => {
  it("requires stable decision ids in a committed design", async () => {
    const { c, job, worktree } = await setup();
    writeFileSync(join(worktree, "design.md"), "# Design without decision ids\n");
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", "design"]);

    const sent = await c.request("msg.send", {
      from: "design",
      job_id: job.id,
      to: "supervisor",
      body: "design ready",
      refs: ["design.md"],
    });
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.error.code).toBe("design_decisions_unparseable");
    c.close();
  });

  it("rejects out-of-scope drift and appends the frozen decisions to rework", async () => {
    const { c, job, worktree } = await setup();
    writeFileSync(worktree + "/design.md", "D-1: TTL is 24h\n\nD-2: token format is unchanged\n");
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", "design v1"]);
    const first = await c.request("msg.send", {
      from: "design",
      job_id: job.id,
      to: "supervisor",
      body: "design ready",
      refs: ["design.md"],
    });
    expect(first.ok).toBe(true);
    const approved = await c.request("job.tell", { job_id: job.id, body: "approved" });
    expect(approved.ok).toBe(true);

    const rework = await c.request<{ message: Message }>("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "Revise D-1 only.",
    });
    expect(rework.ok).toBe(true);
    if (rework.ok) {
      expect(rework.result.message.body).toContain("D-2");
      expect(rework.result.message.body).toContain("変更禁止");
    }

    writeFileSync(worktree + "/design.md", "D-1: TTL is 1h\n\nD-2: add familyId to tokens\n");
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", "bad revision"]);
    const drifted = await c.request("msg.send", {
      from: "design",
      job_id: job.id,
      to: "supervisor",
      body: "revised design",
      refs: ["design.md"],
    });
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) {
      expect(drifted.error.code).toBe("approved_decision_reverted");
      expect(drifted.error.message).toContain("D-2");
    }

    writeFileSync(worktree + "/design.md", "D-1: TTL is 1h\n\nD-2: token format is unchanged\n");
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", "scoped revision"]);
    const scoped = await c.request("msg.send", {
      from: "design",
      job_id: job.id,
      to: "supervisor",
      body: "revised design",
      refs: ["design.md"],
    });
    expect(scoped.ok).toBe(true);
    c.close();
  });

  it("requires a rejection to name its rework scope", async () => {
    const { c, job, worktree } = await setup();
    writeFileSync(worktree + "/design.md", "D-1: TTL is 24h\n");
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", "design"]);
    await c.request("msg.send", {
      from: "design",
      job_id: job.id,
      to: "supervisor",
      body: "design ready",
      refs: ["design.md"],
    });
    await c.request("job.tell", { job_id: job.id, body: "approved" });

    const rejected = await c.request("job.tell", {
      job_id: job.id,
      body: "Reject this and rewrite the design.",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("rework_scope_required");
    c.close();
  });
});
