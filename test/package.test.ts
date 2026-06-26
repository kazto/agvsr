import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { VERSION, startDaemon } from "../src/index.ts";

const ROOT = join(import.meta.dir, "..");

describe("package surface", () => {
  it("exports a stable public entrypoint", () => {
    expect(VERSION).toBe("0.0.0");
    expect(typeof startDaemon).toBe("function");
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

    expect(pack.name).toBe("agvsr");
    expect(files.has("src/index.ts")).toBe(true);
    expect(files.has("src/cli/agvsr.ts")).toBe(true);
    expect(files.has("charters/scaffold.md")).toBe(true);
    expect(files.has("examples/team.yaml")).toBe(true);
    expect(files.has("README.md")).toBe(true);
    expect(files.has("test/e2e.test.ts")).toBe(false);
    expect(files.has("docs/design.md")).toBe(false);
  });
});
