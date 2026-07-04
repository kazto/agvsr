/**
 * agvsr-mcp: stdio MCP server that exposes agvsr tools to an agent process (D19).
 * Launched by the daemon as an MCP server argument when spawning each agent. Each tool
 * call is relayed over the local IPC socket to the daemon, which handles routing (Phase 3).
 *
 * Environment variables (all required unless noted):
 *   AGVSR_SOCK     - path to daemon IPC socket (falls back to ipcEndpoint())
 *   AGVSR_ROLE     - role name for this agent (e.g. "implementation")
 *   AGVSR_JOB_ID   - current job id
 *   AGVSR_ALLOWED  - comma-separated list of roles this agent may address (optional for
 *                    roles that only escalate, e.g. implementation -> supervisor)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Client } from "../ipc/transport.ts";
import { ipcEndpoint } from "../paths.ts";
import { VERSION } from "../version.ts";
import type { Job, Message, Request } from "../protocol.ts";

const role = process.env.AGVSR_ROLE ?? "unknown";
const jobId = process.env.AGVSR_JOB_ID ?? "";
const allowed = new Set((process.env.AGVSR_ALLOWED ?? "").split(",").filter(Boolean));
const sock = process.env.AGVSR_SOCK ?? ipcEndpoint();

let _client: Client | null = null;

async function getClient(): Promise<Client> {
  if (!_client) {
    _client = await Client.connect(sock);
  }
  return _client;
}

async function relay(method: Request["method"], params: unknown): Promise<void> {
  const c = await getClient();
  const res = await c.request(method, params as never);
  if (!res.ok) throw new Error(res.error.message);
}

async function relayGet<T>(method: Request["method"], params: unknown): Promise<T> {
  const c = await getClient();
  const res = await c.request<T>(method, params as never);
  if (!res.ok) throw new Error(res.error.message);
  return res.result;
}

const server = new McpServer({ name: "agvsr", version: VERSION });

server.registerTool(
  "agvsr_send",
  {
    title: "Send a message to another agvsr role",
    description:
      "Queue a message to another role. Fire-and-forget — the reply arrives as a later turn.",
    inputSchema: {
      to: z.string().describe("Target role name"),
      body: z.string().describe("Message body (natural language)"),
      refs: z.array(z.string()).optional().describe("Workspace paths this message refers to"),
    },
  },
  async ({ to, body, refs }) => {
    if (allowed.size > 0 && !allowed.has(to)) {
      return {
        content: [{ type: "text" as const, text: `rejected: ${to} is not an allowed target` }],
        isError: true,
      };
    }
    await relay("msg.send", { from: role, job_id: jobId, to, body, refs });
    return { content: [{ type: "text" as const, text: `queued -> ${to}` }] };
  },
);

server.registerTool(
  "agvsr_escalate",
  {
    title: "Escalate a blocker to the supervisor",
    description:
      "Raise a blocker, a denied permission, or genuine uncertainty to the supervisor. " +
      "Do not use this to report progress — only when you cannot continue.",
    inputSchema: {
      reason: z.string().describe("What is blocking you and why"),
    },
  },
  async ({ reason }) => {
    await relay("msg.escalate", { from: role, job_id: jobId, reason });
    return { content: [{ type: "text" as const, text: "escalated" }] };
  },
);

server.registerTool(
  "agvsr_status",
  {
    title: "Get current job status and recent audit messages",
    description:
      "Read-only. Returns job metadata (goal, status, branch, cwd) and the most recent " +
      "audit messages so you can orient yourself without relying solely on session memory. " +
      "Use this when you need to re-anchor to the job goal or review what was communicated.",
    inputSchema: {
      last_n: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("How many recent messages to return (default 10, max 50)"),
    },
  },
  async ({ last_n = 10 }) => {
    const { job } = await relayGet<{ job: Job }>("job.get", { id: jobId });
    const { messages } = await relayGet<{ messages: Message[] }>("msg.list", { job_id: jobId });
    const recent = messages.slice(-last_n);
    const lines = [
      `goal: ${job.goal}`,
      `status: ${job.status}`,
      `branch: ${job.branch ?? "(not set)"}`,
      `cwd: ${job.cwd}`,
      ``,
      `messages (last ${recent.length}):`,
      ...recent.map(
        (m) =>
          `  [${m.created_at}] ${m.from_role} → ${m.to_role} (${m.kind}): ${m.body.slice(0, 200)}`,
      ),
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

if (role === "supervisor") {
  server.registerTool(
    "agvsr_complete",
    {
      title: "Declare the job complete",
      description:
        "Accept the work and close the job. Only call this when you have verified the result " +
        "satisfies the original goal. This is final. " +
        `Use job_id="${jobId}" (the full UUID from your '**Current job:**' system-prompt field).`,
      inputSchema: {
        job_id: z.string().describe(`The job id — must be exactly "${jobId}"`),
        result: z.string().describe("Summary of what was accomplished"),
      },
    },
    async ({ job_id, result }) => {
      await relay("job.complete", { job_id, result });
      return { content: [{ type: "text" as const, text: `job ${job_id} completed` }] };
    },
  );

  server.registerTool(
    "agvsr_fail",
    {
      title: "Declare the job failed",
      description:
        "Mark the job as failed and notify the human. Use when the goal cannot be achieved " +
        "with the current team or constraints. " +
        `Use job_id="${jobId}" (the full UUID from your '**Current job:**' system-prompt field).`,
      inputSchema: {
        job_id: z.string().describe(`The job id — must be exactly "${jobId}"`),
        reason: z.string().describe("Why the job cannot be completed"),
      },
    },
    async ({ job_id, reason }) => {
      await relay("job.fail", { job_id, reason });
      return { content: [{ type: "text" as const, text: `job ${job_id} failed` }] };
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
