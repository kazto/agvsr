export { VERSION } from "./version.ts";
export {
  SUPERVISOR,
  allowedTargets,
  TeamConfigError,
  loadTeam,
  parseTeam,
  type Adapter,
  type RoleConfig,
  type TeamConfig,
} from "./config/team.ts";
export {
  startDaemon,
  type Daemon,
  type StartDaemonOptions,
} from "./daemon/daemon.ts";
