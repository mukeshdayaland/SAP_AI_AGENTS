import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_META, TOOL_RISKS, type DeploymentEnvironment, type ToolRisk, type UserProfile } from '@prowess/contracts';
import { M, propagationHeaders, type Logger } from '@prowess/observability';
import { HEADERS, MCP_AUDIENCE, sha256Hex, signAssertion, type PrincipalAssertion } from '@prowess/security';
import type { McpServerConfig } from '../config/env.js';

/**
 * MCP client side of the orchestrator. Knows which server hosts which tool,
 * authenticates every call with a short-lived principal assertion for the
 * end user, and forwards the user's token for SAP principal propagation.
 */

export interface McpToolInfo {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: ToolRisk;
  domain: string;
  targetSystem: string;
  operation: string;
  statusLabel: string;
  internal: boolean;
  serverId: string;
}

export interface CallerIdentity {
  user: UserProfile;
  agent: string;
  environment: DeploymentEnvironment;
  correlationId: string;
  userToken?: string;
}

export interface ToolCallOutcome {
  ok: boolean;
  structured: Record<string, unknown> | undefined;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  durationMs: number;
}

const SYSTEM_USER: UserProfile = { id: 'prowess-orchestrator', displayName: 'Prowess Orchestrator', tenantId: 'system', roles: [] };
const TOOL_LIST_TTL_MS = 60_000;

export class McpGateway {
  private toolCache?: { at: number; tools: McpToolInfo[] };

  constructor(
    private readonly servers: McpServerConfig[],
    private readonly secret: string,
    private readonly logger: Logger,
    private readonly callTimeoutMs = 30_000,
  ) {}

  private headersFor(identity: CallerIdentity, confirmationToken?: string): Record<string, string> {
    const principal = signAssertion<PrincipalAssertion>(
      {
        typ: 'principal',
        sub: identity.user.id,
        name: identity.user.displayName,
        tenant: identity.user.tenantId,
        roles: identity.user.roles,
        env: identity.environment,
        agent: identity.agent,
        cid: identity.correlationId,
        aud: MCP_AUDIENCE,
        ...(identity.userToken && { utk: sha256Hex(identity.userToken) }),
      },
      this.secret,
      120,
    );
    return {
      ...propagationHeaders(),
      [HEADERS.principal]: principal,
      ...(identity.userToken && { [HEADERS.userToken]: identity.userToken }),
      ...(confirmationToken && { [HEADERS.confirmation]: confirmationToken }),
    };
  }

  private async connect(server: McpServerConfig, headers: Record<string, string>): Promise<Client> {
    const client = new Client({ name: 'prowess-orchestrator', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }), { timeout: 10_000 });
    return client;
  }

  /** Tool catalogue across all MCP servers (cached; metadata is not user-specific). */
  async listTools(environment: DeploymentEnvironment): Promise<McpToolInfo[]> {
    if (this.toolCache && Date.now() - this.toolCache.at < TOOL_LIST_TTL_MS) return this.toolCache.tools;
    const identity: CallerIdentity = { user: SYSTEM_USER, agent: 'system', environment, correlationId: 'tool-discovery' };
    const results = await Promise.allSettled(
      this.servers.map(async (server) => {
        const client = await this.connect(server, this.headersFor(identity));
        try {
          const { tools } = await client.listTools(undefined, { timeout: 10_000 });
          return tools.map((t): McpToolInfo => {
            const meta = (t._meta ?? {}) as Record<string, unknown>;
            const risk = TOOL_RISKS.includes(meta[MCP_META.risk] as ToolRisk) ? (meta[MCP_META.risk] as ToolRisk) : 'HIGH_IMPACT';
            return {
              name: t.name,
              title: t.title ?? t.annotations?.title ?? t.name,
              description: t.description ?? '',
              inputSchema: t.inputSchema as Record<string, unknown>,
              // Unknown risk metadata is treated as the most dangerous class.
              risk,
              domain: String(meta[MCP_META.domain] ?? 'unknown'),
              targetSystem: String(meta[MCP_META.targetSystem] ?? server.id),
              operation: String(meta[MCP_META.operation] ?? 'UNKNOWN'),
              statusLabel: String(meta[MCP_META.statusLabel] ?? `Running ${t.name}`),
              internal: meta['prowess/internal'] === true,
              serverId: server.id,
            };
          });
        } finally {
          await client.close().catch(() => undefined);
        }
      }),
    );
    const tools: McpToolInfo[] = [];
    const seen = new Set<string>();
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.logger.warn('mcp.discovery_failed', { server: this.servers[i]!.id, error: (r.reason as Error).message });
        return;
      }
      for (const t of r.value) {
        if (seen.has(t.name)) {
          this.logger.error('mcp.duplicate_tool', { tool: t.name, server: t.serverId });
          continue;
        }
        seen.add(t.name);
        tools.push(t);
      }
    });
    if (tools.length) this.toolCache = { at: Date.now(), tools };
    return tools;
  }

  /** Opens a per-turn session; connections are reused for all tool calls in the turn. */
  session(identity: CallerIdentity, confirmationToken?: string) {
    const clients = new Map<string, Promise<Client>>();
    const headers = this.headersFor(identity, confirmationToken);
    const get = (serverId: string) => {
      const server = this.servers.find((s) => s.id === serverId);
      if (!server) throw new Error(`Unknown MCP server ${serverId}`);
      let c = clients.get(serverId);
      if (!c) clients.set(serverId, (c = this.connect(server, headers)));
      return c;
    };

    return {
      callTool: async (tool: McpToolInfo, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCallOutcome> => {
        const started = Date.now();
        try {
          const client = await get(tool.serverId);
          const res = await client.callTool({ name: tool.name, arguments: args }, undefined, {
            timeout: this.callTimeoutMs,
            ...(signal && { signal }),
          });
          const durationMs = Date.now() - started;
          M.toolDuration().observe({ tool: tool.name, side: 'client' }, durationMs);
          const structured = res.structuredContent as Record<string, unknown> | undefined;
          if (res.isError) {
            const err = (structured?.error ?? {}) as { code?: string; message?: string; retryable?: boolean };
            return { ok: false, structured, errorCode: err.code ?? 'TOOL_ERROR', errorMessage: err.message ?? 'The tool reported an error.', retryable: err.retryable ?? false, durationMs };
          }
          return { ok: true, structured, durationMs };
        } catch (err) {
          const durationMs = Date.now() - started;
          this.logger.warn('mcp.call_failed', { tool: tool.name, error: (err as Error).message });
          return { ok: false, structured: undefined, errorCode: 'TOOL_UNAVAILABLE', errorMessage: 'The SAP tool service is not reachable.', retryable: true, durationMs };
        }
      },
      close: async () => {
        await Promise.all([...clients.values()].map((p) => p.then((c) => c.close()).catch(() => undefined)));
      },
    };
  }

  async health(): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      this.servers.map(async (s) => {
        try {
          const res = await fetch(new URL('/health', s.url), { signal: AbortSignal.timeout(3_000) });
          return [s.id, res.ok] as const;
        } catch {
          return [s.id, false] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }
}

export type McpSession = ReturnType<McpGateway['session']>;
