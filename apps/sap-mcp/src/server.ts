import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCP_META } from '@prowess/contracts';
import { M, type Logger } from '@prowess/observability';
import {
  AssertionError,
  HEADERS,
  MCP_AUDIENCE,
  hashArguments,
  verifyAssertion,
  type ConfirmationAssertion,
  type PrincipalAssertion,
} from '@prowess/security';
import { z } from 'zod';
import { SapError, type SapGateway } from './sap/model.js';
import type { ToolDefinition, ToolResultPayload } from './tools/types.js';

export interface CallerIdentity {
  principal: PrincipalAssertion;
  userJwt?: string;
  confirmationToken?: string;
}

export interface ServerDeps {
  registry: Map<string, ToolDefinition>;
  gateway: SapGateway;
  secret: string;
  logger: Logger;
  toolTimeoutMs: number;
  /** Confirmation IDs already consumed — each confirmation authorizes exactly one execution. */
  usedConfirmations: Map<string, number>;
}

function errorResult(code: string, message: string, retryable = false): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: message, code, retryable }) }],
    structuredContent: { error: { code, message, retryable } },
  };
}

function okResult(payload: ToolResultPayload): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ...payload.data, mock: payload.source?.mock ?? false }) }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new SapError('UNAVAILABLE', `The SAP request did not complete within ${ms / 1000}s.`, true)), ms);
    }),
  ]);
}

/**
 * Verifies that a write was explicitly confirmed by this user, for this exact
 * tool and these exact arguments, and that the confirmation is unused.
 */
function checkConfirmation(deps: ServerDeps, tool: ToolDefinition, args: unknown, caller: CallerIdentity): string | null {
  if (tool.risk === 'READ') return null;
  let c: ConfirmationAssertion;
  try {
    c = verifyAssertion<ConfirmationAssertion>(caller.confirmationToken, deps.secret, { typ: 'confirmation', aud: MCP_AUDIENCE });
  } catch (err) {
    return `Write operation refused: ${(err as AssertionError).message}. A human confirmation is required.`;
  }
  if (c.sub !== caller.principal.sub) return 'Write operation refused: confirmation belongs to a different user.';
  if (c.tool !== tool.name) return 'Write operation refused: confirmation is for a different action.';
  if (c.env !== caller.principal.env) return 'Write operation refused: confirmation is for a different environment.';
  if (c.args !== hashArguments(args)) return 'Write operation refused: arguments differ from what the user confirmed.';
  const now = Date.now();
  for (const [id, exp] of deps.usedConfirmations) if (exp < now) deps.usedConfirmations.delete(id);
  if (deps.usedConfirmations.has(c.act)) return 'Write operation refused: this confirmation has already been used.';
  deps.usedConfirmations.set(c.act, c.exp * 1_000);
  return null;
}

/** Builds a fresh, stateless MCP server bound to one authenticated caller. */
export function buildMcpServer(deps: ServerDeps, caller: CallerIdentity): McpServer {
  const server = new McpServer({ name: 'prowess-sap-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });

  for (const tool of deps.registry.values()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Writes are strict so the confirmed argument hash cannot be padded; reads strip unknown keys.
        inputSchema: tool.risk === 'READ' ? z.object(tool.input) : z.object(tool.input).strict(),
        annotations: {
          title: tool.title,
          readOnlyHint: tool.risk === 'READ',
          destructiveHint: tool.risk === 'HIGH_IMPACT' || tool.risk === 'BUSINESS_WRITE',
          idempotentHint: tool.risk === 'READ',
          openWorldHint: false,
        },
        _meta: {
          [MCP_META.risk]: tool.risk,
          [MCP_META.domain]: tool.domain,
          [MCP_META.targetSystem]: deps.gateway.systemId,
          [MCP_META.operation]: tool.operation,
          [MCP_META.statusLabel]: tool.statusLabel,
          'prowess/internal': tool.internal ?? false,
        },
      },
      async (args: Record<string, unknown>) => {
        const started = Date.now();
        const log = deps.logger.child({ tool: tool.name, risk: tool.risk, userId: caller.principal.sub, correlationId: caller.principal.cid });
        let outcome = 'success';
        try {
          const refusal = checkConfirmation(deps, tool, args, caller);
          if (refusal) {
            outcome = 'denied';
            log.warn('mcp.write_refused', { reason: refusal });
            return errorResult('CONFIRMATION_REQUIRED', refusal);
          }
          const payload = await withTimeout(
            tool.run(args as never, {
              gateway: deps.gateway,
              sap: { principal: caller.principal, correlationId: caller.principal.cid, ...(caller.userJwt && { userJwt: caller.userJwt }) },
            }),
            deps.toolTimeoutMs,
          );
          return okResult(payload);
        } catch (err) {
          if (err instanceof SapError) {
            outcome = err.code === 'NOT_AUTHORIZED' ? 'sap_denied' : 'sap_error';
            return errorResult(`SAP_${err.code}`, err.message, err.retryable);
          }
          const code = (err as { code?: string }).code;
          if (code === 'INVALID_INPUT') {
            outcome = 'invalid';
            return errorResult('INVALID_INPUT', (err as Error).message);
          }
          outcome = 'error';
          log.error('mcp.tool_failed', { error: err as Error });
          return errorResult('TOOL_FAILED', 'The tool failed unexpectedly.', true);
        } finally {
          const durationMs = Date.now() - started;
          M.toolCalls().inc({ tool: tool.name, outcome });
          M.toolDuration().observe({ tool: tool.name }, durationMs);
          log.info('mcp.tool_call', { outcome, durationMs, system: deps.gateway.systemId, operation: tool.operation });
        }
      },
    );
  }
  return server;
}

/** Extracts and verifies the caller from request headers. Throws AssertionError on failure. */
export function authenticateCaller(headers: Record<string, string | string[] | undefined>, secret: string, sha256: (s: string) => string): CallerIdentity {
  const h = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const principal = verifyAssertion<PrincipalAssertion>(h(HEADERS.principal), secret, { typ: 'principal', aud: MCP_AUDIENCE });
  const userJwt = h(HEADERS.userToken);
  if (principal.utk && (!userJwt || sha256(userJwt) !== principal.utk)) {
    throw new AssertionError('Forwarded user token does not match the principal assertion');
  }
  if (userJwt && !principal.utk) throw new AssertionError('Unbound user token');
  const confirmationToken = h(HEADERS.confirmation);
  return { principal, ...(userJwt && { userJwt }), ...(confirmationToken && { confirmationToken }) };
}
