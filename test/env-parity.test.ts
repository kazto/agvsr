import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseTeam } from "../src/config/team.ts";
import {
  copyDeclaredEnvFiles,
  envFileVariables,
  envParityEnabled,
  listIgnoredEnvFiles,
  parseEnvFile,
  unresolvedEnvFiles,
} from "../src/git/env-parity.ts";

const repo = join(tmpdir(), `agvsr-env-parity-${randomUUID()}`);

function git(args: string[], cwd = repo): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

beforeAll(() => {
  mkdirSync(repo, { recursive: true });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(repo, ".gitignore"), ".env\n.env.*\nnode_modules/\n*.local.json\n");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  // Ignored env files, the ones a worktree will never receive.
  writeFileSync(join(repo, ".env"), "DATABASE_TEST_URL=postgres://localhost/test\nFLAG=api\n");
  writeFileSync(join(repo, ".env.test"), "MODE=test\n");
  // Ignored, but not an env file — must not be reported.
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "");
  // Tracked and committed — not ignored, so not reported.
  writeFileSync(join(repo, ".env.example"), "DATABASE_TEST_URL=\n");
  git(["add", "-f", ".env.example"]);
  git(["commit", "-qm", "example"]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("listIgnoredEnvFiles", () => {
  it("finds ignored env files and ignores everything else", () => {
    expect(listIgnoredEnvFiles(repo)).toEqual([".env", ".env.test"]);
  });

  it("does not descend into an ignored directory", () => {
    expect(listIgnoredEnvFiles(repo).some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("does not flag editor or agent tooling config", () => {
    // `.claude/settings.local.json` matches the *.local.json shape but configures
    // the agent, not the application — flagging it would cost every user an
    // `ignore:` line that protects nothing.
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.local.json"), "{}\n");
    writeFileSync(
      join(repo, ".gitignore"),
      ".env\n.env.*\nnode_modules/\n*.local.json\n.claude/\n",
    );
    try {
      expect(listIgnoredEnvFiles(repo)).toEqual([".env", ".env.test"]);
    } finally {
      rmSync(join(repo, ".claude"), { recursive: true, force: true });
    }
  });

  it("still flags application config at the repo root", () => {
    writeFileSync(join(repo, "config.local.json"), "{}\n");
    try {
      expect(listIgnoredEnvFiles(repo)).toContain("config.local.json");
    } finally {
      rmSync(join(repo, "config.local.json"), { force: true });
    }
  });

  it("returns nothing for a non-git directory", () => {
    const plain = join(tmpdir(), `agvsr-env-plain-${randomUUID()}`);
    mkdirSync(plain, { recursive: true });
    try {
      expect(listIgnoredEnvFiles(plain)).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("unresolvedEnvFiles", () => {
  const team = (yaml: string) =>
    parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
${yaml}
`);

  it("reports every undeclared env file when the config says nothing", () => {
    expect(unresolvedEnvFiles(repo, team(""))).toEqual([".env", ".env.test"]);
  });

  it("reports only what is still undeclared", () => {
    const t = team(`
worktree:
  env_files:
    ".env": env
`);
    expect(unresolvedEnvFiles(repo, t)).toEqual([".env.test"]);
  });

  it("accepts ignore as a decision, not as an omission", () => {
    const t = team(`
worktree:
  env_files:
    ".env": env
    ".env.test": ignore
`);
    expect(unresolvedEnvFiles(repo, t)).toEqual([]);
  });

  it("accepts a key list as a decision", () => {
    const t = team(`
worktree:
  env_files:
    ".env": [DATABASE_TEST_URL]
    ".env.test": copy
`);
    expect(unresolvedEnvFiles(repo, t)).toEqual([]);
  });
});

describe("parseEnvFile", () => {
  it("reads plain assignments", () => {
    expect(parseEnvFile("A=1\nB=two\n")).toEqual({ A: "1", B: "two" });
  });

  it("skips comments and blank lines", () => {
    expect(parseEnvFile("# c\n\nA=1\n")).toEqual({ A: "1" });
  });

  it("strips surrounding quotes and honours export", () => {
    expect(parseEnvFile(`export A="1"\nB='two'\n`)).toEqual({ A: "1", B: "two" });
  });

  it("keeps values containing '='", () => {
    expect(parseEnvFile("URL=postgres://u:p@h/db?x=1\n")).toEqual({
      URL: "postgres://u:p@h/db?x=1",
    });
  });

  it("ignores malformed lines rather than guessing", () => {
    expect(parseEnvFile("not an assignment\nA=1\n")).toEqual({ A: "1" });
  });
});

describe("envFileVariables", () => {
  const team = (yaml: string) =>
    parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
${yaml}
`);

  it("passes the whole file through for env", () => {
    const t = team(`
worktree:
  env_files:
    ".env": env
`);
    expect(envFileVariables(repo, t)).toEqual({
      DATABASE_TEST_URL: "postgres://localhost/test",
      FLAG: "api",
    });
  });

  it("passes only the named keys for a key list", () => {
    const t = team(`
worktree:
  env_files:
    ".env": [DATABASE_TEST_URL]
`);
    expect(envFileVariables(repo, t)).toEqual({
      DATABASE_TEST_URL: "postgres://localhost/test",
    });
  });

  it("contributes nothing for copy or ignore", () => {
    const t = team(`
worktree:
  env_files:
    ".env": ignore
    ".env.test": copy
`);
    expect(envFileVariables(repo, t)).toEqual({});
  });

  it("tolerates a declared file that does not exist", () => {
    const t = team(`
worktree:
  env_files:
    ".env.missing": env
`);
    expect(envFileVariables(repo, t)).toEqual({});
  });
});

describe("copyDeclaredEnvFiles", () => {
  const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
worktree:
  env_files:
    ".env": env
    ".env.test": copy
`);

  it("copies only what is declared copy", () => {
    const dest = join(tmpdir(), `agvsr-env-dest-${randomUUID()}`);
    mkdirSync(dest, { recursive: true });
    try {
      expect(copyDeclaredEnvFiles(repo, dest, team)).toEqual([".env.test"]);
      expect(Bun.file(join(dest, ".env.test")).size).toBeGreaterThan(0);
      expect(Bun.file(join(dest, ".env")).size).toBe(0);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("never shadows a file the worktree already provides", () => {
    const dest = join(tmpdir(), `agvsr-env-dest-${randomUUID()}`);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, ".env.test"), "MODE=already-here\n");
    try {
      expect(copyDeclaredEnvFiles(repo, dest, team)).toEqual([]);
      expect(Bun.file(join(dest, ".env.test")).text()).resolves.toBe("MODE=already-here\n");
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe("envParityEnabled", () => {
  it("defaults to enabled and honours the disable values", () => {
    const original = process.env.AGVSR_ENV_PARITY;
    try {
      delete process.env.AGVSR_ENV_PARITY;
      expect(envParityEnabled()).toBe(true);
      for (const value of ["0", "off", "false", "no", "OFF"]) {
        process.env.AGVSR_ENV_PARITY = value;
        expect(envParityEnabled()).toBe(false);
      }
      process.env.AGVSR_ENV_PARITY = "1";
      expect(envParityEnabled()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.AGVSR_ENV_PARITY;
      else process.env.AGVSR_ENV_PARITY = original;
    }
  });
});
