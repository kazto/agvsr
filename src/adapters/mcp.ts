import { join } from "node:path";

export const AGVSR_MCP_SERVER = "agvsr";

export interface McpRuntime {
  cwd: string;
  env?: Record<string, string>;
}

export function shimCommand(cwd: string): { command: string; args: string[]; cwd: string } {
  const shimPath = join(import.meta.dir, "..", "mcp", "shim.ts");
  return { command: "bun", args: ["run", shimPath], cwd };
}

function runtimeEnv(runtime: McpRuntime): Record<string, string> {
  return runtime.env ?? {};
}

export function claudeMcpConfig(runtime: McpRuntime): string {
  const shim = shimCommand(runtime.cwd);
  return JSON.stringify({
    mcpServers: {
      [AGVSR_MCP_SERVER]: {
        command: shim.command,
        args: shim.args,
        cwd: shim.cwd,
        env: runtimeEnv(runtime),
      },
    },
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlInlineStringTable(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([key, value]) => `${key} = ${tomlString(value)}`);
  return `{ ${entries.join(", ")} }`;
}

export function codexMcpConfigArgs(runtime: McpRuntime): string[] {
  const shim = shimCommand(runtime.cwd);
  return [
    "-c",
    `mcp_servers.${AGVSR_MCP_SERVER}.command=${tomlString(shim.command)}`,
    "-c",
    `mcp_servers.${AGVSR_MCP_SERVER}.args=${tomlStringArray(shim.args)}`,
    "-c",
    `mcp_servers.${AGVSR_MCP_SERVER}.cwd=${tomlString(shim.cwd)}`,
    "-c",
    `mcp_servers.${AGVSR_MCP_SERVER}.env=${tomlInlineStringTable(runtimeEnv(runtime))}`,
    "-c",
    `mcp_servers.${AGVSR_MCP_SERVER}.enabled=true`,
    "-c",
    `mcp_servers.${AGVSR_MCP_SERVER}.required=true`,
  ];
}

export function agyMcpConfig(runtime: McpRuntime): string {
  const shim = shimCommand(runtime.cwd);
  return JSON.stringify(
    {
      mcpServers: {
        [AGVSR_MCP_SERVER]: {
          command: shim.command,
          args: shim.args,
          cwd: shim.cwd,
          env: runtimeEnv(runtime),
        },
      },
    },
    null,
    2,
  );
}
