import { z } from 'zod';
import { ficoTools } from './fico.js';
import { mmTools } from './mm.js';
import { pmTools } from './pm.js';
import { sharedTools } from './shared.js';
import { defineTool, type Domain, type ToolDefinition } from './types.js';

/**
 * All tool modules. Each domain is self-contained so it can later be
 * extracted into its own MCP service (`prowess-mcp-fico`, …) by deploying this
 * app with `MCP_DOMAINS=fico` — no code changes needed.
 */
const ALL: ToolDefinition[] = [...ficoTools, ...mmTools, ...pmTools, ...sharedTools] as unknown as ToolDefinition[];

export const PREVIEW_TOOL = 'system_previewAction';

export function buildRegistry(domains: ReadonlySet<Domain>): Map<string, ToolDefinition> {
  const tools = ALL.filter((t) => domains.has(t.domain));
  for (const t of tools) {
    if (t.risk !== 'READ' && !t.preview) throw new Error(`Write tool ${t.name} must define a preview`);
    if (!/^[a-z]+_[A-Za-z]+$/.test(t.name)) throw new Error(`Invalid tool name ${t.name}`);
  }
  const registry = new Map(tools.map((t) => [t.name, t]));

  const preview = defineTool({
    name: PREVIEW_TOOL,
    domain: 'system',
    title: 'Preview a write action',
    description: 'Internal: describe the effect of a write tool without executing it. Only callable by the orchestrator.',
    risk: 'READ',
    operation: 'SAP_READ',
    statusLabel: 'Preparing confirmation',
    internal: true,
    input: { tool: z.string().max(64), arguments: z.record(z.string(), z.unknown()) },
    async run({ tool, arguments: rawArgs }, ctx) {
      const target = registry.get(tool);
      if (!target || target.risk === 'READ' || !target.preview) {
        throw Object.assign(new Error(`Tool ${tool} has no preview`), { code: 'INVALID_INPUT' });
      }
      const parsed = z.object(target.input).strict().safeParse(rawArgs);
      if (!parsed.success) {
        throw Object.assign(new Error(`Invalid arguments for ${tool}: ${parsed.error.issues.map((i) => i.message).join('; ')}`), {
          code: 'INVALID_INPUT',
        });
      }
      const p = await target.preview(parsed.data, ctx);
      return { data: { preview: p, normalizedArguments: parsed.data, risk: target.risk, targetSystem: ctx.gateway.systemId, mock: ctx.gateway.mock } };
    },
  });
  registry.set(PREVIEW_TOOL, preview as unknown as ToolDefinition);
  return registry;
}
