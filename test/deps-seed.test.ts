/**
 * Dependency seeding into job worktrees (D41).
 * Real git repos and a real (temporary) worktrees dir — no mocking.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { provisionWorktree } from "../src/git/worktree.ts";
import { seedPaths } from "../src/git/deps.ts";

function git(cwd: string, args: string[]): boolean {
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;
}

const created: string[] = [];

function makeRepo(): string {
  const base = join(tmpdir(), `agvsr-seed-${randomUUID()}`);
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  created.push(base);

  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@test.test"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "package.json"), '{"name":"fixture"}\n');
  writeFileSync(join(repo, "bun.lock"), "lock-v1\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);

  // An ignored dependency directory, with a symlinked bin like a real one.
  mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  return repo;
}

/**
 * Point AGVSR_WORKTREES at a scratch dir for the duration of `fn`. Must await `fn`
 * before restoring: a non-awaiting version restores the variable at the callee's
 * first suspension point, and the rest of the test then writes into the user's real
 * ~/.config/agvsr/worktrees.
 */
async function withWorktreesDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(tmpdir(), `agvsr-seed-wt-${randomUUID()}`);
  created.push(dir);
  const prev = process.env.AGVSR_WORKTREES;
  process.env.AGVSR_WORKTREES = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.AGVSR_WORKTREES;
    else process.env.AGVSR_WORKTREES = prev;
  }
}

afterEach(() => {
  for (const p of created.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

describe("seedPaths", () => {
  it("defaults to node_modules and can be disabled or overridden", () => {
    const prev = process.env.AGVSR_SEED_PATHS;
    try {
      delete process.env.AGVSR_SEED_PATHS;
      expect(seedPaths()).toEqual(["node_modules"]);
      process.env.AGVSR_SEED_PATHS = "off";
      expect(seedPaths()).toEqual([]);
      process.env.AGVSR_SEED_PATHS = "";
      expect(seedPaths()).toEqual([]);
      process.env.AGVSR_SEED_PATHS = "node_modules, vendor";
      expect(seedPaths()).toEqual(["node_modules", "vendor"]);
    } finally {
      if (prev === undefined) delete process.env.AGVSR_SEED_PATHS;
      else process.env.AGVSR_SEED_PATHS = prev;
    }
  });
});

describe("provisionWorktree — dependency seeding", () => {
  it("seeds an ignored node_modules into the new worktree", async () => {
    const repo = makeRepo();
    await withWorktreesDir(async () => {
      const wt = await provisionWorktree(repo, `job-${randomUUID().slice(0, 8)}`, "agvsr/seed-1");
      expect(wt).not.toBeNull();
      expect(existsSync(join(wt!, "node_modules", "left-pad", "index.js"))).toBe(true);
      expect(readFileSync(join(wt!, "node_modules", "left-pad", "index.js"), "utf8")).toContain(
        "module.exports",
      );
    });
  });

  it("stages through an agvsr-owned cache, never linking the user's checkout", async () => {
    const repo = makeRepo();
    await withWorktreesDir(async (dir) => {
      const wt = await provisionWorktree(repo, `job-${randomUUID().slice(0, 8)}`, "agvsr/seed-2");
      // The cache exists under the worktrees dir...
      expect(existsSync(join(dir, ".deps"))).toBe(true);
      // ...and the file in the repo is not hard-linked to the worktree's copy, so an
      // agent corrupting the worktree cannot reach back into the human's checkout.
      const repoIno = statSync(join(repo, "node_modules", "left-pad", "index.js")).ino;
      const wtIno = statSync(join(wt!, "node_modules", "left-pad", "index.js")).ino;
      expect(wtIno).not.toBe(repoIno);
    });
  });

  it("shares one cached copy across worktrees instead of copying per job", async () => {
    const repo = makeRepo();
    await withWorktreesDir(async () => {
      const a = await provisionWorktree(repo, `job-a-${randomUUID().slice(0, 8)}`, "agvsr/seed-a");
      const b = await provisionWorktree(repo, `job-b-${randomUUID().slice(0, 8)}`, "agvsr/seed-b");
      const inoA = statSync(join(a!, "node_modules", "left-pad", "index.js")).ino;
      const inoB = statSync(join(b!, "node_modules", "left-pad", "index.js")).ino;
      // Both link the same cached inode (hard-link path; skipped where unsupported).
      if (process.platform !== "win32") expect(inoA).toBe(inoB);
      expect(existsSync(join(b!, "node_modules", "left-pad", "index.js"))).toBe(true);
    });
  });

  it("restages the cache when the lockfile changes", async () => {
    const repo = makeRepo();
    await withWorktreesDir(async () => {
      await provisionWorktree(repo, `job-1-${randomUUID().slice(0, 8)}`, "agvsr/seed-l1");

      // New dependency set: lockfile moves and node_modules gains a package.
      writeFileSync(join(repo, "bun.lock"), "lock-v2\n");
      mkdirSync(join(repo, "node_modules", "right-pad"), { recursive: true });
      writeFileSync(join(repo, "node_modules", "right-pad", "index.js"), "module.exports = 2;\n");

      const wt = await provisionWorktree(
        repo,
        `job-2-${randomUUID().slice(0, 8)}`,
        "agvsr/seed-l2",
      );
      expect(existsSync(join(wt!, "node_modules", "right-pad", "index.js"))).toBe(true);
    });
  });

  it("does nothing when seeding is turned off", async () => {
    const repo = makeRepo();
    const prev = process.env.AGVSR_SEED_PATHS;
    process.env.AGVSR_SEED_PATHS = "off";
    try {
      await withWorktreesDir(async () => {
        const wt = await provisionWorktree(repo, `job-${randomUUID().slice(0, 8)}`, "agvsr/seed-3");
        expect(existsSync(join(wt!, "node_modules"))).toBe(false);
      });
    } finally {
      if (prev === undefined) delete process.env.AGVSR_SEED_PATHS;
      else process.env.AGVSR_SEED_PATHS = prev;
    }
  });

  it("declines to seed a path the repo does not ignore", async () => {
    const repo = makeRepo();
    // node_modules is tracked here, so the checkout already provides it and the
    // worktree must get the committed content — not a staged cache copy.
    writeFileSync(join(repo, ".gitignore"), "nothing-here\n");
    writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "committed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "track deps"]);

    await withWorktreesDir(async (dir) => {
      const wt = await provisionWorktree(repo, `job-${randomUUID().slice(0, 8)}`, "agvsr/seed-4");
      expect(readFileSync(join(wt!, "node_modules", "left-pad", "index.js"), "utf8")).toBe(
        "committed\n",
      );
      // No cache was staged: seeding declined the path outright.
      expect(existsSync(join(dir, ".deps"))).toBe(false);
    });
  });
});
