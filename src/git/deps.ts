/**
 * Dependency seeding for job worktrees (D41).
 *
 * A fresh `git worktree` has no `node_modules`, so every job used to begin by
 * reinstalling dependencies — and, inside an adapter sandbox that can only write
 * under the worktree, often failing to. The recorded job log mentions `bun install`
 * 562 times across 52 jobs, with one job alone accounting for 53 of them.
 *
 * Seeding copies the ignored dependency directories in once. Two properties matter:
 *
 *   - The source is never the user's checkout. Worktrees are agent-writable, and an
 *     agent that corrupts a seeded tree must not be able to corrupt the repository
 *     the human works in. Dependencies are staged into an agvsr-owned cache first,
 *     and worktrees are linked from the cache.
 *   - Linking is by hard link where the platform supports it, so N worktrees cost
 *     roughly one copy rather than N. Package managers replace directories instead
 *     of editing files in place, which is what makes this safe in practice; set
 *     AGVSR_SEED_LINK=0 to force independent copies.
 *
 * Everything here is best effort. A failure means the job installs its own
 * dependencies exactly as it did before, so it warns and returns rather than
 * failing provisioning.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { worktreesDir } from "../paths.ts";

/** Dependency directories seeded when present and git-ignored. */
const DEFAULT_SEED_PATHS = ["node_modules"];

/**
 * Files whose contents decide whether a cached tree is still current. A lockfile
 * change means the dependency set moved and the cache has to be rebuilt.
 */
const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "deno.lock",
];

/** Parsed AGVSR_SEED_PATHS, or the default set. Empty/off disables seeding. */
export function seedPaths(): string[] {
  const raw = process.env.AGVSR_SEED_PATHS;
  if (raw === undefined) return DEFAULT_SEED_PATHS;
  const trimmed = raw.trim();
  if (!trimmed || /^(0|off|false|no)$/i.test(trimmed)) return [];
  return trimmed
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function hardLinkEnabled(): boolean {
  const raw = process.env.AGVSR_SEED_LINK;
  return !raw || !/^(0|off|false|no)$/i.test(raw.trim());
}

function run(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  return r.status === 0;
}

/** Fingerprint of the repo's lockfiles; changes when the dependency set moves. */
function lockFingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const name of LOCKFILES) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    hash.update(name);
    try {
      hash.update(readFileSync(path));
    } catch {
      // Unreadable lockfile: fold in nothing, so the cache is simply reused.
    }
  }
  return hash.digest("hex").slice(0, 16);
}

function cacheRoot(repoRoot: string): string {
  const key = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
  return join(worktreesDir(), ".deps", key);
}

/**
 * Copy a tree. Hard links where allowed and supported (near-free, and the reason
 * this scales past a handful of worktrees), otherwise an independent copy.
 */
function copyTree(src: string, dest: string, allowLink: boolean): boolean {
  mkdirSync(dirname(dest), { recursive: true });
  if (allowLink && process.platform !== "win32") {
    // -a preserves symlinks (node_modules/.bin is full of them); -l hard-links
    // regular files; --reflink=auto is a free win on CoW filesystems.
    if (run("cp", ["-al", src, dest])) return true;
  }
  if (process.platform !== "win32" && run("cp", ["-a", "--reflink=auto", src, dest])) return true;
  try {
    cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stage `name` from the repo into the agvsr-owned cache if the cache is missing or
 * stale, and return the cached path (null if it could not be staged).
 */
function ensureCached(repoRoot: string, name: string, fingerprint: string): string | null {
  const dir = cacheRoot(repoRoot);
  const cached = join(dir, name);
  const stamp = join(dir, `${name.replace(/[/\\]/g, "_")}.stamp`);

  if (existsSync(cached) && existsSync(stamp)) {
    try {
      if (readFileSync(stamp, "utf8").trim() === fingerprint) return cached;
    } catch {
      // fall through and restage
    }
  }

  const src = join(repoRoot, name);
  if (!existsSync(src)) return null;
  try {
    rmSync(cached, { recursive: true, force: true });
  } catch {
    return null;
  }
  mkdirSync(dir, { recursive: true });
  // The cache is staged as a real copy, never links: it is the isolation boundary
  // between agent-writable worktrees and the human's checkout.
  if (!copyTree(src, cached, false)) return null;
  try {
    writeFileSync(stamp, fingerprint);
  } catch {
    // A missing stamp only costs a restage next time.
  }
  return cached;
}

/**
 * Seed ignored dependency directories into a freshly provisioned worktree.
 * Best effort: returns the names actually seeded.
 */
export function seedDependencies(
  repoRoot: string,
  worktree: string,
  isIgnored: (path: string) => boolean,
): string[] {
  const names = seedPaths();
  if (names.length === 0) return [];

  const fingerprint = lockFingerprint(repoRoot);
  const allowLink = hardLinkEnabled();
  const seeded: string[] = [];

  for (const name of names) {
    const target = join(worktree, name);
    // Never shadow what the checkout already provides — a tracked path, or one the
    // provisioner already replicated.
    if (existsSync(target)) continue;
    if (!existsSync(join(repoRoot, name))) continue;
    if (!isIgnored(name)) continue;

    const cached = ensureCached(repoRoot, name, fingerprint);
    if (!cached) continue;
    if (copyTree(cached, target, allowLink)) seeded.push(name);
  }
  return seeded;
}
