/**
 * Daemon-executed verification gate (D43 mechanism B).
 *
 * Environment parity stops the specific accident that made a job report "293
 * tests passed" while 236 never ran. It does not stop the general shape of it.
 * A test suite can be silently narrowed a dozen other ways — a changed
 * `testPathIgnorePatterns`, a tag filter, a project that fails to load, a
 * CI-only flag — and every one of them exits 0 and prints a green summary.
 *
 * The invariant that survives all of them is a count. So the daemon runs the
 * suite itself, reads how many tests actually ran, and compares that against
 * how many the human's own checkout runs. The agent's report is not an input:
 * a turn claiming "all tests pass" is not read, parsed, or trusted here.
 *
 * Opt-in, because it costs a second run of the suite: a job without a `verify`
 * block in team.yaml is unaffected.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { worktreesDir } from "../paths.ts";
import type { VerifyConfig } from "../config/team.ts";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * How the common runners report a total. Each must capture the number of tests
 * that ran, not the number that passed — a suite that shrinks and stays green
 * is the exact failure being caught.
 */
const BUILTIN_COUNT_PATTERNS = [
  /^\s*Ran\s+(\d+)\s+tests?\b/m, // bun test
  /^\s*Tests\s+[^\n]*\((\d+)\)\s*$/m, // vitest
  /^Tests:\s+[^\n]*?(\d+)\s+total/m, // jest
];

export function verifyGateEnabled(): boolean {
  const raw = process.env.AGVSR_VERIFY_GATE;
  return !raw || !/^(0|off|false|no)$/i.test(raw.trim());
}

export interface VerifyRun {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

/**
 * Run the verification command. stdout and stderr are merged: runners disagree
 * about which one carries the summary line, and the count is what matters.
 */
export function runVerify(
  config: VerifyConfig,
  cwd: string,
  env: Record<string, string>,
): VerifyRun {
  const result = spawnSync(config.command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: config.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    timedOut: result.error?.name === "TimeoutError" || (result.signal !== null && !result.status),
  };
}

/**
 * Tests reported as run, or null when no pattern matched.
 *
 * Null is never treated as "fine". A summary this cannot read is a summary
 * nothing has verified, and the gate refuses on it.
 */
export function extractCount(output: string, pattern?: string): number | null {
  const patterns = pattern ? [new RegExp(pattern, "m")] : BUILTIN_COUNT_PATTERNS;
  for (const re of patterns) {
    const match = re.exec(output);
    if (match?.[1]) {
      const n = Number(match[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function cacheFile(repoRoot: string): string {
  const key = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
  return join(worktreesDir(), ".verify", `${key}.json`);
}

type BaselineCache = Record<string, number>;

function readCache(repoRoot: string): BaselineCache {
  try {
    return JSON.parse(readFileSync(cacheFile(repoRoot), "utf8")) as BaselineCache;
  } catch {
    return {};
  }
}

function writeCache(repoRoot: string, cache: BaselineCache): void {
  try {
    const file = cacheFile(repoRoot);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(cache));
  } catch {
    // A cache that cannot be written only costs a re-run next time.
  }
}

function headOf(repoRoot: string): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return r.status === 0 ? (r.stdout ?? "").trim() : "unknown";
}

export interface BaselineResult {
  count: number | null;
  /** Where the number came from, for the refusal message. */
  source: "fixed" | "cache" | "measured" | "off" | "unreadable";
}

/**
 * How many tests the human's own checkout runs.
 *
 * Measured in the source checkout, never the worktree: the checkout is the one
 * place where the git-ignored environment files exist, which is precisely what
 * makes its number the honest one. Cached per (repo, HEAD, command) so only the
 * first job on a given commit pays for it.
 */
export function resolveBaseline(
  config: VerifyConfig,
  repoRoot: string,
  env: Record<string, string>,
): BaselineResult {
  const spec = config.baseline ?? "source";
  if (spec === "off") return { count: null, source: "off" };

  const fixed = /^fixed:(\d+)$/.exec(spec);
  if (fixed) return { count: Number(fixed[1]), source: "fixed" };

  const key = createHash("sha256")
    .update(`${headOf(repoRoot)} ${config.command}`)
    .digest("hex")
    .slice(0, 16);
  const cache = readCache(repoRoot);
  if (cache[key] !== undefined) return { count: cache[key]!, source: "cache" };

  const run = runVerify(config, repoRoot, env);
  const count = extractCount(run.output, config.count_pattern);
  if (count === null) return { count: null, source: "unreadable" };

  cache[key] = count;
  writeCache(repoRoot, cache);
  return { count, source: "measured" };
}

export interface VerifyOutcome {
  ok: boolean;
  code: "verify_failed" | "verify_regressed" | "verify_unreadable";
  message: string;
}

/** Tail of the run's output, enough to see the summary that was read. */
function tail(output: string, lines = 20): string {
  return output.trimEnd().split("\n").slice(-lines).join("\n");
}

/**
 * Run the suite in the job's worktree and judge it against the baseline.
 * Returns null when everything checks out.
 */
export function checkVerifyGate(
  config: VerifyConfig,
  worktree: string,
  repoRoot: string,
  env: Record<string, string>,
): VerifyOutcome | null {
  const run = runVerify(config, worktree, env);
  if (run.timedOut) {
    return {
      ok: false,
      code: "verify_failed",
      message:
        `Verification timed out after ${config.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms.\n` +
        `command: ${config.command}\n\n${tail(run.output)}`,
    };
  }
  if (run.exitCode !== 0) {
    return {
      ok: false,
      code: "verify_failed",
      message:
        `Verification failed in the job worktree (exit ${run.exitCode}).\n` +
        `command: ${config.command}\n\n${tail(run.output)}`,
    };
  }

  const baseline = resolveBaseline(config, repoRoot, env);
  if (baseline.source === "off") return null;

  const count = extractCount(run.output, config.count_pattern);
  // Fail-closed on both sides. An unreadable summary means nothing was
  // verified, and reporting that as success is the failure this exists to stop.
  if (count === null) {
    return {
      ok: false,
      code: "verify_unreadable",
      message:
        `Verification passed but its test count could not be read, so nothing was ` +
        `actually verified.\nSet verify.count_pattern in team.yaml to a regex whose first ` +
        `group captures the number of tests run, or verify.baseline: off to skip the ` +
        `comparison.\ncommand: ${config.command}\n\n${tail(run.output)}`,
    };
  }
  if (baseline.count === null) {
    return {
      ok: false,
      code: "verify_unreadable",
      message:
        `Could not establish a baseline test count from ${repoRoot}, so the ${count} ` +
        `tests that ran here cannot be judged.\nSet verify.baseline to fixed:<n> to state ` +
        `the expected count directly.\ncommand: ${config.command}`,
    };
  }

  const tolerance = config.tolerance ?? 0;
  if (count < baseline.count - tolerance) {
    return {
      ok: false,
      code: "verify_regressed",
      message:
        `Verification passed, but it ran fewer tests here than in ${repoRoot}: ` +
        `${count} vs ${baseline.count} (${baseline.source}).\n` +
        `${baseline.count - count} test(s) did not run. A green result that skipped them ` +
        `verifies nothing. The usual cause is configuration or an environment file the ` +
        `worktree does not have — check worktree.env_files in team.yaml.\n` +
        `command: ${config.command}\n\n${tail(run.output)}`,
    };
  }
  return null;
}
