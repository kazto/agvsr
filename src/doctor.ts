/**
 * agvsr doctor — pre-flight inspection core (D2 permanent-countermeasures §(b)).
 * Daemon-independent and read-only by default: no IPC, no spawning adapters unless
 * the opt-in probe mode is requested.
 * All I/O is injectable for deterministic testing.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parseTeam, type Adapter, type TeamConfig } from "./config/team.ts";
import { ADAPTER_BIN } from "./adapters/index.ts";
import { validateTeamModels } from "./adapters/validate.ts";
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
  /** Probe a role's adapter/model pair with a minimal prompt. */
  probeModel(spec: DoctorProbeSpec): Promise<DoctorProbeOutcome>;
}

export interface DoctorProbeSpec {
  role: string;
  adapter: Adapter;
  model: string;
  bin: string;
  cwd: string;
  path: string;
  prompt: string;
}

export interface DoctorProbeOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DoctorOptions {
  probe?: boolean;
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
    probeModel: realProbeModel,
  };
}

const PROBE_PROMPT = "Reply with exactly OK.";
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_CAPTURE_LIMIT = 4_096;

function trimForMessage(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 200) return trimmed;
  return `${trimmed.slice(0, 197)}...`;
}

function probeArgs(adapter: Adapter, model: string, prompt: string): string[] {
  if (adapter === "claude-code") {
    return ["-p", "--model", model, prompt];
  }
  if (adapter === "codex") {
    return ["exec", "--json", "--skip-git-repo-check", "-m", model, prompt];
  }
  return ["-p", "--model", model, prompt];
}

async function readLimited(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string> {
  if (!stream) return "";
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    if (out.length >= limit) continue;
    const next = decoder.decode(chunk, { stream: true });
    out += next;
    if (out.length > limit) {
      out = out.slice(0, limit);
    }
  }
  if (out.length < limit) {
    out += decoder.decode();
    if (out.length > limit) out = out.slice(0, limit);
  }
  return out;
}

async function realProbeModel(spec: DoctorProbeSpec): Promise<DoctorProbeOutcome> {
  const proc = Bun.spawn([spec.bin, ...probeArgs(spec.adapter, spec.model, spec.prompt)], {
    cwd: spec.cwd,
    env: { ...process.env, PATH: spec.path },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let timeoutMessage: string | null = null;
  timer = setTimeout(() => {
    timeoutMessage = `probe timed out after ${PROBE_TIMEOUT_MS}ms`;
    try {
      proc.kill();
    } catch {}
  }, PROBE_TIMEOUT_MS);

  const stdout = readLimited(proc.stdout, PROBE_CAPTURE_LIMIT);
  const stderr = readLimited(proc.stderr, PROBE_CAPTURE_LIMIT);

  try {
    const exitCode = await proc.exited;
    const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
    const mergedStderr = timeoutMessage
      ? [stderrText, timeoutMessage].filter(Boolean).join("\n")
      : stderrText;
    return {
      exitCode,
      stdout: stdoutText,
      stderr: mergedStderr,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
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

function probeLabel(role: string, roleConfig: TeamConfig["roles"][string]): string {
  return `${role} (${roleConfig.adapter} ${roleConfig.model})`;
}

function probeFailureMessage(
  role: string,
  adapter: Adapter,
  model: string,
  bin: string,
  detail: string,
): string {
  const hint = `check team.yaml ${role}.model=${JSON.stringify(model)}, ${adapter} login/API key, and PATH/install ${bin}`;
  return detail ? `${detail}; ${hint}` : hint;
}

export async function runDoctor(
  teamFile: string,
  deps: DoctorDeps,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
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

  // ── section 2: model warnings ─────────────────────────────────────────────
  const modelGroup: DoctorGroup = { title: "model warnings", checks: [] };
  groups.push(modelGroup);
  const modelFindings = validateTeamModels(team);
  if (modelFindings.length === 0) {
    modelGroup.checks.push({
      label: "models",
      level: "ok",
      message: "no adapter warnings",
    });
  } else {
    for (const finding of modelFindings) {
      modelGroup.checks.push({
        label: `${finding.role} model`,
        level: "warn",
        message: `${finding.adapter} ${finding.model}: ${finding.message}${
          finding.hint ? ` Hint: ${finding.hint}` : ""
        }`,
      });
    }
  }

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

  // ── section 3: adapter binaries ───────────────────────────────────────────
  const binGroup: DoctorGroup = { title: "adapter binaries", checks: [] };
  groups.push(binGroup);

  const pathStr = await deps.loginPath();
  const binaryPaths = new Map<Adapter, string | null>();
  for (const [adapter, roles] of rolesByAdapter) {
    const bin = ADAPTER_BIN[adapter];
    const found = deps.which(bin, pathStr);
    binaryPaths.set(adapter, found);
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

  // ── section 4: auth ───────────────────────────────────────────────────────
  const authGroup: DoctorGroup = { title: "auth", checks: [] };
  groups.push(authGroup);

  for (const adapter of rolesByAdapter.keys()) {
    authGroup.checks.push(checkAuth(adapter, deps));
  }

  if (options.probe) {
    const probeGroup: DoctorGroup = { title: "model probes", checks: [] };
    groups.push(probeGroup);

    for (const [role, roleConfig] of Object.entries(team.roles)) {
      const bin = ADAPTER_BIN[roleConfig.adapter];
      const found = binaryPaths.get(roleConfig.adapter) ?? null;
      const label = probeLabel(role, roleConfig);

      if (!found) {
        probeGroup.checks.push({
          label,
          level: "fail",
          message: probeFailureMessage(
            role,
            roleConfig.adapter,
            roleConfig.model,
            bin,
            `skipped probe because ${bin} is not available in PATH`,
          ),
        });
        continue;
      }

      const outcome = await deps.probeModel({
        role,
        adapter: roleConfig.adapter,
        model: roleConfig.model,
        bin: found,
        cwd: dirname(teamFile),
        path: pathStr,
        prompt: PROBE_PROMPT,
      });
      if (outcome.exitCode === 0) {
        probeGroup.checks.push({
          label,
          level: "ok",
          message: `probe exited 0 via ${found}`,
        });
        continue;
      }

      const detail = [trimForMessage(outcome.stderr), trimForMessage(outcome.stdout)]
        .filter(Boolean)
        .join(" | ");
      probeGroup.checks.push({
        label,
        level: "fail",
        message: probeFailureMessage(
          role,
          roleConfig.adapter,
          roleConfig.model,
          bin,
          detail
            ? `probe exited ${outcome.exitCode}: ${detail}`
            : `probe exited ${outcome.exitCode}`,
        ),
      });
    }
  }

  return { teamFile, groups };
}
