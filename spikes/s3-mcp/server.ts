/**
 * S3 agvsr-mcp shim: a stdio MCP server that exposes `agvsr_send` and relays
 * each call over the local UDS to the (stub) daemon. The agent (claude/codex/
 * agy) launches THIS as its MCP server; tool calls are captured here and
 * forwarded — independent of the agent's stdout format (key for agy, D8/D19).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import net from "node:net";

const sock = process.env.AGVSR_SOCK!;

function relayToDaemon(payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock, () => {
      c.write(JSON.stringify(payload) + "\n", () => c.end());
    });
    c.on("end", () => resolve());
    c.on("error", reject);
  });
}

const server = new McpServer({ name: "agvsr", version: "0.0.0" });

server.registerTool(
  "agvsr_send",
  {
    title: "Send a message to another agvsr role",
    description: "Queue a message to another role. Fire-and-forget; reply arrives later.",
    inputSchema: { to: z.string(), body: z.string() },
  },
  async ({ to, body }) => {
    await relayToDaemon({ kind: "message", to, body, at: new Date().toISOString() });
    return { content: [{ type: "text", text: `queued -> ${to}` }] };
  },
);

await server.connect(new StdioServerTransport());
