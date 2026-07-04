import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { VERSION } from "../src/index.ts";

const ROOT = join(import.meta.dir, "..");

describe("package surface", () => {
  it("exports a stable public entrypoint", () => {
    expect(VERSION).toBe("1.0.0");
  });

  it("exposes only the intended runtime API names", async () => {
    const api = await import("../src/index.ts");
    expect(Object.keys(api).sort()).toEqual(
      ["TeamConfigError", "VERSION", "loadTeam", "parseTeam"].sort(),
    );
  });

  it("packages only the runtime surface for npm", async () => {
    const proc = Bun.spawn(["npm", "pack", "--dry-run", "--json"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;

    expect(code).toBe(0);
    expect(stderr.includes("npm ERR!")).toBe(false);

    const [pack] = JSON.parse(stdout) as Array<{
      name: string;
      files: Array<{ path: string }>;
    }>;
    if (!pack) throw new Error("npm pack did not return any metadata");
    const files = new Set(pack.files.map((f) => f.path));
    const allowedPrefixes = [
      "package.json",
      "README.md",
      "src/",
      "charters/",
      "commands/",
      "examples/",
      "skills/",
    ];
    const isAllowed = (path: string): boolean =>
      allowedPrefixes.some((prefix) => path === prefix || path.startsWith(prefix));

    expect(pack.name).toBe("agvsr");
    expect([...files].every(isAllowed)).toBe(true);
    expect(files.has("package.json")).toBe(true);
    expect(files.has("src/index.ts")).toBe(true);
    expect(files.has("src/cli/agvsr.ts")).toBe(true);
    expect(files.has("charters/scaffold.md")).toBe(true);
    expect(files.has("commands/agvsr.md")).toBe(true);
    expect(files.has("commands/agvsr.toml")).toBe(true);
    expect(files.has("examples/team.yaml")).toBe(true);
    expect(files.has("skills/agvsr/SKILL.md")).toBe(true);
    expect(files.has("README.md")).toBe(true);
    expect([...files].some((path) => path.startsWith("test/"))).toBe(false);
    expect([...files].some((path) => path.startsWith("docs/") && path !== "README.md")).toBe(false);
  });
});
