#!/usr/bin/env bun
/**
 * Poll one or more agvsr jobs over the real daemon IPC (not `agvsr status`
 * text parsing) until each reaches a state an operator needs to act on:
 * an approval-gate escalation to the human, or a terminal status. Prints one
 * line per job the moment its state resolves, then exits — so a caller can
 * run this in the background and just read the final output instead of
 * re-deriving polling/parsing logic every time.
 *
 * Cross-platform by design (agvsr targets Windows/macOS/Linux): plain Bun +
 * the project's own IPC client, no bash/awk/grep.
 *
 * Usage:
 *   bun run scripts/watch-jobs.ts <job-id> [job-id ...] [--poll-sec N] [--timeout-sec N]
 *
 * Exit code: 0 if every job resolved (approval/terminal) before the timeout,
 * 1 if the timeout was hit with jobs still unresolved.
 */
import { parseArgs } from "node:util";
import { Client, DaemonNotRunningError } from "../src/ipc/transport.ts";
import { ipcEndpoint } from "../src/paths.ts";
import type { Job, JobRuntime, Message } from "../src/protocol.ts";

type Resolution =
  | { kind: "approval_request"; message: Message }
  | { kind: "terminal"; status: Job["status"] };

function isApprovalRequest(m: Message): boolean {
  // The design-approval gate, the implementation-crash decision gate, and the
  // commit-gate all converge on the same shape: daemon/supervisor addressing
  // the human directly, expecting a reply via `agvsr tell`.
  return m.to_role === "user" && (m.kind === "escalation" || m.kind === "message");
}

async function pollOnce(
  client: Client,
  jobId: string,
): Promise<{ job: Job; runtime: JobRuntime; lastMessage: Message | null }> {
  const jobRes = await client.request<{ job: Job; runtime: JobRuntime }>("job.get", {
    id: jobId,
  });
  if (!jobRes.ok) throw new Error(`job.get ${jobId}: ${jobRes.error.message}`);
  const msgRes = await client.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
  if (!msgRes.ok) throw new Error(`msg.list ${jobId}: ${msgRes.error.message}`);
  const messages = msgRes.result.messages;
  const lastMessage = messages.length > 0 ? messages[messages.length - 1]! : null;
  return { job: jobRes.result.job, runtime: jobRes.result.runtime, lastMessage };
}

function truncate(s: string, max = 240): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "poll-sec": { type: "string", default: "30" },
      "timeout-sec": { type: "string", default: "3600" },
      socket: { type: "string" },
    },
    allowPositionals: true,
  });

  const jobIds = positionals;
  if (jobIds.length === 0) {
    console.error(
      "usage: bun run scripts/watch-jobs.ts <job-id> [job-id ...] [--poll-sec N] [--timeout-sec N]",
    );
    process.exit(2);
  }

  const pollMs = Math.max(1000, Number(values["poll-sec"]) * 1000);
  const deadline = Date.now() + Math.max(1000, Number(values["timeout-sec"]) * 1000);
  const endpoint = values.socket ?? ipcEndpoint();

  let client: Client;
  try {
    client = await Client.connect(endpoint);
  } catch (err) {
    if (err instanceof DaemonNotRunningError) {
      console.error(`daemon not reachable at ${endpoint} — is 'agvsr daemon start' running?`);
      process.exit(2);
    }
    throw err;
  }

  const pending = new Set(jobIds);
  const resolved = new Map<string, Resolution>();
  const seenMessageIds = new Set<string>();

  try {
    while (pending.size > 0 && Date.now() < deadline) {
      const settledThisRound: string[] = [];
      for (const jobId of pending) {
        const { job, lastMessage } = await pollOnce(client, jobId);

        if (job.status !== "running") {
          resolved.set(jobId, { kind: "terminal", status: job.status });
          settledThisRound.push(jobId);
          console.log(`${jobId}\tTERMINAL\t${job.status}`);
          continue;
        }

        if (lastMessage && !seenMessageIds.has(lastMessage.id)) {
          seenMessageIds.add(lastMessage.id);
          if (isApprovalRequest(lastMessage)) {
            resolved.set(jobId, { kind: "approval_request", message: lastMessage });
            settledThisRound.push(jobId);
            console.log(
              `${jobId}\tAPPROVAL_REQUEST\t${lastMessage.from_role} -> ${lastMessage.to_role}\t${truncate(lastMessage.body)}`,
            );
          }
        }
      }
      for (const jobId of settledThisRound) pending.delete(jobId);
      if (pending.size > 0) await Bun.sleep(pollMs);
    }
  } finally {
    client.close();
  }

  if (pending.size > 0) {
    for (const jobId of pending) {
      console.log(`${jobId}\tTIMEOUT\tstill running, no approval request seen`);
    }
    process.exit(1);
  }
}

await main();
