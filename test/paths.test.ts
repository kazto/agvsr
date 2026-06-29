import { afterEach, describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { worktreesDir } from "../src/paths.ts";

describe("paths", () => {
  const oldWorktrees = process.env.AGVSR_WORKTREES;

  afterEach(() => {
    if (oldWorktrees === undefined) delete process.env.AGVSR_WORKTREES;
    else process.env.AGVSR_WORKTREES = oldWorktrees;
  });

  it("uses AGVSR_WORKTREES when set", () => {
    process.env.AGVSR_WORKTREES = "/tmp/agvsr-test-worktrees";
    expect(worktreesDir()).toBe("/tmp/agvsr-test-worktrees");
  });

  it("falls back to configDir()/worktrees when unset", () => {
    delete process.env.AGVSR_WORKTREES;
    const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    expect(worktreesDir()).toBe(join(base, "agvsr", "worktrees"));
  });
});
