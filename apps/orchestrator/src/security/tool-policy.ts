import { TOOL_RISKS, riskRank, type DeploymentEnvironment, type ToolRisk } from '@prowess/contracts';

/**
 * Server-side tool policy. The effective risk is the *higher* of what the MCP
 * server declares and any administrator override — a tool can be made
 * stricter by configuration but never laxer than its own declaration.
 */
export class ToolPolicy {
  constructor(private readonly overrides: Record<string, ToolRisk> = {}) {}

  static fromEnv(raw: string | undefined): ToolPolicy {
    if (!raw) return new ToolPolicy();
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [tool, risk] of Object.entries(parsed)) {
      if (!TOOL_RISKS.includes(risk as ToolRisk)) throw new Error(`TOOL_RISK_OVERRIDES: invalid risk "${risk}" for ${tool}`);
    }
    return new ToolPolicy(parsed as Record<string, ToolRisk>);
  }

  effectiveRisk(tool: string, declared: ToolRisk): ToolRisk {
    const override = this.overrides[tool];
    return override && riskRank(override) > riskRank(declared) ? override : declared;
  }

  /**
   * Every non-read operation requires explicit human confirmation. This is
   * intentionally not configurable per environment: the confirmation card
   * is the only path to an SAP write.
   */
  requiresConfirmation(risk: ToolRisk, _env: DeploymentEnvironment): boolean {
    return risk !== 'READ';
  }
}
