#!/usr/bin/env bun
/**
 * `agvsr` — the thin CLI client (D6/D15). Connects to the daemon over local IPC
 * and issues one request. `agvsr daemon` runs the daemon itself in the foreground.
 */
import { parseArgs } from "node:util";
import { Client } from "../ipc/transport.ts";
import { ipcEndpoint } from "../paths.ts";
import { VERSION } from "../version.ts";
import type { Job, Message, PingResult, PushFrame, Response, RoleSummary } from "../protocol.ts";

const USAGE = `agvsr ${VERSION}

Usage:
  agvsr daemon                      Run the agvsrd daemon in the foreground
  agvsr ping                        Check the daemon is up
  agvsr job "<goal>" [--cwd D]      Submit a job (D is the target repo, default: cwd)
  agvsr status                      List jobs
  agvsr logs <job-id> [-f]          Show audit messages for a job
  agvsr tell <job-id> "<message>"   Send a message to the supervisor of a running job
  agvsr stop <job-id>               Stop a running job (mark failed)
  agvsr reload                      Reload team.yaml without restarting the daemon
  agvsr team                        Show configured roles
`;

function unwrap<T>(res: Response<T>): T {
  if (!res.ok) {
    console.error(`error [${res.error.code}]: ${res.error.message}`);
    process.exit(1);
  }
  return res.result;
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
      const { startDaemon } = await import("../daemon/daemon.ts");
      const daemon = await startDaemon();
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
        options: { cwd: { type: "string" } },
        allowPositionals: true,
      });
      const goal = positionals.join(" ").trim();
      if (!goal) {
        console.error('a goal is required, e.g. agvsr job "add a health endpoint"');
        process.exit(1);
      }
      const cwd = values.cwd ?? process.cwd();
      await withClient(async (c) => {
        const { job } = unwrap(await c.request<{ job: Job }>("job.create", { goal, cwd }));
        console.log(`job ${job.id} created (${job.status})`);
      });
      return;
    }

    case "status":
      await withClient(async (c) => {
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
        console.log(`[${m.created_at}] ${m.kind} ${m.from_role} -> ${m.to_role}${refs}`);
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

await main(process.argv.slice(2));
