#!/usr/bin/env bun
/**
 * `agvsr` — the thin CLI client (D6/D15). Connects to the daemon over local IPC
 * and issues one request. `agvsr daemon` runs the daemon itself in the foreground.
 */
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { Client, DaemonNotRunningError } from "../ipc/transport.ts";
import { ipcEndpoint } from "../paths.ts";
import { VERSION } from "../version.ts";
import type { Adapter } from "../config/team.ts";
import type {
  Job,
  JobRuntime,
  Message,
  PingResult,
  PushFrame,
  Response,
  RoleSummary,
} from "../protocol.ts";

const USAGE = `agvsr ${VERSION}

Usage:
  agvsr init [options]              Generate a team.yaml without hand editing
  agvsr daemon [--team F]           Run the agvsrd daemon in the foreground
  agvsr daemon start [--team F]     Start the daemon in the background
  agvsr daemon stop                 Stop the running daemon gracefully
  agvsr daemon restart [--team F]   Restart the daemon (optionally with a new team file)
  agvsr ping                        Check the daemon is up
  agvsr job "<goal>" [--cwd D] [--id ID]  Submit a job (D is the target repo, default: cwd)
  agvsr status [job-id]             List jobs, or show one job with recent audit state
  agvsr logs <job-id> [-f]          Show audit messages for a job
  agvsr watch [--all] [--poll N]    Stream role messages across all running jobs in real time
  agvsr tell <job-id> "<message>"   Send a message to the supervisor of a running job
  agvsr stop <job-id>               Stop a running job gracefully (mark failed)
  agvsr kill <job-id>               Kill a running job immediately (mark interrupted)
  agvsr reload                      Reload team.yaml without restarting the daemon
  agvsr team                        Show configured roles
  agvsr doctor [--team F] [--json] [--probe]  Check adapter CLIs and auth; exit 0 if all pass
`;

function normalizeCwd(input: string): string {
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  return resolve(expanded);
}

/** Compact human duration: 45s, 12m, 1h03m. */
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Render live execution state next to a running job's status so the user can
 * tell "actively working" from "idle/stalled". Empty for terminal statuses.
 */
function formatRuntime(job: Job, rt: JobRuntime): string {
  if (job.status !== "running") return "";
  const idle = rt.idle_ms != null ? `, idle ${formatDuration(rt.idle_ms)}` : "";
  if (!rt.in_flight) {
    return ` — no in-flight turn${idle} (possibly stalled)`;
  }
  const roleDetails = rt.active_roles
    .map((role) => {
      const parts: string[] = [role];
      const remaining = rt.hard_remaining_ms?.[role];
      if (remaining !== undefined) parts.push(`budget ${formatDuration(remaining)} left`);
      const idleSince = rt.idle_since_progress_ms?.[role];
      if (idleSince !== undefined) parts.push(`last progress ${formatDuration(idleSince)} ago`);
      return parts.join(", ");
    })
    .join("; ");
  return ` — working: ${roleDetails}${idle}`;
}

/**
 * Parse the --poll N argument for `agvsr watch`.
 * Returns the clamped poll interval in ms, or throws RangeError for invalid input.
 */
export function parsePollMs(raw: string | undefined): number {
  if (raw === undefined) return 2000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RangeError(`--poll must be a positive finite number, got: ${raw}`);
  }
  return Math.max(500, n);
}

function formatMessageKind(kind: Message["kind"]): string {
  if (kind !== "note") return kind;
  return process.stdout.isTTY ? "\x1b[2m[note]\x1b[0m" : "[note]";
}

function unwrap<T>(res: Response<T>): T {
  if (!res.ok) {
    console.error(`error [${res.error.code}]: ${res.error.message}`);
    process.exit(1);
  }
  return res.result;
}

export interface DetachedDaemonOptions {
  teamFile?: string;
  endpoint?: string;
  bunExec?: string;
  scriptPath?: string;
  spawn?: typeof Bun.spawn;
  connect?: typeof Client.connect;
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  readyPollMs?: number;
}

export interface DetachedDaemonSpawnResult {
  alreadyRunning: boolean;
  started: boolean;
}

function daemonArgs(teamFile?: string): string[] {
  return teamFile ? ["daemon", "--team", teamFile] : ["daemon"];
}

function spawnDetachedDaemon(
  {
    bunExec,
    scriptPath,
    teamFile,
    spawn = Bun.spawn,
  }: Required<Pick<DetachedDaemonOptions, "bunExec" | "scriptPath">> &
    Pick<DetachedDaemonOptions, "teamFile" | "spawn">,
  stderr: "ignore" | "pipe" = "ignore",
): ReturnType<typeof Bun.spawn> {
  const child = spawn([bunExec, scriptPath, ...daemonArgs(teamFile)], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr,
  });
  child.unref();
  return child;
}

