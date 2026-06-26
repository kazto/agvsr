/**
 * agvsrd — the central daemon (D6). Owns the store and the IPC server. In Phase 1
 * it handles bookkeeping requests (ping, jobs, team); spawning/driving agents and
 * routing messages arrive in Phase 2/3.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "../ipc/transport.ts";
import { Store } from "./store.ts";
import { loadTeam, type TeamConfig } from "../config/team.ts";
import { ensureConfigDir, ipcEndpoint, storePath } from "../paths.ts";
import { VERSION } from "../version.ts";
import type { Request, Response, RoleSummary } from "../protocol.ts";

function resolveTeam(): TeamConfig | null {
  const candidate = process.env.AGVSR_TEAM ?? join(process.cwd(), "team.yaml");
  if (!existsSync(candidate)) return null;
  return loadTeam(candidate);
}

const ok = (id: string, result: unknown): Response => ({ id, type: "response", ok: true, result });
const err = (id: string, code: string, message: string): Response => ({
  id,
  type: "response",
  ok: false,
  error: { code, message },
});

export interface Daemon {
  endpoint: string;
  close(): Promise<void>;
}

export async function startDaemon(): Promise<Daemon> {
  ensureConfigDir();
  const store = new Store(storePath());
  const team = resolveTeam();
  const endpoint = ipcEndpoint();

  const handle = (req: Request): Response => {
    switch (req.method) {
      case "ping":
        return ok(req.id, { pong: true, version: VERSION });

      case "job.create": {
        const { goal, cwd } = req.params;
        if (!goal?.trim()) return err(req.id, "bad_request", "job goal must not be empty");
        return ok(req.id, { job: store.createJob(goal.trim(), cwd) });
      }

      case "job.list":
        return ok(req.id, { jobs: store.listJobs() });

      case "job.get": {
        const job = store.getJob(req.params.id);
        return job ? ok(req.id, { job }) : err(req.id, "not_found", `no job ${req.params.id}`);
      }

      case "team.get": {
        if (!team) return err(req.id, "no_team", "no team.yaml configured");
        const roles: RoleSummary[] = Object.entries(team.roles).map(([name, r]) => ({
          name,
          adapter: r.adapter,
          model: r.model,
        }));
        return ok(req.id, { roles });
      }

      // Phase 3 will implement actual routing; stubs ack for now.
      case "msg.send":
        return ok(req.id, { queued: true });

      case "msg.escalate":
        return ok(req.id, { queued: true });

      case "job.complete": {
        const job = store.getJob(req.params.job_id);
        if (!job) return err(req.id, "not_found", `no job ${req.params.job_id}`);
        store.setJobStatus(req.params.job_id, "done");
        return ok(req.id, { done: true });
      }

      case "job.fail": {
        const job = store.getJob(req.params.job_id);
        if (!job) return err(req.id, "not_found", `no job ${req.params.job_id}`);
        store.setJobStatus(req.params.job_id, "failed");
        return ok(req.id, { failed: true });
      }

      default:
        return err((req as Request).id, "unknown_method", `unknown method`);
    }
  };

  const server = await serve(endpoint, handle);

  const close = async (): Promise<void> => {
    await server.close();
    store.close();
  };

  return { endpoint, close };
}

// Run directly: `bun run src/daemon/daemon.ts`
if (import.meta.main) {
  const daemon = await startDaemon();
  console.log(`agvsrd ${VERSION} listening on ${daemon.endpoint}`);
  const shutdown = async () => {
    console.log("\nagvsrd shutting down");
    await daemon.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
