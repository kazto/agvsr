/**
 * S3 stub daemon: a local UDS server standing in for agvsrd.
 * It receives intercepted tool calls relayed by the agvsr-mcp shim and appends
 * them to a log file the runner inspects. Proves D18 (local IPC) + D19 (the
 * daemon, not the agent's stdout, is where tool calls surface).
 */
import { unlinkSync } from "node:fs";
import { appendFileSync } from "node:fs";

const sock = process.env.AGVSR_SOCK!;
const log = process.env.AGVSR_LOG!;
try {
  unlinkSync(sock);
} catch {}

Bun.listen({
  unix: sock,
  socket: {
    data(_socket, data) {
      const text = new TextDecoder().decode(data);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        appendFileSync(log, line + "\n");
        console.error("[daemon] received:", line);
      }
    },
  },
});
console.error(`[daemon] listening on ${sock}`);
// keep alive
setInterval(() => {}, 1 << 30);