async function probeDaemon(
  endpoint: string,
  connect: typeof Client.connect = Client.connect,
): Promise<boolean> {
  try {
    const client = await connect(endpoint);
    client.close();
    return true;
  } catch (err) {
    if (err instanceof DaemonNotRunningError) return false;
    throw err;
  }
}

async function waitForDaemon(
  endpoint: string,
  connect: typeof Client.connect = Client.connect,
  sleep: (ms: number) => Promise<void> = Bun.sleep,
  readyTimeoutMs = 3000,
  readyPollMs = 50,
  childExit?: Promise<number>,
  childStderr?: Promise<string>,
): Promise<void> {
  let exitCode: number | null = null;
  childExit?.then(
    (code) => (exitCode = code),
    () => (exitCode = -1),
  );

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() <= deadline) {
    if (await probeDaemon(endpoint, connect)) return;
    if (exitCode !== null) {
      const stderr = (await childStderr)?.trim();
      const detail = stderr
        ? `:
${stderr}`
        : ".";
      throw new Error(`daemon process exited before becoming ready (exit ${exitCode})${detail}`);
    }
    await sleep(readyPollMs);
  }
  throw new Error(`daemon did not become ready at ${endpoint} within ${readyTimeoutMs}ms`);
}

export async function startDaemonDetached(
  options: DetachedDaemonOptions = {},
): Promise<DetachedDaemonSpawnResult> {
  const endpoint = options.endpoint ?? ipcEndpoint();
  const connect = options.connect ?? Client.connect;
  if (await probeDaemon(endpoint, connect)) return { alreadyRunning: true, started: false };

  const [bunExec, scriptPath] = process.argv as [string, string, ...string[]];
  const child = spawnDetachedDaemon(
    {
      bunExec: options.bunExec ?? bunExec,
      scriptPath: options.scriptPath ?? scriptPath,
      teamFile: options.teamFile,
      spawn: options.spawn,
    },
    "pipe",
  );
  const stderrText = child.stderr
    ? new Response(child.stderr as ReadableStream).text().catch(() => "")
    : Promise.resolve("");
  await waitForDaemon(
    endpoint,
    connect,
    options.sleep,
    options.readyTimeoutMs,
    options.readyPollMs,
    child.exited,
    stderrText,
  );
  return { alreadyRunning: false, started: true };
}

