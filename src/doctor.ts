/**
 * agvsr doctor — pre-flight inspection core (D2 permanent-countermeasures §(b)).
 * Daemon-independent and read-only: no IPC, no spawning adapters.
 * All I/O is injectable for deterministic testing.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseTeam, type Adapter, type TeamConfig } from "./config/team.ts";
import { ADAPTER_BIN } from "./adapters/index.ts";
import { resolveUserPath } from "./paths.ts";

export type CheckLevel = "ok" | "warn" | "fail";

export interface DoctorCheck {
  label: string;
  level: CheckLevel;
  message: string;
}

export interface DoctorGroup {
  title: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  teamFile: string;
  groups: DoctorGroup[];
}

export function reportHasFailures(report: DoctorReport): boolean {
  return report.groups.some((g) => g.checks.some((c) => c.level === "fail"));
}

export interface DoctorDeps {
  /** Returns the resolved login-shell PATH string. */
  loginPath(): Promise<string>;
  /** Check if a binary is executable in the given colon-separated PATH; returns full path or null. */
  which(bin: string, pathStr: string): string | null;
  /** Read an environment variable value. */
  getEnv(name: string): string | undefined;
  /** Check if a path (file or directory) exists. */
  fileExists(path: string): boolean;
  /** Returns the user's home directory. */
  homeDir(): string;
  /** Read text content of the team file. Throws on error. */
  readFile(path: string): string;
}

function realWhich(bin: string, pathStr: string): string | null {
  for (const dir of pathStr.split(":")) {
    if (!dir) continue;
    const full = join(dir, bin);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      // not found or not executable in this dir
    }
  }
  return null;
}

export function defaultDeps(): DoctorDeps {
  return {
    loginPath: resolveUserPath,
    which: realWhich,
    getEnv: (name) => process.env[name],
    fileExists: existsSync,
    homeDir: homedir,
    readFile: (path) => readFileSync(path, "utf8"),
  };
}

function checkAuth(adapter: Adapter, deps: DoctorDeps): DoctorCheck {
  const home = deps.homeDir();
  const label = `${adapter} auth`;

  if (adapter === "claude-code") {
    if (deps.getEnv("ANTHROPIC_API_KEY"))
      return { label, level: "ok", message: "ANTHROPIC_API_KEY set" };
    if (deps.fileExists(join(home, ".claude", ".credentials.json")))
      return { label, level: "ok", message: "~/.claude/.credentials.json found" };
    if (deps.fileExists(join(home, ".claude.json")))
      return { label, level: "ok", message: "~/.claude.json found" };
    return {
      label,
      level: "warn",
      message:
        "no auth found (ANTHROPIC_API_KEY not set, ~/.claude/.credentials.json and ~/.claude.json not found)",
    };
  }

  if (adapter === "codex") {
    if (deps.getEnv("OPENAI_API_KEY")) return { label, level: "ok", message: "OPENAI_API_KEY set" };
    if (deps.fileExists(join(home, ".codex", "auth.json")))
      return { label, level: "ok", message: "~/.codex/auth.json found" };
    return {
      label,
      level: "warn",
      message: "no auth found (OPENAI_API_KEY not set, ~/.codex/auth.json not found)",
    };
  }

  if (adapter === "agy") {
    if (deps.getEnv("GEMINI_API_KEY")) return { label, level: "ok", message: "GEMINI_API_KEY set" };
    if (deps.getEnv("GOOGLE_API_KEY")) return { label, level: "ok", message: "GOOGLE_API_KEY set" };
    if (deps.fileExists(join(home, ".gemini", "antigravity-cli")))
      return { label, level: "ok", message: "~/.gemini/antigravity-cli/ found" };
    return {
      label,
      level: "warn",
      message:
        "no auth found (GEMINI_API_KEY and GOOGLE_API_KEY not set, ~/.gemini/antigravity-cli/ not found)",
    };
  }

  return { label, level: "warn", message: "auth check not implemented for this adapter" };
}

export async function runDoctor(teamFile: string, deps: DoctorDeps): Promise<DoctorReport> {
  const groups: DoctorGroup[] = [];

  // ── section 1: team.yaml ──────────────────────────────────────────────────
  const teamGroup: DoctorGroup = { title: "team.yaml", checks: [] };
  groups.push(teamGroup);

  let team: TeamConfig;
  try {
    const text = deps.readFile(teamFile);
    team = parseTeam(text);
  } catch (err) {
    teamGroup.checks.push({ label: "team file", level: "fail", message: (err as Error).message });
    return { teamFile, groups };
  }

  const roleCount = Object.keys(team.roles).length;
  const roleSummary = Object.entries(team.roles)
    .map(([name, r]) => `${name}: ${r.adapter}`)
    .join(", ");
  teamGroup.checks.push({ label: "team file", level: "ok", message: teamFile });
  teamGroup.checks.push({
    label: "schema",
    level: "ok",
    message: `${roleCount} role${roleCount !== 1 ? "s" : ""} (${roleSummary})`,
  });

  // Build adapter → roles map (preserves insertion order = team.yaml order).
  const rolesByAdapter = new Map<Adapter, string[]>();
  for (const [name, role] of Object.entries(team.roles)) {
    const existing = rolesByAdapter.get(role.adapter);
    if (existing) {
      existing.push(name);
    } else {
      rolesByAdapter.set(role.adapter, [name]);
    }
  }

  // ── section 2: adapter binaries ───────────────────────────────────────────
  const binGroup: DoctorGroup = { title: "adapter binaries", checks: [] };
  groups.push(binGroup);

  const pathStr = await deps.loginPath();
  for (const [adapter, roles] of rolesByAdapter) {
    const bin = ADAPTER_BIN[adapter];
    const found = deps.which(bin, pathStr);
    if (found) {
      binGroup.checks.push({ label: bin, level: "ok", message: found });
    } else {
      binGroup.checks.push({
        label: bin,
        level: "fail",
        message: `not found in PATH — roles using this adapter: ${roles.join(", ")}`,
      });
    }
  }

  // ── section 3: auth ───────────────────────────────────────────────────────
  const authGroup: DoctorGroup = { title: "auth", checks: [] };
  groups.push(authGroup);

  for (const adapter of rolesByAdapter.keys()) {
    authGroup.checks.push(checkAuth(adapter, deps));
  }

  return { teamFile, groups };
}
