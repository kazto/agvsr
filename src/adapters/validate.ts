import type { Adapter, TeamConfig } from "../config/team.ts";
import { driverFor } from "./index.ts";

export interface ModelValidationFinding {
  role: string;
  adapter: Adapter;
  model: string;
  message: string;
  hint?: string;
}

export function validateTeamModels(team: TeamConfig): ModelValidationFinding[] {
  const findings: ModelValidationFinding[] = [];

  for (const [role, spec] of Object.entries(team.roles)) {
    const driver = driverFor(spec.adapter);
    let warnings: { message: string; hint?: string }[] = [];
    try {
      warnings = driver.validateModel?.(spec.model) ?? [];
    } catch (err) {
      warnings = [
        {
          message: `model validator threw: ${(err as Error).message}`,
        },
      ];
    }

    for (const warning of warnings) {
      findings.push({
        role,
        adapter: spec.adapter,
        model: spec.model,
        message: warning.message,
        ...(warning.hint ? { hint: warning.hint } : {}),
      });
    }
  }

  return findings;
}
