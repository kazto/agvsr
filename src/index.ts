export { VERSION } from "./version.ts";
export { Client, serve, type PushFn } from "./ipc/transport.ts";
export {
  SUPERVISOR,
  allowedTargets,
  loadTeam,
  parseTeam,
  type Adapter,
  type RoleConfig,
  type TeamConfig,
} from "./config/team.ts";
export {
  composeCharter,
  driverFor,
  runTurn,
  agyMcpConfig,
  claudeMcpConfig,
  codexMcpConfigArgs,
  type AgentSpec,
  type CliDriver,
  type SessionProbe,
  type SpawnSpec,
  type TurnEvent,
  type TurnOutcome,
  type TurnParser,
  type TurnResult,
} from "./adapters/index.ts";
export {
  startDaemon,
  type Daemon,
  type StartDaemonOptions,
  type TurnDispatch,
  type TurnRunner,
} from "./daemon/daemon.ts";
export {
  fireHook,
  type HookEvent,
} from "./hooks.ts";
export * from "./paths.ts";
export * from "./protocol.ts";
