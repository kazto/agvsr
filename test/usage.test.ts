import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import { formatCost, formatJobUsage, formatTokens, formatUsageReport } from "../src/cli/agvsr.ts";
import type { TurnDispatch } from "../src/daemon/daemon.ts";
import type { TurnUsage } from "../src/adapters/types.ts";
import type { Job, JobUsage, UsageBreakdown, UsageByJob, UsageTotals } from "../src/protocol.ts";

const TEAM_YAML = `
roles:
  supervisor: { adapter: claude-code, model: claude-opus-4-8 }
  implementation: { adapter: codex, model: gpt-5-codex }
`;

function usage(over: Partial<TurnUsage> = {}): TurnUsage {
  return {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 30,
    cache_write_tokens: 40,
    reasoning_tokens: 0,
    cost_usd: 1.25,
    ...over,
  };
}

/** Daemon whose every turn reports the given usage (or none when null). */
async function makeDaemon(turnUsage: TurnUsage | null) {
  const base = join(tmpdir(), `agvsr-usage-${randomUUID()}`);
  const sock = `${base}.sock`;
  const db = `${base}.sqlite`;
  const repo = `${base}-repo`;
  mkdirSync(repo, { recursive: true });
  const seen: TurnDispatch[] = [];
  const { startDaemon } = await import("../src/daemon/daemon.ts");
  const daemon = await startDaemon({
    endpoint: sock,
    storeFile: db,
    team: parseTeam(TEAM_YAML),
    interruptRunningJobsOnStart: false,
    turnRunner: async (d: TurnDispatch) => {
      seen.push(d);
      return {
        events: [],
        outcome: {
          sessionId: `${d.role}-s`,
          finalText: "",
          exitCode: 0,
          ...(turnUsage ? { usage: turnUsage } : {}),
        },
      };
    },
  });
  return { daemon, sock, db, repo, seen };
}

function cleanup(...paths: string[]) {
  for (const p of paths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}

describe("daemon turn usage recording (D32)", () => {
  it("records each turn's usage and exposes it on job.get", async () => {
    const { daemon, sock, db, repo, seen } = await makeDaemon(usage());
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "measure me", cwd: repo });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

    const got = await c.request<{ job: Job; usage: JobUsage }>("job.get", { id: jobId });
    expect(got.ok).toBe(true);
    const jobUsage = got.ok ? got.result.usage : null;
    expect(jobUsage?.totals.turns).toBe(seen.length);
    expect(jobUsage?.totals.cost_usd).toBeCloseTo(1.25 * seen.length, 6);
    // The role/adapter/model come from the team config, not the adapter's own report.
    expect(jobUsage?.by_role[0]).toMatchObject({
      role: "supervisor",
      adapter: "claude-code",
      model: "claude-opus-4-8",
    });

    c.close();
    await daemon.close();
    cleanup(sock, db, `${db}-wal`, `${db}-shm`, repo);
  });

  it("records nothing when the adapter reports no usage (agy-style turns)", async () => {
    const { daemon, sock, db, repo, seen } = await makeDaemon(null);
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "unmeasured", cwd: repo });
    const jobId = created.ok ? created.result.job.id : "";
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

    const got = await c.request<{ usage: JobUsage }>("job.get", { id: jobId });
    expect(got.ok).toBe(true);
    // Zero rows means "unmeasured", which must not be reported as a partial cost.
    expect(got.ok ? got.result.usage.totals.turns : -1).toBe(0);
    expect(got.ok ? got.result.usage.totals.cost_partial : true).toBe(false);

    c.close();
    await daemon.close();
    cleanup(sock, db, `${db}-wal`, `${db}-shm`, repo);
  });

  it("serves a cross-job usage.report and rejects an unknown job id", async () => {
    const { daemon, sock, db, repo, seen } = await makeDaemon(usage());
    const c = await Client.connect(sock);
    const a = await c.request<{ job: Job }>("job.create", { goal: "job A", cwd: repo });
    const jobA = a.ok ? a.result.job.id : "";
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

    const report = await c.request<{
      totals: UsageTotals;
      by_role: UsageBreakdown[];
      by_job: UsageByJob[];
    }>("usage.report");
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.result.totals.turns).toBeGreaterThan(0);
      expect(report.result.by_job.map((j) => j.job_id)).toContain(jobA);
      expect(report.result.by_job[0]?.goal).toBe("job A");
    }

    const scoped = await c.request<{ totals: UsageTotals }>("usage.report", { job_id: jobA });
    expect(scoped.ok).toBe(true);

    const missing = await c.request("usage.report", { job_id: "no-such-job" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("not_found");

    c.close();
    await daemon.close();
    cleanup(sock, db, `${db}-wal`, `${db}-shm`, repo);
  });
});

describe("usage formatting", () => {
  const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
    turns: 3,
    input_tokens: 1234,
    output_tokens: 56,
    cache_read_tokens: 2_500_000,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 4.2,
    cost_partial: false,
    ...over,
  });

  it("abbreviates token counts by magnitude", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(2_500_000)).toBe("2.50M");
  });

  it("marks a partial cost with a trailing + so it never reads as a final figure", () => {
    expect(formatCost(totals())).toBe("$4.20");
    expect(formatCost(totals({ cost_partial: true }))).toBe("$4.20+");
  });

  it("renders the per-job status block with a role breakdown", () => {
    const lines = formatJobUsage({
      totals: totals(),
      by_role: [
        {
          ...totals({ turns: 2, cost_usd: 4.0 }),
          role: "supervisor",
          adapter: "claude-code",
          model: "claude-opus-4-8",
        },
      ],
    });
    expect(lines[0]).toContain("3 turns");
    expect(lines[0]).toContain("$4.20");
    expect(lines[0]).toContain("cache_r 2.50M");
    expect(lines[1]).toContain("supervisor");
    expect(lines[1]).toContain("claude-opus-4-8");
  });

  it("says so plainly when a job has no recorded turns", () => {
    const lines = formatJobUsage({
      totals: totals({ turns: 0, cost_usd: 0 }),
      by_role: [],
    });
    expect(lines).toEqual(["usage: (none recorded)"]);
  });

  it("explains the + marker in the full report and drops the job table when scoped", () => {
    const report = {
      totals: totals({ cost_partial: true }),
      by_role: [
        { ...totals(), role: "supervisor", adapter: "claude-code", model: "claude-opus-4-8" },
      ],
      by_job: [
        { ...totals(), job_id: "j1", goal: "goal one\nsecond line", status: "done" as const },
      ],
    };
    const all = formatUsageReport(report).join("\n");
    expect(all).toContain("TOTAL");
    expect(all).toContain("lower bound");
    expect(all).toContain("by job:");
    // Multi-line goals must not break the table layout.
    expect(all).toContain("goal one");
    expect(all).not.toContain("second line");

    const scoped = formatUsageReport(report, "j1").join("\n");
    expect(scoped).toContain("job j1");
    expect(scoped).not.toContain("by job:");
  });
});
