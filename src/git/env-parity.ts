/**
 * Environment parity between the human's checkout and a job worktree (D43).
 *
 * A `git worktree` only ever contains tracked files, so every git-ignored
 * environment file — `.env`, `.envrc`, a local settings override — is absent
 * from it. Test suites that key off those files do not fail there; they
 * silently run a subset and report success. One recorded job reported
 * "293 tests passed" while 236 tests never ran, because the vitest project
 * holding every test for the feature under development was excluded by a
 * missing DATABASE_TEST_URL.
 *
 * The failure is invisible from inside the worktree: nothing is missing that
 * anything looks for. So the check happens on the outside, before the job
 * exists, comparing what the checkout has against what team.yaml declares.
 * Any ignored environment file with no declaration fails `job.create` — a
 * one-time cost per repository, paid before an agent can run and report green.
 */
import { existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { EnvFileDisposition, TeamConfig } from "../config/team.ts";

/**
 * Basename patterns treated as environment files. Deliberately narrow: a
 * false positive costs the human one `ignore:` line, so the list covers the
 * conventional names rather than guessing at every possible local override.
 */
const ENV_FILE_PATTERNS = [
  /^\.env$/,
  /^\.env\..+$/,
  /^\.envrc$/,
  /^\.tool-versions$/,
  /^.+\.local\.(toml|json|ya?ml)$/,
];

/**
 * Directories holding editor and agent configuration. A file under one of these
 * configures the tooling, never the application under test, so flagging it would
 * cost every user an `ignore:` line that protects nothing. Application config
 * that happens to live at the repo root is still checked.
 */
const TOOLING_DIRS = new Set([
  ".claude",
  ".codex",
  ".agents",
  ".agvsr",
  ".cursor",
  ".vscode",
  ".idea",
]);

function isToolingPath(relPath: string): boolean {
  return TOOLING_DIRS.has(relPath.split("/")[0]!);
}

function isEnvFileName(name: string): boolean {
  return ENV_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

export function envParityEnabled(): boolean {
  const raw = process.env.AGVSR_ENV_PARITY;
  return !raw || !/^(0|off|false|no)$/i.test(raw.trim());
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
}

/**
 * Git toplevel for `cwd`, or null when it is not a git checkout. Paths below
 * are all repo-relative, so every caller needs the same origin — a job whose
 * cwd is a subdirectory must not resolve `.env` against that subdirectory.
 */
export function repoRootOf(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok && r.stdout ? r.stdout : null;
}

/**
 * Git-ignored environment files in the checkout, as repo-relative paths.
 *
 * `--directory` collapses a wholly-ignored directory to a single entry, so
 * this does not walk `node_modules`. A `.env` inside such a directory is
 * therefore not reported, which is correct: it belongs to the dependency
 * tree, not to the repository's own configuration.
 */
export function listIgnoredEnvFiles(repoRoot: string): string[] {
  const listed = git(repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  if (!listed.ok || !listed.stdout) return [];
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith("/"))
    .filter((path) => !isToolingPath(path))
    .filter((path) => isEnvFileName(basename(path)))
    .sort();
}

/** Env files present in the checkout that team.yaml says nothing about. */
export function unresolvedEnvFiles(repoRoot: string, team: TeamConfig): string[] {
  const declared = team.worktree?.env_files ?? {};
  return listIgnoredEnvFiles(repoRoot).filter((path) => declared[path] === undefined);
}

export function envParityErrorMessage(repoRoot: string, unresolved: string[]): string {
  const rows = unresolved.map((path) => `  ${path}`).join("\n");
  return [
    `これらのファイルは ${repoRoot} に存在し gitignore されていますが、job worktree には`,
    `存在しません。依存するテストや設定が黙ってスキップされる可能性があります。`,
    `team.yaml の worktree.env_files で各ファイルの扱いを宣言してください。`,
    ``,
    rows,
    ``,
    `worktree:`,
    `  env_files:`,
    ...unresolved.map((path) => `    "${path}": env`),
    ``,
    `  env             : 中身を環境変数として各ロールに渡す(推奨。ファイル自体は配らない)`,
    `  [KEY1, KEY2]    : env と同じだが、渡すキーを限定する`,
    `  copy            : ファイルを worktree に配置する`,
    `  ignore          : このリポジトリのジョブには不要`,
    ``,
    `一時的に無効化するには AGVSR_ENV_PARITY=0`,
  ].join("\n");
}

/**
 * Parse a dotenv-style file into key/value pairs.
 *
 * Intentionally minimal — `KEY=VALUE`, `export KEY=VALUE`, `#` comments, and
 * surrounding quotes. Anything more (command substitution, interpolation) is
 * shell behaviour that belongs to `.envrc`, and guessing at it would inject
 * values that differ from what the human's shell actually produces.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readEnvFile(repoRoot: string, relPath: string): Record<string, string> {
  const abs = join(repoRoot, relPath);
  if (!existsSync(abs)) return {};
  try {
    return parseEnvFile(readFileSync(abs, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Variables contributed by `env`/key-list declarations, for a job's roles.
 *
 * These sit *below* team.yaml's own `env:` in precedence: a value written
 * explicitly in the config is a deliberate choice and outranks whatever the
 * file happens to hold.
 */
export function envFileVariables(repoRoot: string, team: TeamConfig): Record<string, string> {
  const declared = team.worktree?.env_files ?? {};
  const out: Record<string, string> = {};
  for (const [relPath, disposition] of Object.entries(declared)) {
    if (disposition === "ignore" || disposition === "copy") continue;
    const parsed = readEnvFile(repoRoot, relPath);
    if (disposition === "env") {
      Object.assign(out, parsed);
      continue;
    }
    // Key list: only the named variables cross into the job. This is the
    // safe form — a whole `.env` can carry variables that change unrelated
    // behaviour (one recorded case flipped a feature flag and broke a test
    // that had nothing to do with the job).
    for (const key of disposition) {
      if (parsed[key] !== undefined) out[key] = parsed[key]!;
    }
  }
  return out;
}

/**
 * Place `copy`-declared files into a freshly provisioned worktree.
 * Best effort: returns the paths actually copied.
 */
export function copyDeclaredEnvFiles(
  repoRoot: string,
  worktree: string,
  team: TeamConfig,
): string[] {
  const declared = team.worktree?.env_files ?? {};
  const copied: string[] = [];
  for (const [relPath, disposition] of Object.entries(declared)) {
    if (disposition !== "copy") continue;
    const src = join(repoRoot, relPath);
    if (!existsSync(src)) continue;
    const dest = join(worktree, relPath);
    if (existsSync(dest)) continue; // never shadow what the checkout provides
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      copied.push(relPath);
    } catch {
      // Best effort, matching dependency seeding: a file that cannot be placed
      // leaves the job exactly as it was before this feature existed.
    }
  }
  return copied;
}

export type { EnvFileDisposition };
