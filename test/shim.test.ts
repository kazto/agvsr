/**
 * Integration test for the agvsr-mcp shim (src/mcp/shim.ts).
 * Spins up a real UDS daemon stub, spawns the shim as a subprocess,
 * sends MCP JSON-RPC calls over stdin, and verifies the stub received
 * the correct relay frames.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

const SHIM = join(import.meta.dir, "../src/mcp/shim.ts");

/** Stub daemon: records frames and returns canned responses. */
function startStub(
  sockPath: string,
  respond: (req: unknown) => unknown,
): Promise<{ received: unknown[]; close(): Promise<void> }> {
  const received: unknown[] = [];
  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            received.push(obj);
            conn.write(JSON.stringify(respond(obj)) + "\n");
          } catch {}
        }
      });
    });
    server.once("error", reject);
    server.listen(sockPath, () => {
      resolve({
        received,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function mcpMessages(tool: string, args: Record<string, unknown>): string {
  return [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
  ]
    .map((m) => JSON.stringify(m))
    .join("\n") + "\n";
}

/**
 * Spawn the shim, write stdin, read stdout lines until the tool call response
 * (id=2) arrives, then kill the process. Returns parsed response objects.
 */
async function callShim(
  sockPath: string,
  env: Record<string, string>,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown[]> {
  const input = mcpMessages(tool, args);
  const proc = Bun.spawn(["bun", "run", SHIM], {
    env: { ...process.env, AGVSR_SOCK: sockPath, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(input);
  proc.stdin.flush();

  const responses: unknown[] = [];
  const decoder = new TextDecoder();
  let buf = "";

  for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as { id?: unknown };
        responses.push(obj);
        if (obj.id === 2) {
          proc.kill();
          return responses;
        }
      } catch {}
    }
  }
  return responses;
}

describe("agvsr-mcp shim", () => {
  it("relays agvsr_send to daemon as msg.send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agvsr-shim-"));
    const sockPath = join(dir, "test.sock");
    const stub = await startStub(sockPath, (req: any) => ({
      id: req.id,
      type: "response",
      ok: true,
      result: { queued: true },
    }));

    try {
      await callShim(sockPath, { AGVSR_ROLE: "implementation", AGVSR_JOB_ID: "job-1", AGVSR_ALLOWED: "supervisor" }, "agvsr_send", { to: "supervisor", body: "hello" });

      const relay = stub.received.find((r: any) => r.method === "msg.send") as any;
      expect(relay).toBeDefined();
      expect(relay.params.from).toBe("implementation");
      expect(relay.params.to).toBe("supervisor");
      expect(relay.params.body).toBe("hello");
      expect(relay.params.job_id).toBe("job-1");
    } finally {
      await stub.close();
      try { unlinkSync(sockPath); } catch {}
    }
  });

  it("relays agvsr_escalate to daemon as msg.escalate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agvsr-shim-"));
    const sockPath = join(dir, "test.sock");
    const stub = await startStub(sockPath, (req: any) => ({
      id: req.id,
      type: "response",
      ok: true,
      result: { queued: true },
    }));

    try {
      await callShim(sockPath, { AGVSR_ROLE: "implementation", AGVSR_JOB_ID: "job-2" }, "agvsr_escalate", { reason: "blocked by permission check" });

      const relay = stub.received.find((r: any) => r.method === "msg.escalate") as any;
      expect(relay).toBeDefined();
      expect(relay.params.reason).toBe("blocked by permission check");
      expect(relay.params.from).toBe("implementation");
    } finally {
      await stub.close();
      try { unlinkSync(sockPath); } catch {}
    }
  });

  it("rejects agvsr_send to a disallowed target without relaying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agvsr-shim-"));
    const sockPath = join(dir, "test.sock");
    const stub = await startStub(sockPath, (req: any) => ({
      id: req.id,
      type: "response",
      ok: true,
      result: { queued: true },
    }));

    try {
      const responses = await callShim(
        sockPath,
        { AGVSR_ROLE: "implementation", AGVSR_JOB_ID: "job-3", AGVSR_ALLOWED: "supervisor" },
        "agvsr_send",
        { to: "qa", body: "bypass!" },
      );

      // No relay to daemon.
      const relayed = stub.received.some((r: any) => r.method === "msg.send");
      expect(relayed).toBe(false);

      // Tool call response should contain "rejected".
      const callResp = responses.find((r: any) => r.id === 2);
      expect(JSON.stringify(callResp)).toContain("rejected");
    } finally {
      await stub.close();
      try { unlinkSync(sockPath); } catch {}
    }
  });

  it("registers agvsr_complete only for supervisor role", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agvsr-shim-"));
    const sockPath = join(dir, "test.sock");
    const stub = await startStub(sockPath, (req: any) => ({
      id: req.id,
      type: "response",
      ok: true,
      result: { done: true },
    }));

    try {
      await callShim(sockPath, { AGVSR_ROLE: "supervisor", AGVSR_JOB_ID: "job-4" }, "agvsr_complete", { job_id: "job-4", result: "all done" });

      const relay = stub.received.find((r: any) => r.method === "job.complete") as any;
      expect(relay).toBeDefined();
      expect(relay.params.job_id).toBe("job-4");
      expect(relay.params.result).toBe("all done");
    } finally {
      await stub.close();
      try { unlinkSync(sockPath); } catch {}
    }
  });
});
