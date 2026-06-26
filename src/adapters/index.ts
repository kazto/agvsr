/**
 * Adapter registry. Maps a team adapter id to its CliDriver (D8).
 */
import type { Adapter } from "../config/team.ts";
import type { CliDriver } from "./types.ts";
import { claudeDriver } from "./claude.ts";
import { codexDriver } from "./codex.ts";
import { agyDriver } from "./agy.ts";

const DRIVERS: Record<Adapter, CliDriver> = {
  "claude-code": claudeDriver,
  codex: codexDriver,
  agy: agyDriver,
};

export function driverFor(adapter: Adapter): CliDriver {
  return DRIVERS[adapter];
}

export * from "./types.ts";
export { runTurn } from "./run.ts";
export { composeCharter } from "./charter.ts";
export { agyMcpConfig, claudeMcpConfig, codexMcpConfigArgs } from "./mcp.ts";