export function restartDaemonDetached(options: {
  teamFile?: string;
  bunExec?: string;
  scriptPath?: string;
  spawn?: typeof Bun.spawn;
}): void {
  const [bunExec, scriptPath] = process.argv as [string, string, ...string[]];
  spawnDetachedDaemon({
    bunExec: options.bunExec ?? bunExec,
    scriptPath: options.scriptPath ?? scriptPath,
    teamFile: options.teamFile,
    spawn: options.spawn,
  });
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  let client: Client;
  try {
    client = await Client.connect(ipcEndpoint());
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case "daemon": {
      const { values: daemonOpts, positionals: daemonArgs } = parseArgs({
        args: rest,
        options: { team: { type: "string" } },
        allowPositionals: true,
      });
      const subCmd = daemonArgs[0];

      if (subCmd === "stop") {
        await withClient(async (c) => {
          unwrap(await c.request("daemon.stop"));
          console.log("daemon stopping");
        });
        return;
      }

      if (subCmd === "start") {
        const started = await startDaemonDetached({
          teamFile: daemonOpts.team,
        });
        if (started.alreadyRunning) {
          console.log("daemon already running");
        } else {
          console.log("daemon started");
        }
        return;
      }

      if (subCmd === "restart") {
        await withClient(async (c) => {
          unwrap(await c.request("daemon.stop"));
          console.log("daemon stopped, restarting...");
        });
        restartDaemonDetached({ teamFile: daemonOpts.team });
        console.log("daemon restarted");
        return;
      }

      const { startDaemon } = await import("../daemon/daemon.ts");
      const daemon = await startDaemon({ teamFile: daemonOpts.team });
      console.log(`agvsrd ${VERSION} listening on ${daemon.endpoint}`);
      const shutdown = async () => {
        await daemon.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }

    case "ping":
      await withClient(async (c) => {
        const r = unwrap(await c.request<PingResult>("ping"));
        console.log(`pong — agvsrd ${r.version}`);
      });
      return;

    case "job": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { cwd: { type: "string" }, id: { type: "string" } },
        allowPositionals: true,
      });
      const goal = positionals.join(" ").trim();
      if (!goal) {
        console.error('a goal is required, e.g. agvsr job "add a health endpoint"');
        process.exit(1);
      }
      const cwd = normalizeCwd(values.cwd ?? process.cwd());
      const params: { goal: string; cwd: string; id?: string } = { goal, cwd };
      if (values.id) params.id = values.id;
      await withClient(async (c) => {
        const { job } = unwrap(await c.request<{ job: Job }>("job.create", params));
        console.log(`job ${job.id} created (${job.status})`);
      });
      return;
    }

    case "status":
      await withClient(async (c) => {
        const jobId = rest[0];
        if (jobId) {
          const { job, runtime } = unwrap(
            await c.request<{ job: Job; runtime: JobRuntime }>("job.get", { id: jobId }),
          );
          const { messages } = unwrap(
            await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId }),
          );
          const last = messages.at(-1);
          console.log(`${job.id}  ${job.status}${formatRuntime(job, runtime)}`);
          console.log(`goal: ${job.goal}`);
          console.log(`cwd: ${job.cwd}`);
          console.log(`worktree: ${job.worktree ?? "(none)"}`);
          console.log(`branch: ${job.branch ?? "(not set)"}`);
          console.log(`created_at: ${job.created_at}`);
          console.log(`updated_at: ${job.updated_at}`);
          console.log(`messages: ${messages.length}`);
          if (last) {
            console.log(`last_message_at: ${last.created_at}`);
            console.log(
              `last_message: ${formatMessageKind(last.kind)} ${last.from_role} -> ${last.to_role}`,
            );
            console.log(last.body);
          } else {
            console.log("last_message: (none)");
          }
          return;
        }

        const { jobs } = unwrap(await c.request<{ jobs: Job[] }>("job.list"));
        if (jobs.length === 0) {
          console.log("no jobs");
          return;
        }
        for (const j of jobs) {
          console.log(`${j.id}  ${j.status.padEnd(11)}  ${j.goal}`);
        }
      });
      return;

    case "logs": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { follow: { type: "boolean", short: "f" } },
        allowPositionals: true,
      });
      const jobId = positionals[0];
      if (!jobId) {
        console.error("a job id is required, e.g. agvsr logs <job-id>");
        process.exit(1);
      }
      const print = (m: Message) => {
        const refs = m.refs ? ` refs=${m.refs}` : "";
        console.log(
          `[${m.created_at}] ${formatMessageKind(m.kind)} ${m.from_role} -> ${m.to_role}${refs}`,
        );
        console.log(m.body);
      };
      await withClient(async (c) => {
        const seen = new Set<string>();
        const { messages } = unwrap(
          await c.request<{ messages: Message[] }>("msg.list", {
            job_id: jobId,
            mark_read: true,
          }),
        );
        let count = 0;
        for (const m of messages) {
          seen.add(m.id);
          print(m);
          count++;
        }

        if (!values.follow) {
          if (count === 0) console.log("no messages");
          return;
        }

        // Server-push follow mode — no polling needed.
        c.onPush = (frame: PushFrame) => {
          if (frame.event !== "msg.new") return;
          const m = frame.data;
          if (m.job_id !== jobId || seen.has(m.id)) return;
          seen.add(m.id);
          print(m);
        };
        unwrap(await c.request("msg.watch", { job_id: jobId, mark_read: true }));
        await new Promise(() => {}); // block until the process is killed
      });
      return;
    }

    case "watch": {
      const { values: watchOpts } = parseArgs({
        args: rest,
        options: {
          all: { type: "boolean" },
          poll: { type: "string" },
        },
        allowPositionals: false,
      });
      let pollMs: number;
      try {
        pollMs = parsePollMs(watchOpts.poll);
      } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
      }
      const showAll = watchOpts.all ?? false;

      await withClient(async (c) => {
        const watchedJobs = new Set<string>();
        const seen = new Set<string>();

        const shortId = (id: string): string => id.slice(0, 8);

        const dim = (s: string): string => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

        const printMsg = (jobId: string, m: Message): void => {
          const ts = new Date(m.created_at).toLocaleTimeString("en-US", { hour12: false });
          const refs = m.refs ? ` refs=${m.refs}` : "";
          console.log(
            `[${shortId(jobId)}] ${ts}  ${formatMessageKind(m.kind)} ${m.from_role} -> ${m.to_role}${refs}`,
          );
          console.log(m.body);
          console.log();
        };

        c.onPush = (frame: PushFrame): void => {
          if (frame.event !== "msg.new") return;
          const m = frame.data;
          if (seen.has(m.id)) return;
          seen.add(m.id);
          printMsg(m.job_id, m);
        };

        const subscribeToJob = async (job: Job): Promise<void> => {
          if (watchedJobs.has(job.id)) return;
          watchedJobs.add(job.id);
          console.log(dim(`+ watching [${shortId(job.id)}] ${job.status.padEnd(11)} ${job.goal}`));
          const listRes = await c.request<{ messages: Message[] }>("msg.list", {
            job_id: job.id,
          });
          if (listRes.ok) {
            for (const m of listRes.result.messages) {
              if (!seen.has(m.id)) {
                seen.add(m.id);
                printMsg(job.id, m);
              }
            }
          }
          await c.request("msg.watch", { job_id: job.id });
        };

        const poll = async (): Promise<void> => {
          const listRes = await c.request<{ jobs: Job[] }>("job.list");
          if (!listRes.ok) return;
          for (const job of listRes.result.jobs) {
            if (!showAll && job.status !== "running") continue;
            await subscribeToJob(job);
          }
        };

        console.log(
          `agvsr watch  ${showAll ? "all jobs" : "running jobs only"}  (poll ${pollMs}ms, Ctrl-C to stop)`,
        );
        await poll();

        if (watchedJobs.size === 0) {
          const tip = showAll
            ? "no jobs found"
            : `no running jobs (use 'agvsr job "..."' to start one, or --all to include finished jobs)`;
          console.log(tip);
        }

        const timer = setInterval(() => {
          void poll();
        }, pollMs);

        await new Promise(() => {}); // block until the process is killed
        clearInterval(timer);
      });
      return;
    }

    case "tell": {
      const jobId = rest[0];
      const body = rest.slice(1).join(" ").trim();
      if (!jobId || !body) {
        console.error('usage: agvsr tell <job-id> "<message>"');
        process.exit(1);
      }
      await withClient(async (c) => {
        unwrap(await c.request("job.tell", { job_id: jobId, body }));
        console.log("message queued to supervisor");
      });
      return;
    }

    case "stop": {
      const jobId = rest[0];
      if (!jobId) {
        console.error("usage: agvsr stop <job-id>");
        process.exit(1);
      }
      await withClient(async (c) => {
        unwrap(await c.request("job.stop", { job_id: jobId }));
        console.log(`job ${jobId} stopped`);
      });
      return;
    }

    case "kill": {
      const jobId = rest[0];
      if (!jobId) {
        console.error("usage: agvsr kill <job-id>");
        process.exit(1);
      }
      await withClient(async (c) => {
        unwrap(await c.request("job.kill", { job_id: jobId }));
        console.log(`job ${jobId} killed`);
      });
      return;
    }

    case "reload":
      await withClient(async (c) => {
        const { roles } = unwrap(await c.request<{ roles: RoleSummary[] }>("reload"));
        console.log("team.yaml reloaded:");
        for (const r of roles) {
          console.log(`  ${r.name.padEnd(16)} ${r.adapter.padEnd(12)} ${r.model}`);
        }
      });
      return;

    case "team":
      await withClient(async (c) => {
        const { roles } = unwrap(await c.request<{ roles: RoleSummary[] }>("team.get"));
        for (const r of roles) {
          console.log(`${r.name.padEnd(16)} ${r.adapter.padEnd(12)} ${r.model}`);
        }
      });
      return;

    case "init": {
      const { values: initOpts } = parseArgs({
        args: rest,
        options: {
          output: { type: "string", short: "o" },
          stdout: { type: "boolean" },
          force: { type: "boolean", short: "f" },
          roles: { type: "string" },
          adapter: { type: "string" },
          model: { type: "string" },
          role: { type: "string", multiple: true },
          "no-comments": { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: false,
        strict: true,
      });

      if (initOpts.help) {
        console.log(`agvsr init — generate a team.yaml without hand editing

Usage: agvsr init [options]

  -o, --output <path>   Write to this file (default: ./team.yaml)
      --stdout          Write to stdout instead of a file
  -f, --force           Overwrite the output file if it already exists
      --roles <list>    Comma-separated role names (default: supervisor,design,implementation,qa)
      --adapter <a>     Default adapter for every role (default: claude-code)
      --model <m>       Default model for every role
      --role <spec>     Per-role override, repeatable. Form: name:adapter:model
      --no-comments     Emit bare YAML without header/hooks comments
  -h, --help            Show this help
`);
        return;
      }

      const { buildTeamYaml, resolveRoleSpecs, DEFAULT_ROLES, BUNDLED_CHARTER_ROLES, InitError } =
        await import("../config/init.ts");

      const VALID_ADAPTERS = ["claude-code", "codex", "agy"] as const;

      const defaultAdapter = (initOpts.adapter ?? "claude-code") as Adapter;
      if (!(VALID_ADAPTERS as readonly string[]).includes(defaultAdapter)) {
        console.error(
          `unknown adapter "${defaultAdapter}". Valid adapters: ${VALID_ADAPTERS.join(", ")}`,
        );
        process.exit(1);
      }

      const roleOverrides = new Map<string, { adapter?: Adapter; model?: string }>();
      for (const rawSpec of initOpts.role ?? []) {
        const parts = rawSpec.split(":");
        if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
          console.error(`invalid --role spec "${rawSpec}": expected name:adapter:model`);
          process.exit(1);
        }
        const [roleName, roleAdapter, roleModel] = parts as [string, string, string];
        if (!(VALID_ADAPTERS as readonly string[]).includes(roleAdapter)) {
          console.error(
            `unknown adapter "${roleAdapter}" in --role "${rawSpec}". Valid adapters: ${VALID_ADAPTERS.join(", ")}`,
          );
          process.exit(1);
        }
        roleOverrides.set(roleName, { adapter: roleAdapter as Adapter, model: roleModel });
      }

      const roleNames = initOpts.roles
        ? initOpts.roles
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean)
        : [...DEFAULT_ROLES];

      if (!roleNames.includes("supervisor")) {
        process.stderr.write(
          'notice: "supervisor" was not in --roles list; prepending it automatically\n',
        );
        roleNames.unshift("supervisor");
      }

      for (const r of roleNames) {
        if (!BUNDLED_CHARTER_ROLES.has(r)) {
          process.stderr.write(
            `warning: role "${r}" has no bundled charter. Add "charter" or "charter_append" in team.yaml before running jobs.\n`,
          );
        }
      }

      const roles = resolveRoleSpecs({
        roleNames,
        defaultAdapter,
        defaultModel: initOpts.model,
        roleOverrides,
      });

      let yaml: string;
      try {
        yaml = buildTeamYaml({ roles, comments: !initOpts["no-comments"] });
      } catch (err) {
        if (err instanceof InitError) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      }

      if (initOpts.stdout) {
        process.stdout.write(yaml);
        return;
      }

      const outputPath = resolve(initOpts.output ?? "team.yaml");

      if (!initOpts.force && existsSync(outputPath)) {
        console.error(`${outputPath} already exists; pass --force to overwrite`);
        process.exit(1);
      }

      writeFileSync(outputPath, yaml, "utf8");
      console.log(`wrote ${outputPath}`);
      return;
    }

    case "doctor": {
      const { values } = parseArgs({
        args: rest,
        options: {
          team: { type: "string" },
          json: { type: "boolean" },
          probe: { type: "boolean" },
        },
        allowPositionals: false,
      });

      const [{ resolveTeamFile }, { runDoctor, defaultDeps, reportHasFailures }] =
        await Promise.all([import("../config/team.ts"), import("../doctor.ts")]);

      const teamFile = resolveTeamFile(values.team);
      const report = await runDoctor(teamFile, defaultDeps(), { probe: values.probe ?? false });
      const hasFails = reportHasFailures(report);

      if (values.json) {
        console.log(
          JSON.stringify(
            {
              team_file: report.teamFile,
              ok: !hasFails,
              groups: report.groups,
            },
            null,
            2,
          ),
        );
      } else {
        for (const group of report.groups) {
          console.log(group.title);
          for (const check of group.checks) {
            const marker = check.level === "ok" ? "✓" : check.level === "warn" ? "~" : "✗";
            console.log(`  ${marker} ${check.label}: ${check.message}`);
          }
          console.log();
        }

        const allChecks = report.groups.flatMap((g) => g.checks);
        const failCount = allChecks.filter((c) => c.level === "fail").length;
        const warnCount = allChecks.filter((c) => c.level === "warn").length;
        const warnSuffix =
          warnCount > 0 ? `, ${warnCount} warning${warnCount !== 1 ? "s" : ""}` : "";

        if (!hasFails) {
          console.log(`all checks passed${warnSuffix}`);
        } else {
          console.log(`${failCount} failure${failCount !== 1 ? "s" : ""}${warnSuffix}`);
        }
      }

      if (hasFails) process.exit(1);
      return;
    }

    case undefined:
    case "-h":
    case "--help":
      console.log(USAGE);
      return;

    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(1);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
