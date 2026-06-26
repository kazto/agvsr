/**
 * S3 runner: wires the stub daemon + agvsr-mcp shim, then drives a real claude
 * turn that calls `agvsr_send`. PASS = the daemon's log shows the intercepted
 * call — proving the end-to-end path: agent -> MCP(stdio) -> local UDS -> daemon.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";

const dir = `${import.meta.dir}/s3-mcp`;
const scratch = process.env.SCRATCH ?? "/tmp/claude-1000/-home-kazto-src-agvsr/02012012-1e9b-46e2-a3f5-e7f18d6f4f5f/scratchpad";
const sock = `${scratch}/agvsr-s3.sock`;
const log = `${scratch}/agvsr-s3.log`;
const MODEL = process.env.AGVSR_SPIKE_MODEL ?? "claude-haiku-4-5";

for (const f of [sock, log]) try { rmSync(f); } catch {}

// 1. start stub daemon
const daemon = Bun.spawn(["bun", `${dir}/daemon.ts`], {
  env: { ...process.env, AGVSR_SOCK: sock, AGVSR_LOG: log },
  stdout: "inherit",
  stderr: "inherit",
});

// wait for the socket to appear
for (let i = 0; i < 50 && !existsSync(sock); i++) await Bun.sleep(100);
if (!existsSync(sock)) {
  console.error("daemon socket never appeared");
  daemon.kill();
  process.exit(1);
}

// 2. drive a claude turn that must call the tool
const mcpConfig = JSON.stringify({
  mcpServers: {
    agvsr: { command: "bun", args: [`${dir}/server.ts`], env: { AGVSR_SOCK: sock } },
  },
});

const claude = Bun.spawn(
  [
    "claude",
    "-p",
    "--model",
    MODEL,
    "--mcp-config",
    mcpConfig,
    "--allowedTools",
    "mcp__agvsr__agvsr_send",
    "--output-format",
    "json",
    "Call the agvsr_send tool exactly once with to=\"supervisor\" and body=\"hello-from-spike\". After the tool returns, reply with just: DONE",
  ],
  { stdout: "pipe", stderr: "pipe" },
);

const [out, err, code] = await Promise.all([
  new Response(claude.stdout).text(),
  new Response(claude.stderr).text(),
  claude.exited,
]);

console.log(`\n[claude exit ${code}]`);
try {
  const j = JSON.parse(out);
  console.log("[claude result]", JSON.stringify(j.result ?? "").slice(0, 200));
} catch {
  console.log("[claude raw]", out.slice(0, 400));
}
if (err.trim()) console.log("[claude stderr]", err.slice(0, 400));

// 3. verify interception
await Bun.sleep(300);
const logged = existsSync(log) ? readFileSync(log, "utf8") : "";
console.log("\n[daemon log]\n" + (logged || "(empty)"));

daemon.kill();

const ok = logged.includes("hello-from-spike") && logged.includes('"to":"supervisor"');
console.log("\n--- S3 result ---");
console.log(
  ok
    ? "PASS: agent -> MCP(stdio shim) -> local UDS -> daemon interception works (D18/D19)."
    : "FAIL: the tool call did not reach the daemon.",
);
process.exit(ok ? 0 : 1);
